#!/usr/bin/env node
'use strict';
// Packs the output directory into largerdfbench-sample.tar.gz in the repository root.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { paths, log } = require('../lib/common');

if (path.basename(paths.out) !== 'generated') {
  throw new Error(`The output directory must be named "generated", as the archive is extracted as such, but was ${paths.out}`);
}
const target = path.join(__dirname, '..', '..', 'largerdfbench-sample.tar.gz');
execFileSync('tar', [ '--no-xattrs', '--exclude=.*', '-zcf', target, '-C', path.dirname(paths.out), 'generated' ], { stdio: 'inherit' });
log(`Created ${target}`);
