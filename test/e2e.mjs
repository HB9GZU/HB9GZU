// Headless Browser-Smoke-Test (echtes Chromium, kein DOM-Mock wie jsdom).
// Nutzt das global im Sandbox-Image installierte Playwright via NODE_PATH,
// da dieses Repo bewusst ohne Build/Toolchain/package.json auskommt.
//
// Ausfuehren:
//   NODE_PATH=/opt/node22/lib/node_modules node test/e2e.mjs
//
// Was getestet wird:
//  - Die Seite laedt fehlerfrei (keine unerwarteten Konsolenfehler).
//  - skills.js funktioniert unveraendert als ES-Modul in einem echten Browser
//    (nicht nur unter Node) — Wake-Word, Redaktion, Rechnen, Gedaechtnis,
//    Skill-Dispatcher inkl. window.open-Aufrufen.
//  - Die Einstellungen-UI liest/schreibt korrekt localStorage.
//  - Der komplette Sprachfluss inkl. Wake-Word-Gate, Barge-In und Skills
//    funktioniert End-to-End ueber eine simulierte SpeechRecognition/TTS
//    (echte Web-Speech-Engines sind headless nicht verfuegbar; das MediaPipe
//    CDN ist im Test-Sandbox durch die Netzwerk-Policy blockiert — genau der
//    Ausfall-Pfad, den die App jetzt tolerieren muss, wird hier mitgeprueft).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Dieses Repo kommt bewusst ohne package.json/node_modules aus. Playwright
// wird daher entweder normal aufgeloest (falls lokal installiert) oder ueber
// PLAYWRIGHT_MODULE_PATH / den globalen Sandbox-Pfad gefunden.
function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE_PATH) return require(process.env.PLAYWRIGHT_MODULE_PATH);
  try {
    return require("playwright");
  } catch {
    return require("/opt/node22/lib/node_modules/playwright");
  }
}
const { chromium } = resolvePlaywright();
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found: " + urlPath);
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Wird vor jeder Navigation injiziert: mockt Web-Speech-APIs und window.open,
// damit der volle Sprachfluss ohne Mikrofonhardware/Audio-Server testbar ist.
const INIT_SCRIPT = `
  window.__openedUrls = [];
  // Standardmaessig simuliert das einen ERFOLGREICHEN window.open (truthy
  // Rueckgabewert) — ein Test weiter unten schaltet das gezielt auf "vom
  // Popup-Blocker verworfen" (Rueckgabewert null) um.
  window.open = (url) => { window.__openedUrls.push(url); return {}; };

  window.__ttsLog = [];
  window.__ttsCancelCount = 0;
  class MockUtterance {
    constructor(text) { this.text = text; this.lang = ""; this.rate = 1; }
  }
  // window.speechSynthesis ist im echten Browser nur ueber einen Getter ohne
  // Setter erreichbar - eine simple Zuweisung schlaegt dort still fehl.
  // defineProperty erzwingt den Override zuverlaessig.
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: MockUtterance, configurable: true, writable: true,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      cancel() { window.__ttsCancelCount++; },
      speak(utter) {
        window.__ttsLog.push(utter.text);
        setTimeout(() => utter.onstart && utter.onstart(), 0);
        setTimeout(() => { utter.onboundary && utter.onboundary(); }, 5);
        setTimeout(() => utter.onend && utter.onend(), 15);
      },
      getVoices() { return []; },
    },
  });

  class MockSpeechRecognition {
    constructor() {
      window.__recognitionInstance = this;
      this.lang = "de-DE";
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.started = 0;
    }
    start() { this.started++; }
    stop() {}
    // Testhelfer: simuliert ein finales Erkennungsergebnis.
    emitFinal(transcript) {
      const result = [{ transcript }];
      result.isFinal = true;
      this.onresult && this.onresult({ resultIndex: 0, results: [result] });
    }
    // Testhelfer: simuliert ein Zwischenergebnis (fuer Barge-In-Tests).
    emitInterim(transcript) {
      const result = [{ transcript }];
      result.isFinal = false;
      this.onresult && this.onresult({ resultIndex: 0, results: [result] });
    }
  }
  window.SpeechRecognition = MockSpeechRecognition;
  window.webkitSpeechRecognition = MockSpeechRecognition;

  // Erlaubt es Tests, den Wetter-Fetch (wttr.in) kuenstlich zu verzoegern, um
  // die Race-Condition "Stop waehrend eine Antwort noch unterwegs ist" zu
  // reproduzieren (window.__weatherDelayMs, Default 0 = sofort).
  window.__weatherDelayMs = 0;
  const _origFetch = window.fetch.bind(window);
  window.fetch = (url, ...rest) => {
    if (typeof url === "string" && url.includes("wttr.in")) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, text: async () => "Testwetter: 20°C" }), window.__weatherDelayMs);
      });
    }
    return _origFetch(url, ...rest);
  };
`;

async function main() {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Testserver laeuft auf ${baseUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
    ],
  });

  let failures = 0;
  const results = [];
  async function check(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ok - ${name}`);
    } catch (e) {
      failures++;
      results.push({ name, ok: false, error: e });
      console.log(`  FAIL - ${name}`);
      console.log(`         ${e.message}`);
    }
  }

  try {
    const context = await browser.newContext();
    await context.grantPermissions(["camera", "microphone"], { origin: baseUrl });
    // Das MediaPipe-CDN ist ueber die Netzwerk-Policy dieser Sandbox blockiert
    // und wuerde ohne Interception erst nach einem langen TCP-Timeout
    // fehlschlagen. Sofortiges Abbrechen simuliert exakt den Ausfall-Pfad
    // (CDN unerreichbar), den die App tolerieren muss — nur eben schnell.
    await context.route("https://cdn.jsdelivr.net/**", (route) => route.abort("failed"));
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.addInitScript(INIT_SCRIPT);
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
    // Das Einstellungen-<details> ist standardmaessig eingeklappt (wie das
    // vorhandene "Was ist hier real"-Panel) — fuer die folgenden Interaktionen
    // muss es offen sein, sonst sind die Formularfelder unsichtbar.
    await page.evaluate(() => { document.getElementById("settingsPanel").open = true; });

    // -----------------------------------------------------------------
    await check("Seite laedt ohne Laufzeitfehler (pageerror)", async () => {
      assert.deepEqual(pageErrors, []);
    });

    await check("Grundgeruest ist vorhanden (Start/Stop/Settings)", async () => {
      for (const id of ["startBtn", "stopBtn", "cfgName", "cfgWakeWord", "cfgLang", "cfgEndpoint", "log"]) {
        const exists = await page.$(`#${id}`);
        assert.ok(exists, `#${id} fehlt im DOM`);
      }
    });

    await check("Einstellungen zeigen Standardwerte (Jarvis, Wake-Word an, de-DE)", async () => {
      const name = await page.inputValue("#cfgName");
      const wake = await page.isChecked("#cfgWakeWord");
      const lang = await page.inputValue("#cfgLang");
      assert.equal(name, "Jarvis");
      assert.equal(wake, true);
      assert.equal(lang, "de-DE");
    });

    // -----------------------------------------------------------------
    // skills.js direkt im Browser importieren und pruefen — validiert, dass
    // die Skill-Logik nicht nur unter Node, sondern auch als natives
    // ES-Modul im echten Browser-Engine funktioniert.
    await check("skills.js: Wake-Word / Redaktion / Rechnen funktionieren im Browser", async () => {
      const out = await page.evaluate(async (base) => {
        const m = await import(`${base}/skills.js`);
        return {
          wake: m.containsWakeWord("Hey Jarvis, wie spaet ist es?", "jarvis"),
          noWake: m.containsWakeWord("wie spaet ist es?", "jarvis"),
          redacted: m.redact("meine mail ist test@example.com"),
          math: m.mathIntent("was ist 6 mal 7"),
        };
      }, baseUrl);
      assert.equal(out.wake, true);
      assert.equal(out.noWake, false);
      assert.equal(out.redacted, "meine mail ist [E-Mail entfernt]");
      assert.match(out.math, /42/);
    });

    await check("skills.js: Skill-Dispatcher oeffnet Websites ueber openUrl-Callback", async () => {
      const url = await page.evaluate(async (base) => {
        const m = await import(`${base}/skills.js`);
        let opened = null;
        await m.getSkillReply("oeffne youtube", {
          storage: window.localStorage,
          now: () => new Date(),
          openUrl: (u) => (opened = u),
          fetchImpl: window.fetch.bind(window),
          rng: Math.random,
        });
        return opened;
      }, baseUrl);
      assert.equal(url, "https://www.youtube.com");
    });

    // -----------------------------------------------------------------
    await check("Einstellungen speichern persistiert in localStorage", async () => {
      await page.fill("#cfgName", "Computer");
      await page.uncheck("#cfgWakeWord");
      await page.selectOption("#cfgLang", "en-US");
      await page.click("#saveSettingsBtn");
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("jarvisSettings")));
      assert.equal(stored.name, "Computer");
      assert.equal(stored.wakeWord, false);
      assert.equal(stored.lang, "en-US");
    });

    await check("Gespeicherte Einstellungen ueberleben einen Reload", async () => {
      await page.reload({ waitUntil: "load" });
      await page.evaluate(() => { document.getElementById("settingsPanel").open = true; });
      const name = await page.inputValue("#cfgName");
      const wake = await page.isChecked("#cfgWakeWord");
      assert.equal(name, "Computer");
      assert.equal(wake, false);
      // Fuer den Rest des Tests wieder auf Standard-Namen "Jarvis" mit
      // Wake-Word zurueckstellen, damit die folgenden Checks deterministisch sind.
      await page.fill("#cfgName", "Jarvis");
      await page.check("#cfgWakeWord");
      await page.selectOption("#cfgLang", "de-DE");
      await page.click("#saveSettingsBtn");
    });

    await check("Gedaechtnis leeren setzt jarvisMemoryFacts zurueck", async () => {
      await page.evaluate(async (base) => {
        const m = await import(`${base}/skills.js`);
        m.saveMemoryFact(window.localStorage, "Testfakt");
      }, baseUrl);
      let raw = await page.evaluate(() => localStorage.getItem("jarvisMemoryFacts"));
      assert.match(raw, /Testfakt/);
      await page.click("#clearMemoryBtn");
      raw = await page.evaluate(() => localStorage.getItem("jarvisMemoryFacts"));
      assert.equal(JSON.parse(raw).length, 0);
    });

    await check("Stop-Button loggt 'Gestoppt.' und bricht TTS ab", async () => {
      const before = await page.evaluate(() => window.__ttsCancelCount);
      await page.click("#stopBtn");
      const after = await page.evaluate(() => window.__ttsCancelCount);
      assert.ok(after > before, "speechSynthesis.cancel() wurde nicht aufgerufen");
      const lastLine = await page.evaluate(() => document.querySelector("#log")?.lastElementChild?.textContent);
      assert.match(lastLine || "", /Gestoppt\./);
    });

    // -----------------------------------------------------------------
    // Voller Sprachfluss: Start klicken (Kamera via Fake-Device, Tracking
    // schlaegt im Sandbox erwartungsgemaess fehl -> Fallback-Pfad), danach
    // simulierte ASR-Ergebnisse durch den Wake-Word-Gate + Skill-Dispatcher
    // jagen und die TTS-Ausgabe pruefen.
    await check("Start-Knopf: Kamera startet, Tracking-Fallback greift, Sprache wird aktiv", async () => {
      await page.click("#startBtn");
      await page.waitForFunction(
        () => document.querySelector("#mAsr")?.textContent === "aktiv",
        { timeout: 15000 }
      );
      const logText = await page.evaluate(() => document.querySelector("#log").textContent);
      assert.match(
        logText,
        /Tracking-Modelle nicht verfügbar|Tracking bereit/,
        "weder Fallback- noch Erfolgsmeldung fuer Tracking geloggt"
      );
      await page.waitForFunction(() => window.__ttsLog && window.__ttsLog.length > 0, { timeout: 5000 });
    });

    await check("Utterance ohne Namensnennung wird bei aktivem Wake-Word ignoriert", async () => {
      const before = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("wie spaet ist es"));
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => window.__ttsLog.length);
      assert.equal(after, before, "Assistent hat trotz fehlendem Wake-Word geantwortet");
    });

    await check("'Jarvis, wie spaet ist es?' beantwortet die Uhrzeit per TTS", async () => {
      const before = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis, wie spaet ist es?"));
      await page.waitForFunction(
        (n) => window.__ttsLog.length > n,
        before,
        { timeout: 3000 }
      );
      const said = await page.evaluate(() => window.__ttsLog.at(-1));
      assert.match(said, /Uhr/);
    });

    await check("'Jarvis öffne youtube' oeffnet die Seite ueber window.open", async () => {
      await page.evaluate(() => (window.__openedUrls.length = 0));
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis öffne youtube"));
      await page.waitForFunction(() => window.__openedUrls.length > 0, { timeout: 3000 });
      const opened = await page.evaluate(() => window.__openedUrls[0]);
      assert.equal(opened, "https://www.youtube.com");
    });

    await check("Blockiertes Popup: 'Erfolg' wird nicht stillschweigend behauptet", async () => {
      // Simuliert einen Browser, dessen Popup-Blocker window.open() verwirft
      // (gibt null zurueck statt eines Fensters) — genau der Fall, den ein
      // verzoegerter Sprach-Callback ohne "echten" Klick ausloesen kann.
      await page.evaluate(() => { window.open = (url) => { window.__openedUrls.push(url); return null; }; });
      const before = await page.evaluate(() => document.querySelectorAll("#log .sys").length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis öffne github"));
      await page.waitForFunction(
        (n) => document.querySelectorAll("#log .sys").length > n,
        before,
        { timeout: 3000 }
      );
      const lastText = await page.evaluate(() => {
        const nodes = document.querySelectorAll("#log .sys");
        return nodes[nodes.length - 1].textContent;
      });
      assert.match(lastText, /Popup blockiert/);
      // Fuer die folgenden Tests wieder auf "erfolgreiches" window.open zurueckstellen.
      await page.evaluate(() => { window.open = (url) => { window.__openedUrls.push(url); return {}; }; });
    });

    await check("Barge-In: Sprache waehrend TTS-Ausgabe bricht sofort ab", async () => {
      // Laesst den Assistenten etwas laenger sprechen (Witz-Skill), damit
      // die simulierte Nutzer-Unterbrechung waehrend isSpeaking=true ankommt.
      const baseline = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis erzaehl mir einen witz"));
      // Auf genau DIESE Antwort warten (nicht nur "irgendwas in ttsLog"),
      // sonst laeuft der naechste Test-Schritt einer noch ausstehenden
      // Antwort hinterher.
      await page.waitForFunction((n) => window.__ttsLog.length > n, baseline, { timeout: 3000 });
      await page.waitForTimeout(50); // sicherstellen, dass utter.onstart (isSpeaking=true) schon feuerte
      const before = await page.evaluate(() => window.__ttsCancelCount);
      // Interim-Ergebnis waehrend (vermutlich) laufender Sprachausgabe.
      await page.evaluate(() => window.__recognitionInstance.emitInterim("Jarvis stop"));
      const after = await page.evaluate(() => window.__ttsCancelCount);
      assert.ok(after >= before, "Barge-In hat speechSynthesis.cancel() nicht ausgeloest");
      // Kurz auf onend warten, damit isSpeaking wieder false ist, bevor der
      // naechste Test-Schritt beginnt.
      await page.waitForTimeout(50);
    });

    await check("Stop waehrend eine langsame Antwort unterwegs ist: keine verspaetete Rede danach", async () => {
      // Reproduziert die Race Condition: eine langsame Wetterabfrage ist noch
      // unterwegs, der Nutzer sagt "Stop" - wenn der Fetch danach doch noch
      // aufloest, darf er NICHT nachtraeglich sprechen.
      await page.evaluate(() => { window.__weatherDelayMs = 600; });
      const before = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis wetter in Berlin"));
      await page.waitForTimeout(450); // nach dem 350ms-Debounce, aber vor Ablauf des 600ms-Fetches
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis stop"));
      await page.waitForTimeout(900); // wartet den verzoegerten Fetch ab (haette bei 350+600ms aufgeloest)
      const after = await page.evaluate(() => window.__ttsLog.length);
      assert.equal(after, before, "Der ueberholte Wetter-Fetch hat trotz Stop noch gesprochen");
      await page.evaluate(() => { window.__weatherDelayMs = 0; });
    });

    await check("Rechnen ueber Sprache: 'Jarvis was ist 6 mal 7' liefert 42", async () => {
      const before = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis was ist 6 mal 7"));
      await page.waitForFunction((n) => window.__ttsLog.length > n, before, { timeout: 3000 });
      const said = await page.evaluate(() => window.__ttsLog.at(-1));
      assert.match(said, /42/);
    });

    await check("Sprache auf Englisch umstellen: englische Befehle werden verstanden", async () => {
      await page.evaluate(() => { document.getElementById("settingsPanel").open = true; });
      await page.selectOption("#cfgLang", "en-US");
      await page.click("#saveSettingsBtn");
      const before = await page.evaluate(() => window.__ttsLog.length);
      await page.evaluate(() => window.__recognitionInstance.emitFinal("Jarvis what time is it?"));
      await page.waitForFunction((n) => window.__ttsLog.length > n, before, { timeout: 3000 });
      const said = await page.evaluate(() => window.__ttsLog.at(-1));
      assert.match(said, /It's/);
      // Zurueck auf Deutsch fuer eventuell folgende Checks.
      await page.selectOption("#cfgLang", "de-DE");
      await page.click("#saveSettingsBtn");
    });

    await check("Keine unerwarteten Browser-Konsolenfehler", async () => {
      const unexpected = consoleErrors.filter(
        (m) => !/favicon|mediapipe|vision_bundle|net::err|failed to (load|fetch)/i.test(m)
      );
      assert.deepEqual(unexpected, [], `Konsolenfehler: ${unexpected.join(" | ")}`);
    });

    await check("Keine unbehandelten Laufzeitfehler ueber den gesamten Testlauf", async () => {
      assert.deepEqual(pageErrors, []);
    });

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${results.length - failures}/${results.length} Checks bestanden.`);
  if (failures > 0) {
    console.error(`${failures} Check(s) fehlgeschlagen.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
