// Reine Node-Unit-Tests fuer skills.js — keine Abhaengigkeiten, kein DOM.
// Ausfuehren: node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import {
  containsWakeWord,
  stripWakeWord,
  redact,
  extractMathExpression,
  evaluateExpression,
  mathIntent,
  loadMemory,
  saveMemoryFact,
  clearMemory,
  resolveSiteUrl,
  getSkillReply,
  normalizeDe,
} from "../skills.js";

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    _store: store,
  };
}

function makeCtx(overrides = {}) {
  return {
    storage: makeStorage(),
    now: () => new Date("2026-09-12T14:30:00"),
    openUrl: () => {},
    rng: () => 0,
    fetchImpl: async () => ({ ok: true, text: async () => "Zuerich: ☀️ +20°C" }),
    ...overrides,
  };
}

// --- Wake word -------------------------------------------------------------
test("containsWakeWord findet den Namen irgendwo im Satz", () => {
  assert.equal(containsWakeWord("Hey Jarvis, wie spaet ist es?", "jarvis"), true);
  assert.equal(containsWakeWord("JARVIS mach das Licht an", "jarvis"), true);
  assert.equal(containsWakeWord("mach das Licht an", "jarvis"), false);
  assert.equal(containsWakeWord("Jarvison ist kein Name", "jarvis"), false);
});

test("containsWakeWord mit leerem Namen ist immer wahr (Wake-Word deaktiviert)", () => {
  assert.equal(containsWakeWord("irgendwas", ""), true);
});

test("stripWakeWord entfernt nur den Namen", () => {
  assert.equal(stripWakeWord("Jarvis, wie spaet ist es?", "jarvis"), "wie spaet ist es?");
  assert.equal(stripWakeWord("wie spaet ist es Jarvis", "jarvis"), "wie spaet ist es");
});

// --- Redaction ---------------------------------------------------------------
test("redact entfernt E-Mail-Adressen", () => {
  assert.equal(redact("meine Mail ist test@example.com"), "meine Mail ist [E-Mail entfernt]");
});

test("redact entfernt lange Zahlenfolgen", () => {
  assert.equal(redact("meine Nummer ist 0791234567"), "meine Nummer ist [Zahl entfernt]");
});

test("redact laesst normalen Text unveraendert", () => {
  assert.equal(redact("Hallo, wie geht es dir?"), "Hallo, wie geht es dir?");
});

// --- Calculator --------------------------------------------------------------
test("extractMathExpression erkennt Wortoperatoren", () => {
  assert.equal(extractMathExpression("was ist 12 plus 5"), "12+5");
  assert.equal(extractMathExpression("rechne 10 geteilt durch 2"), "10/2");
});

test("evaluateExpression rechnet mit Operatorrangfolge und Klammern", () => {
  assert.equal(evaluateExpression("2+3*4"), 14);
  assert.equal(evaluateExpression("(2+3)*4"), 20);
  assert.equal(evaluateExpression("2^3+1"), 9);
  assert.equal(evaluateExpression("-4+10"), 6);
});

test("evaluateExpression wirft bei Division durch Null", () => {
  assert.throws(() => evaluateExpression("5/0"));
});

test("mathIntent liefert eine formatierte Antwort", () => {
  assert.equal(mathIntent("was ist 12 plus 5"), "12+5 = 17");
  assert.equal(mathIntent("12+5"), "12+5 = 17");
});

test("mathIntent ignoriert Saetze ohne Trigger und ohne reine Formel", () => {
  assert.equal(mathIntent("ich habe 3 Katzen und 2 Hunde"), null);
});

// --- Memory --------------------------------------------------------------------
test("Memory speichert, listet und leert Fakten", () => {
  const storage = makeStorage();
  assert.deepEqual(loadMemory(storage), []);
  saveMemoryFact(storage, "der Wlan Code ist 1234");
  const facts = loadMemory(storage);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].text, "der Wlan Code ist 1234");
  clearMemory(storage);
  assert.deepEqual(loadMemory(storage), []);
});

// --- Site resolution -------------------------------------------------------------
test("resolveSiteUrl kennt gaengige Aliase und baut sonst eine URL", () => {
  assert.equal(resolveSiteUrl("youtube"), "https://www.youtube.com");
  assert.equal(resolveSiteUrl("YouTube"), "https://www.youtube.com");
  assert.equal(resolveSiteUrl("example.com"), "https://example.com");
  assert.equal(resolveSiteUrl("meinshop"), "https://www.meinshop.com");
});

// --- Full dispatcher ---------------------------------------------------------
test("getSkillReply: stop", async () => {
  const res = await getSkillReply("stop", makeCtx());
  assert.equal(res.type, "stop");
});

test("getSkillReply: Uhrzeit", async () => {
  const res = await getSkillReply("wie spaet ist es?", makeCtx());
  assert.equal(res.type, "time");
  assert.match(res.reply, /14:30/);
});

test("getSkillReply: Datum", async () => {
  const res = await getSkillReply("welches datum haben wir heute?", makeCtx());
  assert.equal(res.type, "date");
  assert.match(res.reply, /2026/);
});

test("getSkillReply: Website oeffnen ruft openUrl auf", async () => {
  let opened = null;
  const res = await getSkillReply("oeffne youtube", makeCtx({ openUrl: (u) => (opened = u) }));
  assert.equal(res.type, "open");
  assert.equal(opened, "https://www.youtube.com");
});

test("getSkillReply: Websuche baut Google-URL", async () => {
  let opened = null;
  const res = await getSkillReply("suche nach hb9gzu funkrufzeichen", makeCtx({ openUrl: (u) => (opened = u) }));
  assert.equal(res.type, "search");
  assert.match(opened, /google\.com\/search\?q=/);
});

test("getSkillReply: Wetter mit Mock-Fetch", async () => {
  const res = await getSkillReply("wie ist das wetter in zuerich", makeCtx());
  assert.equal(res.type, "weather");
  assert.match(res.reply, /Zuerich/);
});

test("getSkillReply: Wetter faellt bei Netzwerkfehler sauber zurueck", async () => {
  const res = await getSkillReply(
    "wetter in nirgendwo",
    makeCtx({ fetchImpl: async () => { throw new Error("offline"); } })
  );
  assert.equal(res.type, "weather");
  assert.match(res.reply, /konnte das Wetter/);
});

test("getSkillReply: Witz", async () => {
  const res = await getSkillReply("erzaehl mir einen witz", makeCtx());
  assert.equal(res.type, "joke");
  assert.equal(typeof res.reply, "string");
});

test("getSkillReply: merken und abrufen", async () => {
  const ctx = makeCtx();
  const r1 = await getSkillReply("merke dir dass die Katze Minka heisst", ctx);
  assert.equal(r1.type, "remember");
  const r2 = await getSkillReply("was weisst du noch?", ctx);
  assert.equal(r2.type, "recall");
  assert.match(r2.reply, /Minka/);
});

test("getSkillReply: vergiss alles leert das Gedaechtnis", async () => {
  const ctx = makeCtx();
  await getSkillReply("merke dir dass 42 die Antwort ist", ctx);
  const forgetRes = await getSkillReply("vergiss alles", ctx);
  assert.equal(forgetRes.type, "forget");
  const recall = await getSkillReply("was weisst du noch?", ctx);
  assert.match(recall.reply, /noch nichts gemerkt/);
});

test("getSkillReply: Rechnen ueber den Dispatcher", async () => {
  const res = await getSkillReply("was ist 6 mal 7", makeCtx());
  assert.equal(res.type, "math");
  assert.match(res.reply, /42/);
});

test("getSkillReply: Hilfe", async () => {
  const res = await getSkillReply("was kannst du?", makeCtx());
  assert.equal(res.type, "help");
});

test("getSkillReply: unbekannter Text ergibt null (Fallback an LLM/Regel-Responder)", async () => {
  const res = await getSkillReply("erzaehl mir von deinem Tag", makeCtx());
  assert.equal(res, null);
});

// --- Regressionstests fuer Codex-Review-Findings auf PR #1 ------------------

test("extractMathExpression erhaelt Klammern statt sie abzuschneiden", () => {
  assert.equal(extractMathExpression("rechne (2 + 3) * 4"), "(2+3)*4");
});

test("mathIntent rechnet mit Klammern korrekt (nicht nur den ersten Teilausdruck)", () => {
  assert.equal(mathIntent("rechne (2 + 3) * 4"), "(2+3)*4 = 20");
});

test("containsWakeWord erkennt Namen mit Nicht-ASCII-Zeichen (Unicode-Wortgrenzen)", () => {
  assert.equal(containsWakeWord("Hey René, wie spaet ist es?", "René"), true);
  assert.equal(containsWakeWord("Renéson ist kein Treffer", "René"), false);
  assert.equal(containsWakeWord("Hallo 猫, wie geht's?", "猫"), true);
});

test("stripWakeWord funktioniert auch mit Nicht-ASCII-Namen", () => {
  assert.equal(stripWakeWord("René, wie spaet ist es?", "René"), "wie spaet ist es?");
});

test("normalizeDe faltet ß/ä/ö/ü auf ASCII", () => {
  assert.equal(normalizeDe("was weißt du noch"), "was weisst du noch");
});

test("getSkillReply: 'was weißt du noch?' (echtes ß) erreicht den Recall-Skill", async () => {
  const ctx = makeCtx();
  await getSkillReply("merke dir dass die Katze Minka heisst", ctx);
  const res = await getSkillReply("was weißt du noch?", ctx);
  assert.equal(res.type, "recall");
  assert.match(res.reply, /Minka/);
});

test("getSkillReply: Englisch-Locale beantwortet englische Befehle auf Englisch", async () => {
  const ctx = makeCtx({ locale: "en-US" });
  const time = await getSkillReply("what time is it?", ctx);
  assert.equal(time.type, "time");
  assert.match(time.reply, /It's/);

  const joke = await getSkillReply("tell me a joke", ctx);
  assert.equal(joke.type, "joke");

  const math = await getSkillReply("what is 6 times 7", ctx);
  assert.equal(math.type, "math");
  assert.match(math.reply, /42/);

  const open = await getSkillReply("open youtube", ctx);
  assert.equal(open.type, "open");
  assert.match(open.reply, /Opening youtube/);
});
