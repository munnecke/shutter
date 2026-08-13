#!/usr/bin/env node
/* =============================================================================
   Mock bench — stands in for the ESP32 so the frontend can be built and tested
   with no hardware on the desk. Same routes, same shapes, synthetic waveform.

     node tools/dev-server.js            → http://localhost:8080
     node tools/dev-server.js --exposure 8

   Zero dependencies; Node 18+.
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'data');
const LIB = path.join(__dirname, '.dev-library');
const PORT = Number(argOf('--port') || 8080);
const SAMPLE_RATE = 5000;

let exposureMs = Number(argOf('--exposure') || 8.4);   // ~1/119, a tired 1/125
let windowMs = 2000;
let state = 'idle';
let seq = 0;
let samples = [];
let config = {
  useCdn: true,
  sampleRate: SAMPLE_RATE,
  windowMs,
  minWindowMs: 250,
  maxWindowMs: 6000,
  traceColor: '#123f73',
  fftColor: '#9a7014',
  autoscaleY: false
};

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// ------------------------------------------------- synthetic shutter waveform
// Two mechanical transients — first curtain release, second curtain arrival —
// separated by the exposure time, each a decaying ring on a noisy DC baseline.
function synthesize(ms) {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Array(n);
  const openAt = ms * 0.25;
  const closeAt = openAt + exposureMs;

  const burst = (t, t0, amp) => {
    const d = (t - t0) / 1000;
    if (d < 0 || d > 0.09) return 0;
    const env = Math.exp(-d * 190);
    return amp * env * (
      Math.sin(2 * Math.PI * 1120 * d) * 0.7 +
      Math.sin(2 * Math.PI * 640 * d) * 0.4 +
      (Math.random() - 0.5) * 0.5
    );
  };

  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / SAMPLE_RATE;
    let v = 2048;
    v += (Math.random() - 0.5) * 26;                       // room + preamp noise
    v += Math.sin(2 * Math.PI * 60 * t / 1000) * 4;        // a little mains hum
    v += burst(t, openAt, 900);
    v += burst(t, closeAt, 760);
    out[i] = Math.max(0, Math.min(4095, Math.round(v)));
  }
  return out;
}

function runCapture() {
  state = 'capturing';
  setTimeout(() => {
    samples = synthesize(windowMs);
    seq++;
    state = 'ready';
    console.log(`capture #${seq}: ${samples.length} samples, exposure ${exposureMs} ms`);
  }, Math.min(windowMs, 600));
}

// --------------------------------------------------------------------- server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

function json(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/status') {
      return json(res, 200, {
        state, seq, count: samples.length, sampleRate: SAMPLE_RATE,
        windowMs, trigger: 'mock', heap: 254000, rssi: -51,
        time: new Date().toISOString()
      });
    }

    if (p === '/capture' && req.method === 'POST') {
      if (state === 'capturing') return json(res, 409, { error: 'capture in progress' });
      const w = Number(url.searchParams.get('window'));
      if (w) windowMs = Math.max(250, Math.min(6000, w));
      runCapture();
      return json(res, 202, { queued: true });
    }

    if (p === '/data') {
      if (state !== 'ready') return json(res, 409, { error: 'no capture available' });
      return json(res, 200, { seq, sampleRate: SAMPLE_RATE, count: samples.length, samples });
    }

    if (p === '/config' && req.method === 'GET') return json(res, 200, config);

    if (p === '/config' && req.method === 'POST') {
      Object.assign(config, JSON.parse((await readBody(req)).toString() || '{}'));
      if (config.windowMs) windowMs = config.windowMs;
      return json(res, 200, { saved: true });
    }

    if (p === '/save' && req.method === 'POST') {
      await fsp.mkdir(LIB, { recursive: true });
      const name = (url.searchParams.get('name') || 'test').replace(/[^\w-]/g, '-');
      const file = `${Math.floor(Date.now() / 1000)}-${name}.json`;
      await fsp.writeFile(path.join(LIB, file), await readBody(req));
      return json(res, 200, { saved: true });
    }

    if (p === '/library' && req.method === 'GET') {
      await fsp.mkdir(LIB, { recursive: true });
      const files = await fsp.readdir(LIB);
      const out = [];
      for (const f of files) {
        const full = path.join(LIB, f);
        const st = await fsp.stat(full);
        const head = JSON.parse((await fsp.readFile(full, 'utf8')));
        out.push({
          file: '/library/' + f, size: st.size,
          speed: head.speed || '', created: head.created || '', notes: head.notes || ''
        });
      }
      return json(res, 200, out);
    }

    if (p === '/library' && req.method === 'DELETE') {
      const f = path.basename(url.searchParams.get('file') || '');
      await fsp.unlink(path.join(LIB, f));
      return json(res, 200, { deleted: true });
    }

    if (p.startsWith('/library/')) {
      const f = path.basename(p);
      return fs.createReadStream(path.join(LIB, f))
        .on('error', () => json(res, 404, { error: 'not found' }))
        .pipe(res.writeHead(200, { 'Content-Type': 'application/json' }));
    }

    // static files out of data/
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return json(res, 403, { error: 'nope' });
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(buf);

  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'no such endpoint' });
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`mock bench on http://localhost:${PORT}`);
  console.log(`synthetic exposure ${exposureMs} ms — press "Capture now" in the UI`);
  console.log('press the space bar here to fire a capture as if the button were pressed');
});

// Space bar on the terminal stands in for the hardware trigger.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (k) => {
    if (k[0] === 3) process.exit(0);            // ctrl-c
    if (k.toString() === ' ') runCapture();
  });
}
