#!/usr/bin/env node
'use strict';
// Validates the sample by evaluating each query over the sample and over the full data, with each dataset as a
// separate source, as in a federation. Queries without LIMIT must have exactly the same results over both, and
// queries with a LIMIT must have the same number of results. The results over the sample are stored as the expected
// results of the archive. They are also compared with the published expected results, whose differences are reported.
const fs = require('node:fs');
const path = require('node:path');
const N3 = require('n3');
const { RdfStore } = require('rdf-stores');
const { QueryEngine: QueryEngineRdfJs } = require('@comunica/query-sparql-rdfjs');
const { QueryEngine: QueryEngineHdt } = require('@comunica/query-sparql-hdt');
const { config, paths, termKey, readEvaluationQuery, evaluate, parseQuery, projectedVariables, log } = require('../lib/common');

const datasets = Object.keys(config.datasets);

/** Loads each sampled dataset into its own store. */
async function loadSampleSources() {
  const sources = [];
  for (const ds of datasets) {
    const store = RdfStore.createDefault();
    const parser = new N3.StreamParser({ format: 'N-Triples' });
    fs.createReadStream(path.join(paths.outDatasets, `${ds}.nt`)).pipe(parser);
    await new Promise((resolve, reject) => store.import(parser).on('end', resolve).on('error', reject));
    sources.push(store);
  }
  return sources;
}

function toSrjTerm(term) {
  if (term.termType === 'NamedNode') {
    return { type: 'uri', value: term.value };
  }
  if (term.termType === 'BlankNode') {
    return { type: 'bnode', value: term.value };
  }
  const out = { type: 'literal', value: term.value };
  if (term.language) {
    out['xml:lang'] = term.language;
  } else if (term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
    out.datatype = term.datatype.value;
  }
  return out;
}

function srjToKey(term) {
  if (term.type === 'uri') {
    return `<${term.value}>`;
  }
  if (term.type === 'bnode') {
    return `_:${term.value}`;
  }
  const dt = term.datatype && term.datatype !== 'http://www.w3.org/2001/XMLSchema#string' ? `^^${term.datatype}` : '';
  return `${JSON.stringify(term.value)}${term['xml:lang'] ? `@${term['xml:lang']}` : dt}`;
}

const solutionKey = (s, variables) => JSON.stringify(variables.map(v => s.has(v) ? termKey(s.get(v)) : null));
const srjRowKey = (row, variables) => JSON.stringify(variables.map(v => row[v] ? srjToKey(row[v]) : null));

function countKeys(keys) {
  const counts = new Map();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Number of rows (with multiplicity) that occur more often in a than in b, and a few examples. */
function bagDifference(a, b) {
  let count = 0;
  const examples = [];
  for (const [ key, n ] of a) {
    const extra = n - (b.get(key) ?? 0);
    if (extra > 0) {
      count += extra;
      if (examples.length < 3) {
        examples.push(JSON.parse(key));
      }
    }
  }
  return { count, examples };
}

async function main() {
  const only = process.argv.slice(2);
  const sampleEngine = new QueryEngineRdfJs();
  const fullEngine = new QueryEngineHdt();
  const sampleSources = await loadSampleSources();
  const fullSources = datasets.map(ds => ({ type: 'hdt', value: path.join(paths.hdt, `${ds}.hdt`) }));
  const reportFile = path.join(paths.work, 'validation.json');
  const report = fs.existsSync(reportFile) && only.length > 0 ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};

  for (const id of config.queries.filter(q => only.length === 0 || only.includes(q))) {
    const parsed = parseQuery(id);
    const query = readEvaluationQuery(id);
    const entry = {};
    report[id] = entry;
    try {
      let start = Date.now();
      const sample = await evaluate(sampleEngine, query, { sources: sampleSources }, config.validationTimeoutSeconds);
      entry.sampleSeconds = Math.round((Date.now() - start) / 100) / 10;
      const variables = projectedVariables(parsed, sample);
      entry.results = sample.length;
      const resultsFile = path.join(paths.outResults, `${id}.srj`);

      if (parsed.limit === undefined) {
        start = Date.now();
        const full = await evaluate(fullEngine, query, { sources: fullSources }, config.queryTimeoutSeconds);
        entry.fullSeconds = Math.round((Date.now() - start) / 100) / 10;
        entry.fullResults = full.length;
        const sampleKeys = countKeys(sample.map(s => solutionKey(s, variables)));
        const fullKeys = countKeys(full.map(s => solutionKey(s, variables)));
        entry.onlyInSample = bagDifference(sampleKeys, fullKeys);
        entry.onlyInFull = bagDifference(fullKeys, sampleKeys);
        entry.ok = entry.onlyInSample.count === 0 && entry.onlyInFull.count === 0;

        // The results over the sample, in a stable order, become the expected results of the archive.
        const sorted = sample.map(s => ({ s, key: solutionKey(s, variables) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const bindings = sorted.map(({ s }) => Object.fromEntries(variables.filter(v => s.has(v)).map(v => [ v, toSrjTerm(s.get(v)) ])));
        fs.writeFileSync(resultsFile, JSON.stringify({ head: { vars: variables }, results: { bindings } }));
      } else {
        // The expected result was computed over the full data by the lineage step, and any result of its size is correct.
        const expected = JSON.parse(fs.readFileSync(resultsFile, 'utf8')).results.bindings;
        entry.limit = parsed.limit;
        entry.ok = sample.length === expected.length;
      }

      // Differences with the published expected results, if any, which have defects such as altered literals.
      const publishedFile = path.join(paths.results, config.expectedResults[id] ?? `${id}.srj`);
      if (fs.existsSync(publishedFile)) {
        const published = JSON.parse(fs.readFileSync(publishedFile, 'utf8')).results.bindings;
        const sampleKeys = countKeys(sample.map(s => solutionKey(s, variables)));
        const publishedKeys = countKeys(published.map(row => srjRowKey(row, variables)));
        entry.published = {
          results: published.length,
          onlyInSample: bagDifference(sampleKeys, publishedKeys),
          onlyInPublished: bagDifference(publishedKeys, sampleKeys),
        };
      }
    } catch (error) {
      entry.ok = false;
      entry.error = error.message;
    }
    const published = entry.published ?
      `, published ${entry.published.results} (${entry.published.onlyInSample.count} rows only in sample, ${entry.published.onlyInPublished.count} only in published)` :
      '';
    log(`${id}: ${entry.ok ? 'OK' : 'FAILED'} ${entry.error ?? `${entry.results} results over the sample${entry.fullResults === undefined ? ` (LIMIT ${entry.limit})` : `, ${entry.fullResults} over the full data`}${published}`}`);
  }

  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const manifestFile = path.join(paths.out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.validation = Object.fromEntries(Object.entries(report).map(([ id, e ]) => [ id, {
    ok: e.ok,
    results: e.results,
    ...e.limit === undefined ? { fullResults: e.fullResults } : { limit: e.limit },
    ...e.published ?
        { published: { results: e.published.results, onlyInSample: e.published.onlyInSample.count, onlyInPublished: e.published.onlyInPublished.count } } :
        {},
  } ]));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const failed = Object.entries(report).filter(([ , e ]) => !e.ok).map(([ id ]) => id);
  log(failed.length === 0 ? 'The sample produces the same results as the full data for all queries' : `Failed: ${failed.join(', ')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
