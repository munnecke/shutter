# Shutter Bench — notes for Claude Code

Acoustic camera-shutter timer. XIAO ESP32S3 firmware in `src/`, a vanilla-JS web
app in `data/` that gets uploaded to LittleFS, and Node dev tooling in `tools/`.

## Commands

```bash
node tools/dev-server.js       # mock bench + UI at localhost:8080, no hardware needed
node tools/fetch-libs.js       # vendor uPlot + dsp.js into data/lib for offline mode
pio run                        # compile firmware
pio run --target upload        # flash firmware
pio run --target uploadfs      # flash the data/ directory to LittleFS
pio device monitor             # serial, 115200
```

There is no test suite. Verify frontend changes against `tools/dev-server.js`,
which implements every endpoint the firmware does and synthesizes a shutter
waveform.

## Constraints that bite

- **Arduino-ESP32 core 3.x only.** `esp_adc/adc_continuous.h` does not exist in
  core 2.x. `platformio.ini` pins the pioarduino platform fork for this reason.
  Do not "fix" a build error by falling back to the legacy I2S-ADC API — it does
  not exist on the S3.
- **ADC1 only.** ADC2 is unusable while Wi-Fi is up.
- **Never build a full response body in RAM.** A 30k-sample capture is ~150 kB of
  JSON. `/data` uses `beginChunkedResponse`; `/save` streams the request body
  straight to flash. Keep it that way when adding endpoints.
- **`/save` metadata ordering is load-bearing.** The firmware reads only the
  first 320 bytes of a saved file to build the library listing, so the client
  must write metadata keys before the `samples` array.
- **Register explicit API routes before `serveStatic("/")`** in `routes()`, or
  the static handler shadows them.
- **Capture runs in `loop()`, never in an async web callback.** The ISR only sets
  a flag.
- **`src/secrets.h` is gitignored.** Never commit real credentials; edit
  `src/secrets.example.h` if the template itself needs to change.

## Frontend shape

`data/app.js` is one IIFE. It reads `/config` first and injects uPlot and dsp.js
from either a CDN or `/lib/` based on the `useCdn` flag — so charting libraries
must not be referenced from `index.html`. There is a built-in radix-2 FFT
fallback for when dsp.js is unavailable. Styling is a hand-rolled token system at
the top of `data/style.css`; no framework, no build step.
