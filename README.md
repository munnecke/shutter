# Acoustic Shutter Diagnostic Bench

A XIAO ESP32S3 captures the sound of a mechanical camera shutter through an
electret mic, and serves the waveform to a browser at **http://shutter.local**
so you can measure the gap between the open and close transients and read the
true exposure time.

```
  mic ──► ADC1_CH0 ──► DMA (adc_continuous, 5 kHz) ──► RAM buffer
  button ──► GPIO2 falling-edge ISR ──► sets trigger flag
  RAM buffer ──► /data (chunked JSON) ──► uPlot + FFT in the browser
                                     └──► /save ──► LittleFS /library
```

**There are two front ends in this repo.** `docs/index.html` is a self-contained
browser version that uses your computer's own microphone and needs no hardware at
all — start there. The ESP32 firmware below is the standalone bench.

---

## Browser version — no hardware

Open `docs/index.html`. That's it: one file, no build step, no CDN, no server.
`getUserMedia` works from the `file://` scheme in Chrome and Firefox, so
double-clicking the file is enough. Safari is stricter and may need a real
origin — serve the directory over `localhost`, or turn on GitHub Pages
(Settings → Pages → main branch, `/docs` folder) and use the HTTPS URL.

Nothing is uploaded. Audio never leaves the page, and saved traces live in the
browser's IndexedDB.

Why it beats the ESP32 on signal quality: your sound card samples at 48 kHz in
floating point against the board's 5 kHz at 12 bits. That's 20.8 µs of timing
resolution instead of 200 µs — about 48 samples across a 1/1000 exposure rather
than five. Browser audio latency is famously bad and completely irrelevant here,
because Δt is measured *within* one continuous stream, so absolute latency
cancels out.

What it does:

- **Threshold auto-trigger with pre-roll.** Arm it, fire the shutter, and the
  page keeps the audio from *before* the trigger. This is the pre-trigger the
  firmware design can't do.
- **Automatic onset detection.** The two curtain events are found and marked for
  you. It works by tracking the rise in high-frequency energy rather than raw
  amplitude, so the closing click is still visible sitting on the opening
  click's ring-down.
- Δt readout, nearest fractional speed, deviation in stops, spectrum over
  whatever span you've zoomed to, library, and WAV export.

Accuracy against synthetic traces, measured in stops of error:

| Nominal | 1/30 | 1/60 | 1/125 | 1/250 | 1/500 |
| --- | --- | --- | --- | --- | --- |
| Auto-placement error | 0.000 | 0.003 | 0.019 | 0.059 | buried |

"Buried" is not a bug. Below roughly 3 ms the closing click arrives inside the
opening click's ring-down, and no amount of signal processing recovers what the
microphone never separated. The page detects this case, says so, and leaves you
to zoom in and place the markers by eye. This is the ceiling of acoustic timing,
not of the implementation.

### Getting a usable signal

- **Turn off the browser's audio processing.** The page requests
  `noiseSuppression`, `autoGainControl`, and `echoCancellation` off, then reports
  in the header whether the browser actually complied. If that chip reads
  anything other than `raw`, the transients are being blunted — noise suppression
  in particular is designed to remove exactly the impulsive clicks you're
  measuring. Desktop Chrome and Firefox honour the request; iOS Safari applies
  system processing you can't fully disable.
- **Don't clip.** The page warns when a capture clips. A clipped edge destroys
  onset timing. Back the mic off rather than turning gain down.
- **Any external mic beats a laptop's built-in.** Position matters more than
  quality: a few centimetres from the shutter, off any surface that rattles.

---

## Hardware

| Signal | XIAO pin | GPIO | Notes |
| --- | --- | --- | --- |
| Mic analog out (AO) | D0 | GPIO1 | ADC1 channel 0, 12-bit, 12 dB attenuation |
| Mic VCC | 3V3 | — | Run the mic at 3.3 V, not 5 V |
| Mic GND | GND | — | |
| Trigger button | D1 | GPIO2 | Other side to GND; internal pull-up, falling edge |

Use the **AO** pin on the LM393 sound module, not DO. DO is a comparator output
and only ever gives you a square wave. If your board only breaks out DO, tap the
electret directly through the module's op-amp output.

The signal sits around mid-scale (≈2048 counts) at rest. If it clips at 0 or
4095, back the module's gain trimmer off.

**ADC1 only.** ADC2 shares hardware with the Wi-Fi radio on the ESP32-S3 and
returns garbage while connected.

---

## Build and flash

The firmware needs **Arduino-ESP32 core 3.x** (ESP-IDF 5.x). The
`esp_adc/adc_continuous.h` driver does not exist in core 2.x, so an older
toolchain will fail at the first include.

### PlatformIO

```bash
cp src/secrets.example.h src/secrets.h   # secrets.h is gitignored
$EDITOR src/secrets.h                    # your 2.4 GHz SSID and password

pio run --target upload                  # firmware
pio run --target uploadfs                # the web app in data/ → LittleFS
pio device monitor                       # watch it join the network
```

`platformio.ini` points at the pioarduino platform fork, which is where core 3.x
actually lives. Check
[its releases page](https://github.com/pioarduino/platform-espressif32/releases)
and bump the tag in the URL if you want something newer.

### Arduino IDE

Install ESP32 board support **3.x**, select *XIAO_ESP32S3*, enable PSRAM, and
add ESPAsyncWebServer, AsyncTCP, and ArduinoJson 7 through the library manager.
Rename `src/main.cpp` to `ShutterBench.ino`, keep `secrets.h` beside it, and
upload `data/` with the LittleFS uploader plugin.

---

## Using it

1. Power the board and wait for `http://shutter.local` on the serial monitor.
   If mDNS does not resolve on your network, use the printed IP.
2. Set the window length (default 2 s), then either press the bench button or
   hit **Capture now**.
3. Fire the shutter inside the capture window.
4. Click once on the trace to drop marker **A** on the first transient, click
   again for marker **B** on the second. The elapsed time appears at the top,
   along with the nearest fractional speed.
5. Type the nominal speed (`1/125`, `125`, `0.5`, `2s` all parse) to see the
   deviation in stops on the meter.
6. Add a note and **Save to bench** to keep the trace in flash.

Drag across the plot to box-zoom, shift-drag to pan, scroll to zoom, double-click
to reset. Keyboard: `c` capture, `r` reset zoom, `Esc` clear markers.

The spectrum recomputes on whatever span the time plot is showing, so zooming
onto a single transient gives you that transient's frequency content rather than
the whole two seconds.

### Reading the trace

A focal-plane shutter gives you two ring-downs: first curtain release, then
second curtain arrival. The gap between the *onsets* is the exposure. A leaf
shutter gives a tighter pair and a shorter ring. Either way, put the markers on
the leading edge of each burst, not the peak — the peak drifts with gain.

Acoustic timing measures the mechanism, not the light. It will not catch curtain
taper or uneven slit width across the frame. For anything past a sanity check,
you want a photodiode across the gate.

---

## Offline operation

By default the browser pulls uPlot and dsp.js from jsDelivr. To make the bench
work with no internet at all:

```bash
node tools/fetch-libs.js     # ~60 kB into data/lib/
pio run --target uploadfs
```

Then turn off **Load charting libraries from the internet** in Settings. The flag
lives in `config.json` on the board, and `app.js` reads it before injecting any
script tags, so nothing is hard-coded.

The FFT has a built-in radix-2 fallback, so the spectrum still works even if
dsp.js is missing entirely.

---

## Developing the UI without hardware

```bash
node tools/dev-server.js          # http://localhost:8080
node tools/dev-server.js --exposure 12.5   # simulate a slow 1/80
```

Zero dependencies, Node 18+. It serves `data/` and implements every endpoint the
firmware does, synthesizing a shutter waveform with two decaying transients on a
noisy baseline. Press the space bar in the terminal to fire a capture as if the
bench button were pressed. Saved traces land in `tools/.dev-library/`.

---

## HTTP API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/status` | `{state, seq, count, sampleRate, windowMs, trigger, heap, rssi, time}` |
| `POST` | `/capture?window=2000` | `202` — queues a software trigger |
| `GET` | `/data` | `{seq, sampleRate, count, samples[]}`, streamed in chunks |
| `GET` | `/config` | current config |
| `POST` | `/config` | writes `config.json` to flash |
| `POST` | `/save?name=1-125` | streams the JSON body to `/library/<ts>-<name>.json` |
| `GET` | `/library` | `[{file, size, speed, created, notes}]` |
| `DELETE` | `/library?file=/library/x.json` | removes a saved capture |
| `GET` | `/library/<file>.json` | the saved capture itself |

`seq` increments on every capture; the client polls `/status` and pulls `/data`
only when it changes.

`/data` is chunked because a 30,000-sample array is roughly 150 kB of JSON —
more than the board can hold in one response buffer. `/save` streams the request
body straight to flash for the same reason, which is why the client writes the
metadata keys *before* the sample array: the firmware reads only the first 320
bytes of each file to build the library listing.

---

## Limits worth knowing

- **5 kHz sampling, 2.5 kHz Nyquist.** Shutter transients have energy well above
  that. You are timing the events, not characterising them acoustically. Raising
  `SAMPLE_RATE_HZ` to 20 kHz works if you shorten the window to match the buffer.
- **No pre-trigger.** Capture begins when the button fires, so press the button
  first, then release the shutter. Adding a pre-roll would mean running the ADC
  continuously into a ring buffer.
- **One client at a time.** `/save` uses a single global `File` handle.
- **Sample buffer** is 6 s × 5 kHz × 2 bytes = 60 kB, allocated from PSRAM when
  available and heap otherwise.
- **Timestamps** come from NTP, so captures saved before the first sync have an
  empty `created` field.

---

## Layout

```
docs/index.html         browser version — self-contained, no hardware
platformio.ini          build config, pinned to Arduino core 3.x
src/main.cpp            firmware: DMA ADC, async server, LittleFS
src/secrets.example.h   copy to src/secrets.h and fill in — the real one is gitignored
data/index.html         the app, uploaded to LittleFS
data/style.css
data/app.js             dependency routing, plots, markers, FFT, library
data/config.json        defaults; overwritten by POST /config
data/lib/               offline copies of uPlot and dsp.js (optional)
tools/dev-server.js     mock bench for UI work
tools/fetch-libs.js     vendors the libraries into data/lib
```
