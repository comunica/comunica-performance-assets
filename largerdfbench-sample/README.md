# LargeRDFBench sample

This directory builds `largerdfbench-sample.tar.gz`: a reduced version of the FedBench part of [LargeRDFBench](https://github.com/dice-group/LargeRDFBench), small enough for federated query benchmarks in CI, over which all queries produce the same results as over the full data.

It is built from the [LargeRDFBench Interoperable Edition](https://zenodo.org/records/22140177) on Zenodo, which repairs the original data dumps into valid RDF.

## Scope

The sample covers the 9 datasets of LargeRDFBench that originate from FedBench (ChEBI, DBpedia subset, DrugBank, GeoNames, Jamendo, KEGG, LinkedMDB, New York Times, Semantic Web Dog Food), and the 23 queries that only use those datasets: the simple queries S1-S14 and the complex queries C1-C9.
The other queries (C10, and the large data queries B1-B8) need the LinkedTCGA and Affymetrix datasets, which together have 839 million triples, so they are not included.

## Method

The 9 full datasets have 165 million triples, of which 50 million match at least one triple pattern of the 23 queries (37.7 million of those in GeoNames alone), so the sample has to be smaller than just the part that is relevant to the queries.
Each dataset of the sample is the union of:

1. **Sampled subjects**: subjects are sampled at the `subjectRate` of their dataset (in `config.json`), based on a seeded hash, so that the sample is deterministic. All triples of a sampled subject that match a triple pattern of a query are kept. Its other triples are kept at the `irrelevantRate`. These other triples never influence query results or the cardinalities of query patterns, but they are partially kept so that the datasets are not reduced to exactly what the queries need, which matters for open patterns such as `?s ?p ?o` and for dataset-level statistics.
2. **Answer lineage**: all triples of the full data that contribute to a result of a query, which make the queries produce exactly the same results as over the full data.
   For the queries with published expected results, those results are bound into the query with `VALUES` to recover the full solutions, including the values of unprojected variables. Expected rows that match no solution, because of defects in the published results (see below), are retried with their literals unbound.
   The queries without published results (C1, C4, C5 and C9) have a `LIMIT`, for which any subset of the right size is a correct result. To stay deterministic, they are evaluated over the full data without `LIMIT`, after which the solutions are sorted on their `ORDER BY` and their values, and the first ones are taken. As C4 is too slow to evaluate this way, it is evaluated on batches of the subjects with a `geonames:population`, in a fixed order, until it has enough distinct results (`limitCandidates` in `config.json`).

The small datasets keep all their subjects, and the large ones (GeoNames, DBpedia, LinkedMDB) are sampled so that no query pattern has more than 170 000 matches, which keeps `COUNT` queries for cardinality estimation fast.

As subjects are sampled independently per dataset, joins across datasets lose more of their results that do not contribute to a query result than the individual patterns lose matches.
The sample is therefore suitable for tracking the performance of federated query engines over time, but its query times are not comparable to published LargeRDFBench results.

C2 and C5 join two parts of the query only through a `FILTER` on equal values, which the Comunica versions used here evaluate as a cross product, taking minutes even over the sample. Wherever this build evaluates them, it uses the equivalent formulations in `equivalent-queries/`, which join on a shared variable instead. The queries in the archive are unchanged.

## Validation

The build evaluates all queries over the sample and over the full data, with each dataset as a separate source, as in a federation, so that matches in multiple datasets are not merged. The queries without `LIMIT` must have exactly the same results over both, including duplicates, and the queries with a `LIMIT` must have the same number of results.

The results over the sample are stored as the expected results of the archive, as the published expected results have defects that make them differ from the data:

- S1: a literal with a newline in the data has a space instead.
- S6: a literal with a `ü` in the data has a replacement character (U+FFFD) instead.
- S8, S14: literals with replacement characters in the data have `?` instead.
- C7, C8: numeric literals have different datatypes than in the data, such as `xsd:decimal` instead of `xsd:double`. C7 also has 112 results, while the full data has 134.

The number of differing rows per query is listed under `validation` in `manifest.json`.

## Output

The archive contains:

- `generated/datasets/<dataset>.nt`: the sampled datasets, as sorted N-Triples, one file per federation member.
- `generated/queries/<query>.sparql`: the 23 queries, unchanged.
- `generated/results/<query>.srj`: the expected results over the sample, in the SPARQL 1.1 Query Results JSON Format. For queries with a `LIMIT`, any result with the same number of results is correct.
- `generated/manifest.json`: the build parameters, the size of each dataset with its SHA-256 checksum, the number of matches of each query pattern per dataset, the lineage of each query, and the validation results.

## Building

This requires Node.js 22 or higher, the build tools for the native [`hdt`](https://www.npmjs.com/package/hdt) package (a C++ compiler and Python), about 5 GB of disk space, and 8 GB of memory. It takes about half an hour.

```bash
npm ci
npm run build
```

This runs the following steps, which can also be run separately:

1. `npm run fetch`: downloads the HDT files of the 9 datasets (about 1.6 GB), the queries, and the expected results from Zenodo into `work/`. Only the needed entries of the Zenodo archives are downloaded, using HTTP range requests.
2. `npm run lineage`: computes the answer lineage of each query over the full data into `work/lineage/`.
3. `npm run sample`: samples the datasets, and writes them with the queries and the manifest into `generated/`.
4. `npm run validate`: validates the sample, and writes the expected results into `generated/results/`.
5. `npm run package`: creates `../largerdfbench-sample.tar.gz`.

The `LRB_WORK` and `LRB_OUT` environment variables change the `work/` and `generated/` directories.
Rebuilding with the same `config.json` produces the same datasets, which can be verified with the checksums in the manifest.
