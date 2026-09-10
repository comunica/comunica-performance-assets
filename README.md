# Comunica Performance Assets

This repository contains assets for different benchmarks within comunica projects.

## Assets

- `solidbench-01.tar.gz`: The [SolidBench](https://github.com/SolidBench/SolidBench.js) dataset generate at scale 0.1. Collected via [jbr](https://github.com/rubensworks/jbr.js) using `tar --no-xattrs --exclude=".*" -zcf generated.tar.gz generated/*`. Can be untarred using `curl -s -L https://github.com/comunica/comunica-performance-assets/raw/master/solidbench-01.tar.gz?download= | tar --exclude=".*" -xz`.
- `watdiv-10.zip`: The [WatDiv](https://dsg.uwaterloo.ca/watdiv/) dataset generated at scale 10.
- `watdiv-100.zip`: The [WatDiv](https://dsg.uwaterloo.ca/watdiv/) dataset generated at scale 100 (11 014 612 triples), with the HDT conversion and index included. Collected via [jbr](https://github.com/rubensworks/jbr.js) with `queryCount` 5 and `queryRecurrence` 1, using the same `comunica/watdiv` and `rdfhdt/hdt-cpp` images jbr pins. Can be unzipped using `curl -s -L https://github.com/comunica/comunica-performance-assets/raw/master/watdiv-100.zip?download= > watdiv-100.zip && unzip watdiv-100.zip -d generated/`.
