'use strict';
const fs = require('node:fs');
const path = require('node:path');
const N3 = require('n3');
const { Parser } = require('sparqljs');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Inputs from Zenodo, intermediate lineage, and the final asset.
const paths = {
  work: path.resolve(process.env.LRB_WORK ?? path.join(ROOT, 'work')),
  out: path.resolve(process.env.LRB_OUT ?? path.join(ROOT, 'generated')),
};
paths.hdt = path.join(paths.work, 'hdt');
paths.queries = path.join(paths.work, 'queries');
paths.results = path.join(paths.work, 'results');
paths.lineage = path.join(paths.work, 'lineage');
paths.outDatasets = path.join(paths.out, 'datasets');
paths.outQueries = path.join(paths.out, 'queries');
paths.outResults = path.join(paths.out, 'results');

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const writer = new N3.Writer({ format: 'N-Triples' });

/** N-Triples line of a triple, used as its identity everywhere. */
function tripleToLine(s, p, o) {
  return writer.quadToString(s, p, o);
}

/** Key of a term, equal for RDF 1.1-equal terms. */
function termKey(term) {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode':
      return `_:${term.value}`;
    case 'Literal':
      return `${JSON.stringify(term.value)}${term.language ? `@${term.language}` : term.datatype.value === XSD_STRING ? '' : `^^${term.datatype.value}`}`;
    default:
      throw new Error(`Unsupported term type ${term.termType}`);
  }
}

/** 32-bit FNV-1a over UTF-16 code units, so sampling decisions are stable across platforms. */
function fnv1a(str) {
  let hash = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministically decide if a key is kept at the given rate. */
function keep(rate, ...keyParts) {
  return rate >= 1 || fnv1a([ config.seed, ...keyParts ].join('\u0000')) < rate * 0x1_0000_0000;
}

function readQuery(id) {
  return fs.readFileSync(path.join(paths.queries, `${id}.sparql`), 'utf8');
}

/** The configured equivalent formulation of a query, used where the engine evaluates the original too slowly. */
function readEvaluationQuery(id) {
  const equivalent = config.equivalentQueries?.[id];
  return equivalent ? fs.readFileSync(path.join(ROOT, equivalent), 'utf8') : readQuery(id);
}

/** Evaluates a query to an array of bindings, failing after the timeout. */
async function evaluate(engine, query, context, timeoutSeconds) {
  const stream = await engine.queryBindings(query, context);
  return await new Promise((resolve, reject) => {
    const solutions = [];
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`Timed out after ${timeoutSeconds} s`));
    }, timeoutSeconds * 1000);
    stream.on('data', bindings => solutions.push(bindings));
    stream.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(solutions);
    });
  });
}

function parseQuery(id) {
  return new Parser().parse(readQuery(id));
}

/** All triple patterns of a query, including those in OPTIONAL and UNION. */
function collectPatterns(node, acc = []) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectPatterns(child, acc);
    }
  } else if (node && typeof node === 'object') {
    if (node.type === 'bgp') {
      acc.push(...node.triples);
    }
    if (node.where) {
      collectPatterns(node.where, acc);
    }
    if (node.patterns) {
      collectPatterns(node.patterns, acc);
    }
  }
  return acc;
}

const isVariable = term => term.termType === 'Variable';
const isOpen = tp => isVariable(tp.subject) && isVariable(tp.predicate) && isVariable(tp.object);

/**
 * Matches triples against the patterns of all queries.
 * Fully open patterns (?s ?p ?o) are excluded, as they match every triple.
 */
class PatternMatcher {
  constructor(queryIds) {
    this.patterns = [];
    this.byPredicate = new Map();
    this.variablePredicate = [];
    const seen = new Set();
    for (const id of queryIds) {
      for (const tp of collectPatterns(parseQuery(id).where)) {
        if (isOpen(tp)) {
          continue;
        }
        const term = t => isVariable(t) ? undefined : t;
        const entry = {
          s: isVariable(tp.subject) ? undefined : termKey(tp.subject),
          p: isVariable(tp.predicate) ? undefined : termKey(tp.predicate),
          o: isVariable(tp.object) ? undefined : termKey(tp.object),
          terms: [ term(tp.subject), term(tp.predicate), term(tp.object) ],
        };
        const key = `${entry.s ?? '?'} ${entry.p ?? '?'} ${entry.o ?? '?'}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entry.key = key;
        entry.index = this.patterns.length;
        this.patterns.push(entry);
        if (entry.p) {
          if (!this.byPredicate.has(entry.p)) {
            this.byPredicate.set(entry.p, []);
          }
          this.byPredicate.get(entry.p).push(entry);
        } else {
          this.variablePredicate.push(entry);
        }
      }
    }
  }

  /**
   * Indexes of the patterns that a triple matches, given the keys of its subject and predicate, and its object term,
   * whose key is only computed when needed, as this is called for every triple of the full data.
   */
  match(s, p, object) {
    const matches = [];
    let o;
    for (const list of [ this.byPredicate.get(p), this.variablePredicate ]) {
      for (const entry of list ?? []) {
        if (entry.s !== undefined && entry.s !== s) {
          continue;
        }
        if (entry.o !== undefined) {
          o ??= termKey(object);
          if (entry.o !== o) {
            continue;
          }
        }
        matches.push(entry.index);
      }
    }
    return matches;
  }
}

/** Projected variable names, taken from the solutions for SELECT *. */
function projectedVariables(parsed, solutions) {
  if (parsed.variables.some(v => v.termType === 'Wildcard')) {
    const names = new Set();
    for (const solution of solutions) {
      for (const variable of solution.keys()) {
        names.add(variable.value);
      }
    }
    return [ ...names ].sort();
  }
  return parsed.variables.map(v => v.value);
}

function writeSortedLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = [ ...lines ].sort();
  const fd = fs.openSync(file, 'w');
  let chunk = '';
  for (const line of sorted) {
    chunk += line;
    if (chunk.length > 1 << 20) {
      fs.writeSync(fd, chunk);
      chunk = '';
    }
  }
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return sorted.length;
}

function readLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0).map(line => `${line}\n`);
}

function log(message) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

module.exports = {
  config,
  paths,
  tripleToLine,
  termKey,
  fnv1a,
  keep,
  readQuery,
  readEvaluationQuery,
  evaluate,
  parseQuery,
  collectPatterns,
  isVariable,
  PatternMatcher,
  projectedVariables,
  writeSortedLines,
  readLines,
  log,
};
