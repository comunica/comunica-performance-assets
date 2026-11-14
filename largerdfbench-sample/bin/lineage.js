#!/usr/bin/env node
'use strict';
// Computes the answer lineage of each query over the full datasets: every triple, per dataset,
// that contributes to a solution. Queries with published expected results get those results bound
// via VALUES, so that also unprojected variables are recovered. Queries without them (the LIMIT
// queries) are evaluated first, and the obtained result is stored as their expected result.
const fs = require('node:fs');
const path = require('node:path');
const hdt = require('hdt');
const { DataFactory } = require('n3');
const { Generator, Parser, Wildcard } = require('sparqljs');
const { QueryEngine } = require('@comunica/query-sparql-hdt');
const {
  config, paths, tripleToLine, termKey, readEvaluationQuery, evaluate, parseQuery, collectPatterns, isVariable,
  projectedVariables, log,
} = require('../lib/common');

const datasets = Object.keys(config.datasets);
const engine = new QueryEngine();
const sources = datasets.map(ds => ({ type: 'hdt', value: path.join(paths.hdt, `${ds}.hdt`) }));

function srjTermToRdf(term) {
  switch (term.type) {
    case 'uri':
      return DataFactory.namedNode(term.value);
    case 'literal':
    case 'typed-literal':
      return DataFactory.literal(term.value, term['xml:lang'] || (term.datatype ? DataFactory.namedNode(term.datatype) : undefined));
    default:
      throw new Error(`Unsupported result term type ${term.type}`);
  }
}

function rdfTermToSrj(term) {
  if (term.termType === 'NamedNode') {
    return { type: 'uri', value: term.value };
  }
  if (term.termType === 'Literal') {
    const out = { type: 'literal', value: term.value };
    if (term.language) {
      out['xml:lang'] = term.language;
    } else if (term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
      out.datatype = term.datatype.value;
    }
    return out;
  }
  throw new Error(`Unsupported binding term type ${term.termType}`);
}

const TERM_TYPE_ORDER = { BlankNode: 1, NamedNode: 2, Literal: 3 };

/** Compares two solutions on ORDER BY conditions, which may only be variables, with SPARQL's ordering of term types. */
function compareOrder(a, b, order) {
  for (const { expression, descending } of order) {
    if (expression.termType !== 'Variable') {
      throw new Error('Only variables are supported in ORDER BY of queries without published results');
    }
    const x = a.get(expression.value);
    const y = b.get(expression.value);
    let result;
    if (!x || !y) {
      result = (x ? 1 : 0) - (y ? 1 : 0);
    } else if (x.termType !== y.termType) {
      result = TERM_TYPE_ORDER[x.termType] - TERM_TYPE_ORDER[y.termType];
    } else {
      const nx = Number(x.value);
      const ny = Number(y.value);
      result = x.termType === 'Literal' && !Number.isNaN(nx) && !Number.isNaN(ny) ?
        nx - ny :
          (x.value < y.value ? -1 : x.value > y.value ? 1 : 0);
    }
    if (result !== 0) {
      return descending ? -result : result;
    }
  }
  return 0;
}

function evaluateFull(query) {
  return evaluate(engine, query, { sources }, config.queryTimeoutSeconds);
}

/**
 * For LIMIT queries whose full result is too expensive: evaluates the query on batches of candidate values for one
 * variable, in a fixed order, until enough distinct projected rows are found. All these rows are actual solutions,
 * and the outcome is deterministic.
 */
async function evaluateOnCandidates(id, text, { variable, predicate, batchSize }, needed, docs) {
  const subjects = new Map();
  for (const doc of Object.values(docs)) {
    const { triples } = await doc.searchTriples(undefined, DataFactory.namedNode(predicate), undefined, { limit: Number.MAX_SAFE_INTEGER });
    for (const { subject } of triples) {
      subjects.set(termKey(subject), subject);
    }
  }
  const ordered = [ ...subjects.keys() ].sort().map(key => subjects.get(key));
  const variables = parseQuery(id).variables.map(v => v.value);
  const solutions = [];
  const distinct = new Set();
  let used = 0;
  for (let i = 0; i < ordered.length && distinct.size < needed; i += batchSize) {
    used = Math.min(ordered.length, i + batchSize);
    const parsed = new Parser().parse(text);
    delete parsed.limit;
    delete parsed.offset;
    parsed.where = [ { type: 'values', values: ordered.slice(i, i + batchSize).map(t => ({ [`?${variable}`]: t })) }, ...parsed.where ];
    for (const solution of await evaluateFull(new Generator().stringify(parsed))) {
      solutions.push(solution);
      distinct.add(JSON.stringify(variables.map(v => solution.has(v) ? termKey(solution.get(v)) : '')));
    }
  }
  log(`${id}: ${distinct.size} distinct rows from the first ${used} of ${ordered.length} candidates for ?${variable}`);
  return solutions;
}

/** Rows of the expected results, as maps from variable name to term, without duplicates. */
function loadExpectedRows(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const unique = new Map();
  for (const row of json.results.bindings) {
    unique.set(JSON.stringify(Object.entries(row).sort()), row);
  }
  return { variables: json.head.vars, rows: [ ...unique.values() ].map(row => Object.fromEntries(Object.entries(row).map(([ v, t ]) => [ v, srjTermToRdf(t) ]))) };
}

/** Variables that are bound in every solution of a group: those of its triple patterns outside OPTIONAL and UNION. */
function mandatoryVariables(patterns, acc = new Set()) {
  for (const pattern of patterns) {
    if (pattern.type === 'bgp') {
      for (const triple of pattern.triples) {
        for (const term of [ triple.subject, triple.predicate, triple.object ]) {
          if (isVariable(term)) {
            acc.add(term.value);
          }
        }
      }
    } else if (pattern.type === 'group') {
      mandatoryVariables(pattern.patterns, acc);
    } else if (pattern.type === 'query' && pattern.variables.some(v => v.termType === 'Wildcard')) {
      // Only subqueries that project all their variables, as others hide some of them.
      mandatoryVariables(pattern.where, acc);
    }
  }
  return acc;
}

const toValues = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([ v, t ]) => [ `?${v}`, t ])));

/**
 * The query with all variables projected, without solution modifiers, joined with the rows via VALUES.
 * The full rows are joined last, so that their values never end up in solutions of an OPTIONAL that does not match them.
 * The rows projected on the variables outside OPTIONAL and UNION are also joined first, which does not change the
 * solutions, but lets the engine start from them.
 */
function lineageQuery(text, rows) {
  const parsed = new Parser().parse(text);
  const mandatory = mandatoryVariables(parsed.where);
  parsed.variables = [ new Wildcard() ];
  delete parsed.distinct;
  delete parsed.reduced;
  delete parsed.limit;
  delete parsed.offset;
  delete parsed.order;
  const first = [ ...new Map(rows
    .map(row => Object.fromEntries(Object.entries(row).filter(([ v ]) => mandatory.has(v))))
    .filter(row => Object.keys(row).length > 0)
    .map(row => [ JSON.stringify(Object.entries(row).map(([ v, t ]) => [ v, termKey(t) ]).sort()), row ])).values() ];
  parsed.where = [
    ...first.length > 0 ? [ { type: 'values', values: toValues(first) } ] : [],
    ...parsed.where,
    { type: 'values', values: toValues(rows) },
  ];
  return new Generator().stringify(parsed);
}

async function main() {
  fs.mkdirSync(paths.lineage, { recursive: true });
  fs.mkdirSync(paths.outResults, { recursive: true });
  const docs = {};
  for (const ds of datasets) {
    docs[ds] = await hdt.fromFile(path.join(paths.hdt, `${ds}.hdt`));
  }
  const only = process.argv.slice(2);
  const statsFile = path.join(paths.lineage, 'stats.json');
  const stats = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : {};
  const writeStats = () => fs.writeFileSync(statsFile, `${JSON.stringify(
    Object.fromEntries(config.queries.filter(id => stats[id]).map(id => [ id, stats[id] ])), null, 2,
  )}\n`);

  for (const id of config.queries) {
    if (only.length > 0 && !only.includes(id)) {
      continue;
    }
    const start = Date.now();
    const expectedFile = path.join(paths.results, config.expectedResults[id] ?? `${id}.srj`);
    let expected;
    if (fs.existsSync(expectedFile)) {
      expected = loadExpectedRows(expectedFile);
    } else {
      // No published result: evaluate the query itself, and keep this result as its expected one.
      // These are the queries with a LIMIT, for which an engine may return any subset of the solutions,
      // so all solutions are computed, and a canonically ordered first subset is taken to remain deterministic.
      log(`${id}: no published result, evaluating the query over the full data`);
      const text = readEvaluationQuery(id);
      const parsed = new Parser().parse(text);
      const { limit, offset = 0, order = [] } = parsed;
      delete parsed.limit;
      delete parsed.offset;
      const candidates = config.limitCandidates?.[id];
      const solutions = candidates ?
        await evaluateOnCandidates(id, text, candidates, offset + limit, docs) :
        await evaluateFull(new Generator().stringify(parsed));
      const variables = projectedVariables(parseQuery(id), solutions);
      const rowKey = s => JSON.stringify(variables.map(v => s.has(v) ? termKey(s.get(v)) : ''));
      let keyed = solutions.map(s => ({ s, key: rowKey(s) }));
      if (parsed.distinct) {
        keyed = [ ...new Map(keyed.map(entry => [ entry.key, entry ])).values() ];
      }
      keyed.sort((a, b) => compareOrder(a.s, b.s, order) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const selected = keyed.slice(offset, limit === undefined ? undefined : offset + limit).map(({ s }) => s);
      const bindings = selected.map(s => Object.fromEntries(variables
        .filter(v => s.has(v)).map(v => [ v, rdfTermToSrj(s.get(v)) ])));
      fs.writeFileSync(path.join(paths.outResults, `${id}.srj`), JSON.stringify({ head: { vars: variables }, results: { bindings } }));
      expected = loadExpectedRows(path.join(paths.outResults, `${id}.srj`));
    }

    const text = readEvaluationQuery(id);
    const solutions = await evaluateFull(lineageQuery(text, expected.rows));

    // Expected rows whose terms differ from the data (e.g. normalised whitespace in literals) match no solution,
    // so those are retried with their literals unbound, which recovers the actual solutions.
    const rowKey = row => JSON.stringify(Object.keys(row).sort().map(v => [ v, termKey(row[v]) ]));
    const project = (s, variables) => Object.fromEntries(variables.filter(v => s.has(v)).map(v => [ v, s.get(v) ]));
    const matched = new Set(solutions.map(s => rowKey(project(s, expected.variables))));
    const unmatched = expected.rows.filter(row => !matched.has(rowKey(row)));
    const relaxed = unmatched
      .map(row => Object.fromEntries(Object.entries(row).filter(([ , t ]) => t.termType !== 'Literal')))
      .filter(row => Object.keys(row).length > 0);
    let stillUnmatched = unmatched.length - relaxed.length;
    if (relaxed.length > 0) {
      const retried = await evaluateFull(lineageQuery(text, relaxed));
      solutions.push(...retried);
      const recovered = new Set(retried.flatMap(s => relaxed
        .filter(row => rowKey(project(s, Object.keys(row))) === rowKey(row)).map(rowKey)));
      stillUnmatched += relaxed.filter(row => !recovered.has(rowKey(row))).length;
    }
    if (unmatched.length > 0) {
      log(`${id}: ${unmatched.length} expected rows match no solution, ${relaxed.length} retried with their literals unbound, ${stillUnmatched} still without solution`);
    }

    const patterns = collectPatterns(new Parser().parse(text).where);
    const perDataset = Object.fromEntries(datasets.map(ds => [ ds, new Set() ]));
    for (const solution of solutions) {
      for (const tp of patterns) {
        const terms = [ tp.subject, tp.predicate, tp.object ].map(t => isVariable(t) ? solution.get(t.value) : t);
        if (terms.some(t => t === undefined)) {
          continue;
        }
        for (const ds of datasets) {
          if ((await docs[ds].countTriples(...terms)).totalCount > 0) {
            perDataset[ds].add(tripleToLine(...terms));
          }
        }
      }
    }
    stats[id] = {
      expectedRows: expected.rows.length,
      unmatchedRows: unmatched.map(row => Object.fromEntries(Object.entries(row).map(([ v, t ]) => [ v, termKey(t) ]))),
      stillUnmatchedRows: stillUnmatched,
      solutions: solutions.length,
      triples: Object.fromEntries(datasets.filter(ds => perDataset[ds].size > 0).map(ds => [ ds, perDataset[ds].size ])),
      seconds: Math.round((Date.now() - start) / 1000),
    };
    for (const ds of datasets) {
      fs.writeFileSync(path.join(paths.lineage, `${id}.${ds}.nt`), [ ...perDataset[ds] ].join(''));
    }
    writeStats();
    log(`${id}: ${JSON.stringify(stats[id])}`);
  }
  log('Done');
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
