/* =============================================================================
   Shutter Bench — client
   Boot order: read /config, route charting deps to CDN or flash, then start.
   ========================================================================== */
(() => {
  'use strict';

  const SOURCES = {
    cdn: {
      uplotCss: 'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css',
      uplotJs:  'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js',
      dsp:      'https://cdn.jsdelivr.net/npm/dsp.js@1.0.1/dsp.js'
    },
    local: {
      uplotCss: '/lib/uPlot.min.css',
      uplotJs:  '/lib/uPlot.iife.min.js',
      dsp:      '/lib/dsp.js'
    }
  };

  const DEFAULT_CFG = {
    useCdn: true, sampleRate: 5000, windowMs: 2000,
    minWindowMs: 250, maxWindowMs: 6000,
    traceColor: '#123f73', fftColor: '#9a7014', autoscaleY: false
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ state
  const state = {
    cfg: { ...DEFAULT_CFG },
    xs: null,            // Float64Array, milliseconds
    ys: null,            // Float64Array, raw ADC counts
    seq: -1,
    markers: [],         // up to two x values in ms
    nominalSec: null,
    tPlot: null,
    fPlot: null,
    connected: false
  };

  // =========================================================== dependency load
  function loadCss(href) {
    return new Promise((resolve) => {
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      el.onload = el.onerror = () => resolve();
      document.head.appendChild(el);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(el);
    });
  }

  async function boot() {
    try {
      const r = await fetch('/config', { cache: 'no-store' });
      if (r.ok) Object.assign(state.cfg, await r.json());
    } catch {
      /* offline preview — defaults are fine */
    }

    const src = state.cfg.useCdn ? SOURCES.cdn : SOURCES.local;
    await loadCss(src.uplotCss);
    try {
      await loadScript(src.uplotJs);
    } catch (err) {
      document.body.insertAdjacentHTML('afterbegin',
        `<p class="toast" data-tone="bad" style="position:static;transform:none;margin:12px">
         Charting library missing at ${src.uplotJs}. Turn the internet source back on in
         Settings, or run <code>node tools/fetch-libs.js</code> and re-upload the filesystem.</p>`);
      return;
    }
    try { await loadScript(src.dsp); } catch { /* built-in FFT covers it */ }

    init();
  }

  // ================================================================ utilities
  function toast(msg, tone) {
    const el = $('toast');
    el.textContent = msg;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // "1/125", "125", "1/1000", "0.5", "2s", "2\"" -> seconds
  function parseSpeed(raw) {
    const t = String(raw || '').trim().toLowerCase();
    if (!t) return null;
    const literalSeconds = /[s"]$/.test(t);
    const s = t.replace(/["s]$/, '').replace(/\s+/g, '');
    if (s.includes('/')) {
      const [a, b] = s.split('/').map(Number);
      return (a > 0 && b > 0) ? a / b : null;
    }
    const n = Number(s);
    if (!isFinite(n) || n <= 0) return null;
    if (literalSeconds) return n;
    return n >= 2 ? 1 / n : n;      // bare "125" means 1/125
  }

  function asFraction(seconds) {
    if (!(seconds > 0)) return '—';
    if (seconds >= 1) return seconds.toFixed(2) + ' s';
    return '1/' + Math.round(1 / seconds);
  }

  // ====================================================================== FFT
  // Uses dsp.js when it loaded; otherwise this iterative radix-2 stands in.
  function fallbackSpectrum(signal, n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(signal.subarray(0, n));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    const half = n >> 1;
    const out = new Float64Array(half);
    for (let k = 0; k < half; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / half;
    return out;
  }

  function spectrumOf(signal, n, sampleRate) {
    if (typeof window.FFT === 'function') {
      try {
        const fft = new window.FFT(n, sampleRate);
        fft.forward(signal.subarray(0, n));
        return fft.spectrum;
      } catch { /* fall through */ }
    }
    return fallbackSpectrum(signal, n);
  }

  function applyWindow(buf, n, kind) {
    if (kind === 'none') return;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      buf[i] *= kind === 'hamming'
        ? 0.54 - 0.46 * Math.cos(2 * Math.PI * t)
        : 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
    }
  }

  // ================================================================== plugins
  // Markers: two vertical rules the user drops with a click.
  function markerPlugin() {
    return {
      hooks: {
        draw: (u) => {
          if (!state.markers.length) return;
          const ctx = u.ctx;
          const colors = ['#a81232', '#9a7014'];
          ctx.save();
          ctx.beginPath();
          ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
          ctx.clip();
          state.markers.forEach((mx, i) => {
            const px = Math.round(u.valToPos(mx, 'x', true)) + 0.5;
            ctx.strokeStyle = colors[i];
            ctx.lineWidth = 2;
            ctx.setLineDash(i ? [5, 3] : []);
            ctx.beginPath();
            ctx.moveTo(px, u.bbox.top);
            ctx.lineTo(px, u.bbox.top + u.bbox.height);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = colors[i];
            ctx.fillRect(px - 9, u.bbox.top, 18, 16);
            ctx.fillStyle = '#f5f6f2';
            ctx.font = '600 11px "IBM Plex Mono", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i ? 'B' : 'A', px, u.bbox.top + 8);
          });
          ctx.restore();
        }
      }
    };
  }

  // Scroll to zoom, shift-drag to pan, click (no drag) to drop a marker.
  // uPlot's own drag-select is suppressed while shift is held (see cursor.bind).
  function navPlugin() {
    let detach = null;
    return {
      hooks: {
        ready: (u) => {
          const over = u.over;
          let downX = 0, downY = 0, panning = false, startMin = 0, startMax = 0;

          const onDown = (e) => {
            downX = e.clientX; downY = e.clientY;
            if (!e.shiftKey) return;
            panning = true;
            startMin = u.scales.x.min;
            startMax = u.scales.x.max;
            e.preventDefault();
          };

          const onMove = (e) => {
            if (!panning) return;
            const perPx = (startMax - startMin) / over.clientWidth;
            const dx = (e.clientX - downX) * perPx;
            u.setScale('x', { min: startMin - dx, max: startMax - dx });
          };

          const onUp = (e) => {
            if (panning) { panning = false; return; }
            if (!over.contains(e.target)) return;
            if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
            const rect = over.getBoundingClientRect();
            addMarker(u.posToVal(e.clientX - rect.left, 'x'));
          };

          const onWheel = (e) => {
            e.preventDefault();
            const rect = over.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const { min, max } = u.scales.x;
            const at = min + (max - min) * frac;
            const k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
            u.setScale('x', { min: at - (at - min) * k, max: at + (max - at) * k });
          };

          const onDbl = () => resetZoom();

          over.addEventListener('mousedown', onDown);
          over.addEventListener('wheel', onWheel, { passive: false });
          over.addEventListener('dblclick', onDbl);
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);

          detach = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
        },
        destroy: () => { if (detach) detach(); }
      }
    };
  }

  // ================================================================== plotting
  function plotOpts(el, isFreq) {
    const rect = el.getBoundingClientRect();
    return {
      width: Math.max(240, rect.width),
      height: Math.max(160, rect.height),
      padding: [12, 14, 0, 0],
      legend: { show: true },
      cursor: {
        drag: { x: true, y: !isFreq, uni: null, dist: 4 },
        points: { size: 6 },
        bind: isFreq ? {} : {
          mousedown: (u, targ, handler) => (e) => { if (!e.shiftKey) handler(e); },
          mouseup:   (u, targ, handler) => (e) => { if (!e.shiftKey) handler(e); }
        }
      },
      scales: isFreq
        ? { x: { time: false }, y: { auto: true } }
        : {
            x: { time: false },
            y: state.cfg.autoscaleY ? { auto: true } : { auto: false, range: [0, 4095] }
          },
      axes: [
        {
          label: isFreq ? 'Frequency (Hz)' : 'Time (ms)',
          labelSize: 26,
          font: '11px "IBM Plex Mono", monospace',
          labelFont: '600 11px "Barlow Condensed", sans-serif',
          stroke: '#565c60',
          grid: { stroke: '#d3d6d0', width: 1 },
          ticks: { stroke: '#b4b8b1' }
        },
        {
          label: isFreq ? 'Magnitude' : 'ADC counts',
          labelSize: 30,
          size: 54,
          font: '11px "IBM Plex Mono", monospace',
          labelFont: '600 11px "Barlow Condensed", sans-serif',
          stroke: '#565c60',
          grid: { stroke: '#d3d6d0', width: 1 },
          ticks: { stroke: '#b4b8b1' }
        }
      ],
      series: [
        { label: isFreq ? 'Hz' : 'ms', value: (u, v) => v == null ? '—' : v.toFixed(isFreq ? 0 : 2) },
        {
          label: isFreq ? ($('fftLog').checked ? 'dB' : 'mag') : 'ADC',
          stroke: isFreq ? state.cfg.fftColor : state.cfg.traceColor,
          width: isFreq ? 1.2 : 1,
          points: { show: false },
          value: (u, v) => v == null ? '—' : v.toFixed(isFreq ? 1 : 0)
        }
      ],
      plugins: isFreq ? [] : [markerPlugin(), navPlugin()]
    };
  }

  function buildPlots() {
    const tEl = $('plotTime'), fEl = $('plotFreq');
    state.tPlot = new uPlot(plotOpts(tEl, false), [new Float64Array([0]), new Float64Array([0])], tEl);
    state.fPlot = new uPlot(plotOpts(fEl, true), [new Float64Array([0]), new Float64Array([0])], fEl);

    state.tPlot.hooks.setScale = state.tPlot.hooks.setScale || [];
    // Recompute the spectrum whenever the visible time span changes.
    let raf = 0;
    const onScale = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderSpectrum);
    };
    state.tPlot.hooks.setScale.push(onScale);

    if (state.ro) state.ro.disconnect();
    state.ro = new ResizeObserver(() => {
      state.tPlot.setSize({ width: tEl.clientWidth, height: tEl.clientHeight });
      state.fPlot.setSize({ width: fEl.clientWidth, height: fEl.clientHeight });
    });
    state.ro.observe(tEl);
    state.ro.observe(fEl);
  }

  function rebuildPlots() {
    const data = state.xs ? [state.xs, state.ys] : [new Float64Array([0]), new Float64Array([0])];
    state.tPlot.destroy();
    state.fPlot.destroy();
    buildPlots();
    state.tPlot.setData(data);
    renderSpectrum();
    state.tPlot.redraw();
  }

  function resetZoom() {
    if (!state.xs) return;
    state.tPlot.setScale('x', { min: state.xs[0], max: state.xs[state.xs.length - 1] });
    if (!state.cfg.autoscaleY) state.tPlot.setScale('y', { min: 0, max: 4095 });
  }

  // ============================================================== measurement
  function addMarker(x) {
    if (!state.xs) return;
    if (state.markers.length >= 2) state.markers = [];
    state.markers.push(x);
    state.markers.sort((a, b) => a - b);
    state.tPlot.redraw();
    renderReadout();
  }

  function clearMarkers() {
    state.markers = [];
    state.tPlot.redraw();
    renderReadout();
  }

  function renderReadout() {
    const [a, b] = state.markers;
    $('markA').textContent = a == null ? '—' : a.toFixed(2) + ' ms';
    $('markB').textContent = b == null ? '—' : b.toFixed(2) + ' ms';

    if (a == null || b == null) {
      $('deltaValue').textContent = '—';
      $('deltaFraction').textContent = state.xs
        ? 'click the trace to drop marker A, then marker B'
        : 'waiting for a capture';
      $('needle').hidden = true;
      $('verdict').textContent = 'enter a nominal speed to compare';
      delete $('verdict').dataset.grade;
      return;
    }

    const dt = b - a;
    $('deltaValue').textContent = dt.toFixed(2);
    const measuredSec = dt / 1000;
    $('deltaFraction').innerHTML =
      `measured <strong>${asFraction(measuredSec)}</strong> &nbsp;·&nbsp; ${(1 / measuredSec).toFixed(1)} Hz equivalent`;

    if (!state.nominalSec) {
      $('needle').hidden = true;
      $('verdict').textContent = 'enter a nominal speed to compare';
      delete $('verdict').dataset.grade;
      return;
    }

    const stops = Math.log2(measuredSec / state.nominalSec);
    const clamped = Math.max(-1, Math.min(1, stops));
    const needle = $('needle');
    needle.hidden = false;
    needle.style.left = ((clamped + 1) / 2 * 100) + '%';

    const mag = Math.abs(stops);
    const grade = mag <= 1 / 3 ? 'good' : mag <= 2 / 3 ? 'warn' : 'bad';
    const dir = stops > 0 ? 'slow' : 'fast';
    const v = $('verdict');
    v.dataset.grade = grade;
    v.textContent = mag < 0.02
      ? `on the money against ${asFraction(state.nominalSec)}`
      : `${mag.toFixed(2)} stop${mag.toFixed(2) === '1.00' ? '' : 's'} ${dir} of ${asFraction(state.nominalSec)}`;
  }

  function renderStats() {
    if (!state.ys) { $('peakVal').textContent = '—'; $('noiseVal').textContent = '—'; return; }
    const n = state.ys.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += state.ys[i];
    const mean = sum / n;

    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(state.ys[i] - mean));

    const q = Math.max(1, Math.floor(n * 0.1));
    let acc = 0;
    for (let i = 0; i < q; i++) { const d = state.ys[i] - mean; acc += d * d; }
    const rms = Math.sqrt(acc / q);

    $('peakVal').textContent = peak.toFixed(0) + ' counts';
    $('noiseVal').textContent = rms.toFixed(1) + ' rms';
  }

  // ================================================================= spectrum
  function renderSpectrum() {
    if (!state.xs || !state.fPlot) return;

    const sx = state.tPlot.scales.x;
    const lo = sx.min, hi = sx.max;
    const dtMs = 1000 / state.cfg.sampleRate;
    let i0 = Math.max(0, Math.floor((lo - state.xs[0]) / dtMs));
    let i1 = Math.min(state.ys.length, Math.ceil((hi - state.xs[0]) / dtMs));
    if (i1 - i0 < 32) { i0 = 0; i1 = state.ys.length; }

    const span = i1 - i0;
    let n = 1;
    while (n * 2 <= span && n < 8192) n *= 2;
    if (n < 32) return;

    const buf = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += state.ys[i0 + i];
    mean /= n;
    for (let i = 0; i < n; i++) buf[i] = state.ys[i0 + i] - mean;

    applyWindow(buf, n, $('fftWindow').value);

    const mag = spectrumOf(buf, n, state.cfg.sampleRate);
    const half = Math.min(mag.length, n >> 1);
    const freqs = new Float64Array(half);
    const vals = new Float64Array(half);

    let peak = 1e-12;
    for (let k = 0; k < half; k++) peak = Math.max(peak, mag[k]);

    const asDb = $('fftLog').checked;
    for (let k = 0; k < half; k++) {
      freqs[k] = k * state.cfg.sampleRate / n;
      vals[k] = asDb ? Math.max(-80, 20 * Math.log10((mag[k] || 1e-12) / peak)) : mag[k];
    }

    state.fPlot.series[1].label = asDb ? 'dB' : 'mag';
    state.fPlot.setData([freqs, vals]);
  }

  // =================================================================== network
  async function pollStatus() {
    try {
      const r = await fetch('/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const s = await r.json();
      state.connected = true;
      setLamp(s.state, s.state);
      if (s.state === 'ready' && s.seq !== state.seq) fetchData(s.seq);
    } catch {
      state.connected = false;
      setLamp('offline', 'offline');
    }
  }

  function setLamp(lampState, label) {
    $('lamp').dataset.state = lampState;
    $('lampLabel').textContent = label;
  }

  async function fetchData(seq) {
    try {
      const r = await fetch('/data', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      state.seq = d.seq != null ? d.seq : seq;
      state.cfg.sampleRate = d.sampleRate || state.cfg.sampleRate;

      const n = d.samples.length;
      const dtMs = 1000 / state.cfg.sampleRate;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) { xs[i] = i * dtMs; ys[i] = d.samples[i]; }
      state.xs = xs;
      state.ys = ys;
      state.markers = [];

      state.tPlot.setData([xs, ys]);
      resetZoom();
      renderSpectrum();
      renderStats();
      renderReadout();
      $('saveBtn').disabled = false;
      toast(`Captured ${n} samples over ${(n * dtMs).toFixed(0)} ms`);
    } catch (e) {
      toast('Capture arrived but could not be read: ' + e.message, 'bad');
    }
  }

  async function triggerCapture() {
    const ms = Number($('windowRange').value);
    $('captureBtn').disabled = true;
    try {
      const r = await fetch(`/capture?window=${ms}`, { method: 'POST' });
      if (r.status === 409) toast('A capture is already running.', 'bad');
    } catch {
      toast('The bench did not answer. Check the Wi-Fi link.', 'bad');
    }
    setTimeout(() => { $('captureBtn').disabled = false; }, ms + 400);
  }

  async function saveTrace() {
    if (!state.ys) return;
    const speed = $('speedInput').value.trim();
    const [a, b] = state.markers;
    // Metadata goes first: the board reads only the head of the file to build
    // the library list.
    const head = {
      created: new Date().toISOString(),
      speed: speed || 'unmarked',
      notes: $('notesInput').value.trim(),
      sampleRate: state.cfg.sampleRate,
      count: state.ys.length,
      markerA: a != null ? +a.toFixed(3) : null,
      markerB: b != null ? +b.toFixed(3) : null,
      deltaMs: (a != null && b != null) ? +(b - a).toFixed(3) : null
    };
    const body = JSON.stringify(head).slice(0, -1) +
      ',"samples":[' + Array.from(state.ys, (v) => v | 0).join(',') + ']}';

    $('saveBtn').disabled = true;
    try {
      const r = await fetch('/save?name=' + encodeURIComponent(speed || 'test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      toast(r.ok ? 'Saved to the bench library.' : 'Save failed.', r.ok ? null : 'bad');
      if (r.ok) loadLibrary();
    } catch {
      toast('Save failed — no answer from the bench.', 'bad');
    }
    $('saveBtn').disabled = false;
  }

  async function loadLibrary() {
    const ul = $('libList');
    try {
      const r = await fetch('/library', { cache: 'no-store' });
      const items = await r.json();
      ul.innerHTML = '';
      if (!items.length) {
        ul.innerHTML = '<li class="lib-empty">Nothing saved yet.</li>';
        return;
      }
      items.reverse().forEach((it) => {
        const li = document.createElement('li');

        const open = document.createElement('button');
        open.className = 'lib-open';
        open.innerHTML = `${it.speed || 'unmarked'}
          <small>${it.notes || ''}${it.notes && it.created ? ' · ' : ''}${(it.created || '').replace('T', ' ').replace('Z', '')} · ${Math.round(it.size / 1024)} kB</small>`;
        open.onclick = () => openSaved(it.file);

        const del = document.createElement('button');
        del.className = 'lib-del';
        del.title = 'Delete';
        del.textContent = '\u00d7';
        del.onclick = () => deleteSaved(it.file);

        li.append(open, del);
        ul.appendChild(li);
      });
    } catch {
      ul.innerHTML = '<li class="lib-empty">Library unavailable.</li>';
    }
  }

  async function openSaved(path) {
    try {
      const d = await (await fetch(path, { cache: 'no-store' })).json();
      const n = d.samples.length;
      const dtMs = 1000 / (d.sampleRate || state.cfg.sampleRate);
      const xs = new Float64Array(n), ys = new Float64Array(n);
      for (let i = 0; i < n; i++) { xs[i] = i * dtMs; ys[i] = d.samples[i]; }
      state.xs = xs; state.ys = ys;
      state.markers = [d.markerA, d.markerB].filter((v) => v != null);
      state.cfg.sampleRate = d.sampleRate || state.cfg.sampleRate;
      if (d.speed && d.speed !== 'unmarked') {
        $('speedInput').value = d.speed;
        state.nominalSec = parseSpeed(d.speed);
      }
      $('notesInput').value = d.notes || '';
      state.tPlot.setData([xs, ys]);
      resetZoom();
      renderSpectrum();
      renderStats();
      renderReadout();
      $('saveBtn').disabled = false;
      toast('Loaded ' + (d.speed || path));
    } catch {
      toast('Could not read that saved capture.', 'bad');
    }
  }

  async function deleteSaved(path) {
    try {
      await fetch('/library?file=' + encodeURIComponent(path), { method: 'DELETE' });
      loadLibrary();
    } catch {
      toast('Delete failed.', 'bad');
    }
  }

  // ================================================================== settings
  function openSettings() {
    $('cfgCdn').checked = !!state.cfg.useCdn;
    $('cfgAutoscale').checked = !!state.cfg.autoscaleY;
    $('cfgTrace').value = state.cfg.traceColor;
    $('cfgFft').value = state.cfg.fftColor;
    $('cfgStatus').textContent = '';
    $('settings').showModal();
  }

  async function saveSettings() {
    const next = {
      useCdn: $('cfgCdn').checked,
      autoscaleY: $('cfgAutoscale').checked,
      traceColor: $('cfgTrace').value,
      fftColor: $('cfgFft').value,
      windowMs: Number($('windowRange').value)
    };
    const needsReload = next.useCdn !== state.cfg.useCdn;
    Object.assign(state.cfg, next);
    try {
      const r = await fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      toast(r.ok ? 'Settings saved.' : 'Settings not saved.', r.ok ? null : 'bad');
    } catch {
      toast('Settings not saved — no answer from the bench.', 'bad');
    }
    rebuildPlots();
    renderReadout();
    if (needsReload) setTimeout(() => location.reload(), 700);
  }

  // ====================================================================== init
  function init() {
    buildPlots();

    const range = $('windowRange');
    range.min = state.cfg.minWindowMs;
    range.max = state.cfg.maxWindowMs;
    range.value = state.cfg.windowMs;
    $('windowOut').textContent = state.cfg.windowMs + ' ms';
    range.addEventListener('input', () => {
      $('windowOut').textContent = range.value + ' ms';
    });

    $('captureBtn').addEventListener('click', triggerCapture);
    $('saveBtn').addEventListener('click', saveTrace);
    $('clearMarkers').addEventListener('click', clearMarkers);
    $('resetZoom').addEventListener('click', resetZoom);
    $('refreshLib').addEventListener('click', loadLibrary);
    $('openSettings').addEventListener('click', openSettings);
    $('cfgSave').addEventListener('click', (e) => { e.preventDefault(); $('settings').close(); saveSettings(); });
    $('fftWindow').addEventListener('change', renderSpectrum);
    $('fftLog').addEventListener('change', renderSpectrum);

    $('speedInput').addEventListener('input', (e) => {
      state.nominalSec = parseSpeed(e.target.value);
      renderReadout();
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'c') triggerCapture();
      if (e.key === 'Escape') clearMarkers();
      if (e.key === 'r') resetZoom();
    });

    renderReadout();
    loadLibrary();
    pollStatus();
    setInterval(pollStatus, 900);
  }

  boot();
})();
