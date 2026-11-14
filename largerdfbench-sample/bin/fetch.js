#!/usr/bin/env node
'use strict';
// Downloads the required HDT files, queries, and expected results from the Zenodo record.
// Only the needed zip entries are fetched, via HTTP range requests, so that the 7.8 GB HDT archive is not downloaded in full.
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { config, paths, log } = require('../lib/common');

// Zenodo refuses requests with the default user agent of Node.js.
const HEADERS = { 'User-Agent': 'comunica-performance-assets/largerdfbench-sample' };

class HttpRandomAccessReader extends yauzl.RandomAccessReader {
  constructor(url) {
    super();
    this.url = url;
  }

  _readStreamForRange(start, end) {
    const stream = new PassThrough();
    fetch(this.url, { headers: { ...HEADERS, Range: `bytes=${start}-${end - 1}` } })
      .then((response) => {
        if (response.status !== 206) {
          throw new Error(`Expected a partial response for ${this.url}, got ${response.status}`);
        }
        Readable.fromWeb(response.body).pipe(stream);
      })
      .catch(error => stream.destroy(error));
    return stream;
  }
}

async function openRemoteZip(name) {
  const url = `https://zenodo.org/api/records/${config.zenodo.record}/files/${name}/content`;
  const head = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-0' } });
  const size = Number(head.headers.get('content-range')?.split('/')[1]);
  await head.body?.cancel();
  if (!size) {
    throw new Error(`Could not determine the size of ${url}`);
  }
  // Ranges are requested on the final URL, after redirects.
  const reader = new HttpRandomAccessReader(head.url);
  return await new Promise((resolve, reject) => yauzl.fromRandomAccessReader(reader, size, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip)));
}

/** Extracts the zip entries whose basename is accepted by the filter into the target directory. */
async function extract(name, filter, target) {
  const zip = await openRemoteZip(name);
  fs.mkdirSync(target, { recursive: true });
  const entries = await new Promise((resolve, reject) => {
    const found = [];
    zip.on('entry', (entry) => {
      found.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(found));
    zip.on('error', reject);
    zip.readEntry();
  });
  for (const entry of entries) {
    const base = path.basename(entry.fileName);
    if (entry.fileName.endsWith('/') || !filter(base)) {
      continue;
    }
    const file = path.join(target, base);
    if (fs.existsSync(file) && fs.statSync(file).size === entry.uncompressedSize) {
      log(`${base}: already present`);
      continue;
    }
    log(`${base}: downloading ${Math.round(entry.compressedSize / 1024 / 1024)} MiB`);
    const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, s) => error ? reject(error) : resolve(s)));
    // Yauzl verifies the CRC-32 of each entry while it is read.
    await pipeline(stream, fs.createWriteStream(`${file}.part`));
    fs.renameSync(`${file}.part`, file);
  }
  zip.close();
}

async function main() {
  // Optionally, only the given datasets are fetched.
  const datasets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(config.datasets);
  await extract(config.zenodo.archives.hdt, base => datasets.some(ds => base === `${ds}.hdt` || base === `${ds}.hdt.index.v1-1`), paths.hdt);
  await extract(config.zenodo.archives.queries, base => base.endsWith('.sparql'), paths.queries);
  await extract(config.zenodo.archives.results, base => base.endsWith('.srj'), paths.results);
  log('Done');
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
