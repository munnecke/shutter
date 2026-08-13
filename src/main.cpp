// -----------------------------------------------------------------------------
// Acoustic Shutter Diagnostic Bench — XIAO ESP32S3 firmware
//
// Captures a window of microphone audio using the ESP32-S3 continuous (DMA) ADC
// driver, triggered by a hardware button or an HTTP request, and serves the
// waveform plus a small web app from LittleFS over Wi-Fi.
//
// Requires Arduino-ESP32 core 3.x (ESP-IDF 5.x) — the esp_adc/adc_continuous
// driver does not exist in core 2.x.
// -----------------------------------------------------------------------------

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <time.h>

#include "esp_adc/adc_continuous.h"
#include "secrets.h"

// ----------------------------------------------------------------- pin mapping
// XIAO ESP32S3: D0 = GPIO1 = ADC1_CH0, D1 = GPIO2 (digital input).
#define MIC_ADC_GPIO      1
#define MIC_ADC_CHANNEL   ADC_CHANNEL_0
#define BUTTON_GPIO       2

// ------------------------------------------------------------------ capture cfg
static const uint32_t SAMPLE_RATE_HZ   = 5000;      // 200 us per sample
static const uint32_t MIN_WINDOW_MS    = 250;
static const uint32_t MAX_WINDOW_MS    = 6000;
static const size_t   MAX_SAMPLES      = (SAMPLE_RATE_HZ * MAX_WINDOW_MS) / 1000;
static const size_t   CONV_FRAME_BYTES = 1024;      // multiple of 4
static const uint32_t DEBOUNCE_US      = 250000;

// --------------------------------------------------------------------- state
enum CaptureState { STATE_IDLE, STATE_CAPTURING, STATE_READY };

static volatile bool         g_triggerFlag  = false;
static volatile bool         g_triggerFromWeb = false;
static volatile uint32_t     g_lastTriggerUs = 0;
static CaptureState          g_state        = STATE_IDLE;
static int16_t              *g_samples      = nullptr;
static size_t                g_sampleCount  = 0;
static uint32_t              g_windowMs     = 2000;
static uint32_t              g_captureSeq   = 0;     // increments on each capture
static char                  g_triggerSrc[8] = "none";

static adc_continuous_handle_t g_adcHandle = nullptr;
static AsyncWebServer          server(80);

// config.json, mirrored in RAM
static bool   g_useCdn      = true;
static String g_traceColor  = "#123f73";
static String g_fftColor    = "#9a7014";
static bool   g_autoscaleY  = false;

// ---------------------------------------------------------------------- ISR
void IRAM_ATTR onButtonFalling() {
  uint32_t now = (uint32_t)esp_timer_get_time();
  if (now - g_lastTriggerUs < DEBOUNCE_US) return;
  g_lastTriggerUs = now;
  g_triggerFromWeb = false;
  g_triggerFlag = true;
}

// ------------------------------------------------------------------ ADC setup
static bool adcInit() {
  adc_continuous_handle_cfg_t handleCfg = {};
  handleCfg.max_store_buf_size = CONV_FRAME_BYTES * 8;
  handleCfg.conv_frame_size    = CONV_FRAME_BYTES;
  if (adc_continuous_new_handle(&handleCfg, &g_adcHandle) != ESP_OK) return false;

  adc_digi_pattern_config_t pattern = {};
  pattern.atten     = ADC_ATTEN_DB_12;     // ~0..3.1 V full scale
  pattern.channel   = MIC_ADC_CHANNEL & 0x7;
  pattern.unit      = ADC_UNIT_1;
  pattern.bit_width = ADC_BITWIDTH_12;

  adc_continuous_config_t digCfg = {};
  digCfg.pattern_num    = 1;
  digCfg.adc_pattern    = &pattern;
  digCfg.sample_freq_hz = SAMPLE_RATE_HZ;
  digCfg.conv_mode      = ADC_CONV_SINGLE_UNIT_1;
  digCfg.format         = ADC_DIGI_OUTPUT_FORMAT_TYPE2;

  return adc_continuous_config(g_adcHandle, &digCfg) == ESP_OK;
}

// Fills g_samples with `target` samples. Blocking; called from loop(), never
// from an async web callback.
static void runCapture(const char *source) {
  size_t target = (SAMPLE_RATE_HZ * g_windowMs) / 1000;
  if (target > MAX_SAMPLES) target = MAX_SAMPLES;

  g_state = STATE_CAPTURING;
  g_sampleCount = 0;
  strncpy(g_triggerSrc, source, sizeof(g_triggerSrc) - 1);

  static uint8_t frame[CONV_FRAME_BYTES];
  uint32_t got = 0;

  adc_continuous_start(g_adcHandle);

  // Discard the first frame: it can hold pre-trigger residue from the pool.
  adc_continuous_read(g_adcHandle, frame, sizeof(frame), &got, 50);

  size_t n = 0;
  uint32_t deadline = millis() + g_windowMs + 1000;
  while (n < target && millis() < deadline) {
    esp_err_t err = adc_continuous_read(g_adcHandle, frame, sizeof(frame), &got, 100);
    if (err != ESP_OK) continue;
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= got && n < target;
         i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t *p = (adc_digi_output_data_t *)&frame[i];
      if (p->type2.channel != (MIC_ADC_CHANNEL & 0x7)) continue;
      g_samples[n++] = (int16_t)p->type2.data;
    }
  }

  adc_continuous_stop(g_adcHandle);

  g_sampleCount = n;
  g_captureSeq++;
  g_state = STATE_READY;
  Serial.printf("capture #%u: %u samples (%s)\n", g_captureSeq, (unsigned)n, source);
}

// --------------------------------------------------------------- config store
static void configLoad() {
  File f = LittleFS.open("/config.json", "r");
  if (!f) return;
  JsonDocument doc;
  if (deserializeJson(doc, f) == DeserializationError::Ok) {
    if (!doc["useCdn"].isNull())     g_useCdn     = doc["useCdn"].as<bool>();
    if (!doc["windowMs"].isNull())   g_windowMs   = doc["windowMs"].as<uint32_t>();
    if (!doc["traceColor"].isNull()) g_traceColor = doc["traceColor"].as<String>();
    if (!doc["fftColor"].isNull())   g_fftColor   = doc["fftColor"].as<String>();
    if (!doc["autoscaleY"].isNull()) g_autoscaleY = doc["autoscaleY"].as<bool>();
  }
  f.close();
  g_windowMs = constrain(g_windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS);
}

static bool configSave() {
  File f = LittleFS.open("/config.json", "w");
  if (!f) return false;
  JsonDocument doc;
  doc["useCdn"]     = g_useCdn;
  doc["sampleRate"] = SAMPLE_RATE_HZ;
  doc["windowMs"]   = g_windowMs;
  doc["maxWindowMs"] = MAX_WINDOW_MS;
  doc["traceColor"] = g_traceColor;
  doc["fftColor"]   = g_fftColor;
  doc["autoscaleY"] = g_autoscaleY;
  serializeJson(doc, f);
  f.close();
  return true;
}

// ------------------------------------------------------------------- helpers
static String sanitize(const String &in) {
  String out;
  for (size_t i = 0; i < in.length() && out.length() < 40; i++) {
    char c = in[i];
    if (isalnum(c)) out += c;
    else if (c == '-' || c == '_') out += c;
    else if (c == '/' || c == ' ' || c == '.') out += '-';
  }
  if (out.length() == 0) out = "test";
  return out;
}

static String isoNow() {
  time_t now = time(nullptr);
  if (now < 1700000000) return String("");          // NTP not synced yet
  char buf[25];
  struct tm tmv;
  gmtime_r(&now, &tmv);
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmv);
  return String(buf);
}

// Pulls a "key":"value" or "key":number out of the first bytes of a saved file.
static String peekField(const String &head, const char *key) {
  int k = head.indexOf(String("\"") + key + "\"");
  if (k < 0) return String("");
  int c = head.indexOf(':', k);
  if (c < 0) return String("");
  int i = c + 1;
  while (i < (int)head.length() && head[i] == ' ') i++;
  if (i >= (int)head.length()) return String("");
  if (head[i] == '"') {
    int e = head.indexOf('"', i + 1);
    if (e < 0) return String("");
    return head.substring(i + 1, e);
  }
  int e = i;
  while (e < (int)head.length() && head[e] != ',' && head[e] != '}') e++;
  return head.substring(i, e);
}

// ----------------------------------------------------------------- HTTP routes
static File g_uploadFile;

static void routes() {
  // --- GET /status ---
  server.on("/status", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    doc["state"]      = g_state == STATE_IDLE ? "idle"
                      : g_state == STATE_CAPTURING ? "capturing" : "ready";
    doc["seq"]        = g_captureSeq;
    doc["count"]      = g_sampleCount;
    doc["sampleRate"] = SAMPLE_RATE_HZ;
    doc["windowMs"]   = g_windowMs;
    doc["trigger"]    = g_triggerSrc;
    doc["heap"]       = ESP.getFreeHeap();
    doc["rssi"]       = WiFi.RSSI();
    doc["time"]       = isoNow();
    String out;
    serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  // --- POST /capture?window=2000 : software trigger ---
  server.on("/capture", HTTP_POST, [](AsyncWebServerRequest *req) {
    if (g_state == STATE_CAPTURING) {
      req->send(409, "application/json", "{\"error\":\"capture in progress\"}");
      return;
    }
    if (req->hasParam("window")) {
      uint32_t w = req->getParam("window")->value().toInt();
      g_windowMs = constrain(w, MIN_WINDOW_MS, MAX_WINDOW_MS);
    }
    g_triggerFromWeb = true;
    g_triggerFlag = true;
    req->send(202, "application/json", "{\"queued\":true}");
  });

  // --- GET /data : chunked JSON so a 30k-sample array never needs one buffer ---
  server.on("/data", HTTP_GET, [](AsyncWebServerRequest *req) {
    if (g_state != STATE_READY || g_sampleCount == 0) {
      req->send(409, "application/json", "{\"error\":\"no capture available\"}");
      return;
    }
    const size_t   n    = g_sampleCount;
    const uint32_t seq  = g_captureSeq;
    auto cursor = std::make_shared<size_t>(0);
    auto done   = std::make_shared<bool>(false);

    AsyncWebServerResponse *res = req->beginChunkedResponse(
      "application/json",
      [n, seq, cursor, done](uint8_t *buf, size_t maxLen, size_t index) -> size_t {
        if (*done) return 0;
        size_t pos = 0;
        if (index == 0) {
          pos += snprintf((char *)buf, maxLen,
                          "{\"seq\":%u,\"sampleRate\":%u,\"count\":%u,\"samples\":[",
                          (unsigned)seq, (unsigned)SAMPLE_RATE_HZ, (unsigned)n);
        }
        while (*cursor < n && (maxLen - pos) > 8) {
          int w = snprintf((char *)buf + pos, maxLen - pos,
                           (*cursor == 0 ? "%d" : ",%d"), (int)g_samples[*cursor]);
          if (w <= 0 || (size_t)w >= maxLen - pos) break;
          pos += w;
          (*cursor)++;
        }
        if (*cursor >= n && (maxLen - pos) > 3) {
          pos += snprintf((char *)buf + pos, maxLen - pos, "]}");
          *done = true;
        }
        return pos;
      });
    res->addHeader("Cache-Control", "no-store");
    req->send(res);
  });

  // --- GET /config ---
  server.on("/config", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    doc["useCdn"]      = g_useCdn;
    doc["sampleRate"]  = SAMPLE_RATE_HZ;
    doc["windowMs"]    = g_windowMs;
    doc["minWindowMs"] = MIN_WINDOW_MS;
    doc["maxWindowMs"] = MAX_WINDOW_MS;
    doc["traceColor"]  = g_traceColor;
    doc["fftColor"]    = g_fftColor;
    doc["autoscaleY"]  = g_autoscaleY;
    String out;
    serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  // --- POST /config (small JSON body, handled in one shot) ---
  server.on("/config", HTTP_POST,
    [](AsyncWebServerRequest *req) {},
    nullptr,
    [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t index, size_t total) {
      JsonDocument doc;
      if (deserializeJson(doc, data, len) != DeserializationError::Ok) {
        req->send(400, "application/json", "{\"error\":\"bad json\"}");
        return;
      }
      if (!doc["useCdn"].isNull())     g_useCdn     = doc["useCdn"].as<bool>();
      if (!doc["traceColor"].isNull()) g_traceColor = doc["traceColor"].as<String>();
      if (!doc["fftColor"].isNull())   g_fftColor   = doc["fftColor"].as<String>();
      if (!doc["autoscaleY"].isNull()) g_autoscaleY = doc["autoscaleY"].as<bool>();
      if (!doc["windowMs"].isNull())
        g_windowMs = constrain(doc["windowMs"].as<uint32_t>(), MIN_WINDOW_MS, MAX_WINDOW_MS);
      bool ok = configSave();
      req->send(ok ? 200 : 500, "application/json",
                ok ? "{\"saved\":true}" : "{\"error\":\"write failed\"}");
    });

  // --- POST /save?name=1-125 : body is streamed straight to flash ---
  server.on("/save", HTTP_POST,
    [](AsyncWebServerRequest *req) {
      if (g_uploadFile) g_uploadFile.close();
      req->send(200, "application/json", "{\"saved\":true}");
    },
    nullptr,
    [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t index, size_t total) {
      if (index == 0) {
        String name = req->hasParam("name") ? sanitize(req->getParam("name")->value())
                                            : String("test");
        String path = "/library/" + String((uint32_t)(millis() / 1000)) + "-" + name + ".json";
        g_uploadFile = LittleFS.open(path, "w");
      }
      if (g_uploadFile) g_uploadFile.write(data, len);
      if (index + len >= total && g_uploadFile) {
        g_uploadFile.close();
      }
    });

  // --- GET /library : list saved captures ---
  server.on("/library", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    File dir = LittleFS.open("/library");
    File f = dir.openNextFile();
    while (f) {
      if (!f.isDirectory()) {
        char head[321] = {0};
        size_t got = f.readBytes(head, sizeof(head) - 1);
        head[got] = 0;
        String h(head);
        JsonObject o = arr.add<JsonObject>();
        String nm = String(f.name());
        o["file"]    = nm.startsWith("/") ? nm : ("/library/" + nm);
        o["size"]    = (uint32_t)f.size();
        o["speed"]   = peekField(h, "speed");
        o["created"] = peekField(h, "created");
        o["notes"]   = peekField(h, "notes");
      }
      f = dir.openNextFile();
    }
    String out;
    serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  // --- DELETE /library?file=/library/x.json ---
  server.on("/library", HTTP_DELETE, [](AsyncWebServerRequest *req) {
    if (!req->hasParam("file")) {
      req->send(400, "application/json", "{\"error\":\"file required\"}");
      return;
    }
    String p = req->getParam("file")->value();
    if (!p.startsWith("/library/")) {
      req->send(400, "application/json", "{\"error\":\"path outside library\"}");
      return;
    }
    bool ok = LittleFS.remove(p);
    req->send(ok ? 200 : 404, "application/json",
              ok ? "{\"deleted\":true}" : "{\"error\":\"not found\"}");
  });

  // --- static app + saved captures, registered last so the API wins ---
  server.serveStatic("/", LittleFS, "/")
        .setDefaultFile("index.html")
        .setCacheControl("max-age=600");

  server.onNotFound([](AsyncWebServerRequest *req) {
    req->send(404, "application/json", "{\"error\":\"no such endpoint\"}");
  });
}

// ---------------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  delay(300);

  if (psramFound()) {
    g_samples = (int16_t *)ps_malloc(MAX_SAMPLES * sizeof(int16_t));
  }
  if (!g_samples) {
    g_samples = (int16_t *)malloc(MAX_SAMPLES * sizeof(int16_t));
  }
  if (!g_samples) {
    Serial.println("FATAL: sample buffer allocation failed");
    while (true) delay(1000);
  }

  if (!LittleFS.begin(true)) {
    Serial.println("FATAL: LittleFS mount failed");
    while (true) delay(1000);
  }
  if (!LittleFS.exists("/library")) LittleFS.mkdir("/library");
  configLoad();

  pinMode(BUTTON_GPIO, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_GPIO), onButtonFalling, FALLING);

  if (!adcInit()) {
    Serial.println("FATAL: ADC continuous init failed");
    while (true) delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("wifi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("ip: %s\n", WiFi.localIP().toString().c_str());
    configTime(0, 0, "pool.ntp.org");
    if (MDNS.begin("shutter")) {
      MDNS.addService("http", "tcp", 80);
      Serial.println("http://shutter.local");
    }
  } else {
    Serial.println("wifi failed — check secrets.h (2.4 GHz network only)");
  }

  routes();
  server.begin();
  Serial.println("ready — press the button, then fire the shutter");
}

// ----------------------------------------------------------------------- loop
void loop() {
  if (g_triggerFlag) {
    g_triggerFlag = false;
    runCapture(g_triggerFromWeb ? "web" : "button");
  }
  delay(5);
}
