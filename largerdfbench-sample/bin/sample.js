#!/usr/bin/env node
'use strict';
// Builds the sampled datasets. Per dataset, subjects are sampled at its subjectRate. Of a sampled subject,
// all triples that match a query pattern are kept, and other triples are kept at irrelevantRate.
// Finally, the answer lineage of all queries is added, so that query results equal those over the full data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const hdt = require('hdt');
const N3 = require('n3');
const {
  config, paths, tripleToLine, termKey, keep, PatternMatcher, writeSortedLines, readLines, log,
} = require('../lib/common');

const PAGE = 500_000;

async function main() {
  const matcher = new PatternMatcher(config.queries);
  const patternCounts = matcher.patterns.map(() => ({}));
  const manifest = {
    source: `https://zenodo.org/records/${config.zenodo.record}`,
    seed: config.seed,
    irrelevantRate: config.irrelevantRate,
    queries: config.queries,
    datasets: {},
  };
  fs.mkdirSync(paths.outDatasets, { recursive: true });

  for (const [ ds, { subjectRate }] of Object.entries(config.datasets)) {
    const doc = await hdt.fromFile(path.join(paths.hdt, `${ds}.hdt`));
    const total = (await doc.countTriples()).totalCount;
    const lines = new Set();
    const stats = { subjectRate, triples: total, subjects: 0, sampledSubjects: 0, matching: 0, other: 0, lineage: 0 };
    const count = (s, p, o, ds) => {
      for (const index of matcher.match(s, p, o)) {
        patternCounts[index][ds] = (patternCounts[index][ds] ?? 0) + 1;
      }
    };
    let current;
    let sampled = false;
    for (let offset = 0; offset < total; offset += PAGE) {
      const { triples } = await doc.searchTriples(undefined, undefined, undefined, { offset, limit: PAGE });
      for (const { subject, predicate, object } of triples) {
        const s = termKey(subject);
        if (s !== current) {
          current = s;
          stats.subjects++;
          sampled = keep(subjectRate, ds, s);
          if (sampled) {
            stats.sampledSubjects++;
          }
          if (subject.termType === 'BlankNode' && subjectRate < 1) {
            throw new Error(`${ds} has blank node subjects, which is only supported with a subjectRate of 1`);
          }
        }
        if (!sampled) {
          continue;
        }
        const line = tripleToLine(subject, predicate, object);
        const p = termKey(predicate);
        const o = termKey(object);
        if (matcher.match(s, p, o).length > 0) {
          lines.add(line);
          stats.matching++;
          count(s, p, o, ds);
        } else if (keep(config.irrelevantRate, 'other', line)) {
          lines.add(line);
          stats.other++;
        }
      }
      if (offset > 0 && offset % (20 * PAGE) === 0) {
        log(`${ds}: ${offset} / ${total}`);
      }
    }

    // Add the lineage triples that were not sampled.
    const parser = new N3.Parser({ format: 'N-Triples' });
    for (const file of fs.readdirSync(paths.lineage).filter(f => f.endsWith(`.${ds}.nt`))) {
      for (const line of readLines(path.join(paths.lineage, file))) {
        if (!lines.has(line)) {
          lines.add(line);
          stats.lineage++;
          const [ q ] = parser.parse(line);
          count(termKey(q.subject), termKey(q.predicate), termKey(q.object), ds);
        }
      }
    }

    const file = path.join(paths.outDatasets, `${ds}.nt`);
    stats.sampleTriples = writeSortedLines(file, lines);
    stats.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    manifest.datasets[ds] = stats;
    log(`${ds}: ${JSON.stringify(stats)}`);
  }

  manifest.sampleTriples = Object.values(manifest.datasets).reduce((sum, s) => sum + s.sampleTriples, 0);
  manifest.patterns = matcher.patterns
    .map((p, i) => ({ pattern: p.key, matches: patternCounts[i] }))
    .sort((a, b) => Math.max(0, ...Object.values(b.matches)) - Math.max(0, ...Object.values(a.matches)));
  const lineageStats = path.join(paths.lineage, 'stats.json');
  if (fs.existsSync(lineageStats)) {
    // Only the number of expected rows that match no solution, the rows themselves are in the lineage stats.
    manifest.lineage = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(lineageStats, 'utf8')))
      .map(([ id, s ]) => [ id, { ...s, unmatchedRows: s.unmatchedRows.length } ]));
  }

  fs.mkdirSync(paths.outQueries, { recursive: true });
  for (const id of config.queries) {
    fs.copyFileSync(path.join(paths.queries, `${id}.sparql`), path.join(paths.outQueries, `${id}.sparql`));
  }
  fs.writeFileSync(path.join(paths.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`Sample has ${manifest.sampleTriples} triples`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
