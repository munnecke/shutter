#!/usr/bin/env node
/* =============================================================================
   Pulls the charting and DSP libraries into data/lib/ so the bench works with
   no internet. Run once before the first filesystem upload:

     node tools/fetch-libs.js
     pio run --target uploadfs

   Then switch off "Load charting libraries from the internet" in Settings.
   Zero dependencies; Node 18+.
   ========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'data', 'lib');

const FILES = [
  ['https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css', 'uPlot.min.css'],
  ['https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js', 'uPlot.iife.min.js'],
  ['https://cdn.jsdelivr.net/npm/dsp.js@1.0.1/dsp.js', 'dsp.js']
];

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  let total = 0;

  for (const [url, name] of FILES) {
    process.stdout.write(`${name} … `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`failed (${res.status})`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(path.join(OUT, name), buf);
    total += buf.length;
    console.log(`${(buf.length / 1024).toFixed(1)} kB`);
  }

  console.log(`\n${(total / 1024).toFixed(1)} kB in data/lib — upload the filesystem to apply.`);
  if (total > 900 * 1024) {
    console.log('That is a lot for the LittleFS partition; check your partition table.');
  }
})();
