// Jarvis-Skills — reine, DOM-freie Logik (läuft unveraendert im Browser
// UND unter Node fuer Tests). Inspiriert von:
//  - isair/jarvis: Wake-Word "sag den Namen irgendwo im Satz", lokale
//    Werkzeuge vor LLM-Fallback, automatische Redaktion sensibler Daten,
//    persistentes Gedaechtnis.
//  - rajkishorbgp/JARVIS-AI-Assistant: einfache Sprachbefehle wie
//    Website oeffnen, Uhrzeit nennen, Web-Suche.
//
// Alle Seiteneffekte (Uhrzeit, Zufall, Speicher, Netzwerk, window.open)
// kommen ueber ein injizierbares `ctx`-Objekt herein, damit die Logik ohne
// Browser/DOM getestet werden kann.

export const DEFAULT_ASSISTANT_NAME = "jarvis";

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Faltet deutsche Sonderzeichen auf ASCII (fuer tolerantes Matching, z.B.
// "weißt" == "weisst", "spät" == "spaet") — nur zum Vergleichen, nie zur Anzeige.
export function normalizeDe(s) {
  return s
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue");
}

// ---------------------------------------------------------------------------
// Wake-Word
// ---------------------------------------------------------------------------
// \b in JS-Regex kennt nur ASCII-Wortzeichen — ein Name wie "René" oder "猫"
// würde damit nie als eigenes Wort erkannt. Unicode-Property-Escapes (mit
// dem u-Flag) funktionieren unabhängig vom Schriftsystem des Namens.
function wordBoundaryPattern(name) {
  return `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`;
}

export function containsWakeWord(text, name = DEFAULT_ASSISTANT_NAME) {
  const n = (name || "").trim();
  if (!n) return true;
  if (!text) return false;
  return new RegExp(wordBoundaryPattern(n), "iu").test(text);
}

// Entfernt den Namen (samt evtl. Komma/Anrede-Zeichen) aus dem Text, damit
// die Intent-Erkennung danach sauber auf dem Rest arbeiten kann.
export function stripWakeWord(text, name = DEFAULT_ASSISTANT_NAME) {
  const n = (name || "").trim();
  if (!n || !text) return (text || "").trim();
  const re = new RegExp(`${wordBoundaryPattern(n)}[,!.]?\\s*`, "iu");
  return text.replace(re, "").trim();
}

// ---------------------------------------------------------------------------
// Redaktion sensibler Daten (vor Speicherung/Logging)
// ---------------------------------------------------------------------------
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const TOKEN_RE =
  /\b(sk-[a-zA-Z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:ey[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+)\b/g;
const LONG_DIGIT_RE = /\b\d[\d -]{5,}\d\b/g;

export function redact(text) {
  if (!text) return text;
  return text
    .replace(EMAIL_RE, "[E-Mail entfernt]")
    .replace(TOKEN_RE, "[Token entfernt]")
    .replace(LONG_DIGIT_RE, "[Zahl entfernt]");
}

// ---------------------------------------------------------------------------
// Sicherer Taschenrechner (kein eval): +, -, *, /, Klammern, Dezimalzahlen
// ---------------------------------------------------------------------------
const WORD_OPS = [
  [/\bplus\b/gi, "+"],
  [/\bminus\b/gi, "-"],
  [/\bmal\b/gi, "*"],
  [/\btimes\b/gi, "*"],
  [/\bmultiplied by\b/gi, "*"],
  [/\bmultipliziert mit\b/gi, "*"],
  [/\bdivided by\b/gi, "/"],
  [/\bdividiert durch\b/gi, "/"],
  [/\bgeteilt durch\b/gi, "/"],
  [/\bdurch\b/gi, "/"],
  [/\bhoch\b/gi, "^"],
  [/\bto the power of\b/gi, "^"],
];

// Findet die laengste zusammenhaengende Formel im Text — inklusive Klammern,
// die evaluateExpression unterstuetzt (z.B. "(2 + 3) * 4"), statt sie beim
// Extrahieren stillschweigend abzuschneiden.
export function extractMathExpression(text) {
  if (!text) return null;
  let t = text.toLowerCase();
  for (const [re, sym] of WORD_OPS) t = t.replace(re, sym);
  t = t.replace(/,/g, ".");
  const candidates = t.match(/[0-9+\-*/^().\s]+/g) || [];
  let best = null;
  for (const candidate of candidates) {
    if (!/[+\-*/^]/.test(candidate) || !/\d/.test(candidate)) continue;
    const trimmed = candidate.trim();
    if (!best || trimmed.length > best.length) best = trimmed;
  }
  return best ? best.replace(/\s+/g, "") : null;
}

class MathParseError extends Error {}

export function evaluateExpression(expr) {
  const tokens = tokenize(expr);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }
  function next() {
    return tokens[pos++];
  }

  function parseExpr() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }
  function parseTerm() {
    let value = parsePow();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = parsePow();
      if (op === "/") {
        if (rhs === 0) throw new MathParseError("Division durch Null");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }
  function parsePow() {
    let value = parseUnary();
    if (peek() === "^") {
      next();
      const rhs = parsePow();
      value = Math.pow(value, rhs);
    }
    return value;
  }
  function parseUnary() {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    return parseAtom();
  }
  function parseAtom() {
    const tok = next();
    if (tok === "(") {
      const value = parseExpr();
      if (next() !== ")") throw new MathParseError("Klammer nicht geschlossen");
      return value;
    }
    if (typeof tok === "number") return tok;
    throw new MathParseError(`Unerwartetes Token: ${tok}`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new MathParseError("Unvollstaendiger Ausdruck");
  return result;
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const numStr = expr.slice(i, j);
      const num = Number(numStr);
      if (Number.isNaN(num)) throw new MathParseError(`Ungueltige Zahl: ${numStr}`);
      tokens.push(num);
      i = j;
      continue;
    }
    throw new MathParseError(`Unerwartetes Zeichen: ${c}`);
  }
  return tokens;
}

const MATH_TRIGGER_RE = /\b(was ist|wie ?viel ist|rechne|berechne|what('?s| is)|how much is|calculate|compute)\b/i;

export function mathIntent(text) {
  const expr = extractMathExpression(text);
  if (!expr) return null;
  if (!MATH_TRIGGER_RE.test(text) && !/^[\d\s+\-*/^().,]+$/.test(text.trim())) {
    return null;
  }
  try {
    const result = evaluateExpression(expr);
    const rounded = Math.round(result * 1e6) / 1e6;
    return `${expr.replace(/\^/g, "hoch")} = ${rounded}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gedaechtnis (localStorage-kompatibles Storage-Interface injizierbar)
// ---------------------------------------------------------------------------
export const MEMORY_KEY = "jarvisMemoryFacts";

export function loadMemory(storage) {
  try {
    const raw = storage.getItem(MEMORY_KEY);
    const facts = raw ? JSON.parse(raw) : [];
    return Array.isArray(facts) ? facts : [];
  } catch {
    return [];
  }
}

export function saveMemoryFact(storage, fact) {
  const facts = loadMemory(storage);
  facts.push({ text: redact(fact), ts: Date.now() });
  storage.setItem(MEMORY_KEY, JSON.stringify(facts));
  return facts;
}

export function clearMemory(storage) {
  storage.setItem(MEMORY_KEY, JSON.stringify([]));
}

// ---------------------------------------------------------------------------
// Website-Kurznamen -> URL (aus rajkishorbgp/JARVIS-AI-Assistant abgeleitet)
// ---------------------------------------------------------------------------
export const SITE_ALIASES = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  wikipedia: "https://www.wikipedia.org",
  github: "https://www.github.com",
  gmail: "https://mail.google.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  amazon: "https://www.amazon.de",
  netflix: "https://www.netflix.com",
  spotify: "https://open.spotify.com",
};

export function resolveSiteUrl(name) {
  const key = name.trim().toLowerCase();
  if (SITE_ALIASES[key]) return SITE_ALIASES[key];
  const slug = key.replace(/\s+/g, "");
  if (!slug) return null;
  if (/^https?:\/\//i.test(slug)) return slug;
  if (slug.includes(".")) return `https://${slug}`;
  return `https://www.${slug}.com`;
}

// ---------------------------------------------------------------------------
// Witze
// ---------------------------------------------------------------------------
export const JOKES = [
  "Warum koennen Geister so schlecht luegen? Weil man durch sie hindurchsieht.",
  "Ich habe meinem Computer einen Witz erzaehlt. Er hat nicht gelacht, aber der Prozessor lief heiss.",
  "Was macht ein Pirat am Computer? Er drueckt die Enter-Taste.",
  "Warum nehmen Roboter niemals ein Bad? Sie haben Angst vor Kurzschluessen.",
];

export const JOKES_EN = [
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  "I told my computer a joke. It didn't laugh, but the CPU did warm up.",
  "Why was the robot's memory so bad? Everything just kept crashing.",
  "Why don't robots ever panic? They always keep their circuits calm.",
];

export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------------------
// Wetter (wttr.in — kostenlos, kein API-Key noetig, CORS-freundlich)
// ---------------------------------------------------------------------------
export async function fetchWeather(city, fetchImpl) {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=3`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Wetterdienst antwortete mit ${res.status}`);
  const text = await res.text();
  return text.trim();
}

// ---------------------------------------------------------------------------
// Zentraler Skill-Dispatcher
// ---------------------------------------------------------------------------
// ctx: {
//   storage: { getItem, setItem }  (z.B. window.localStorage)
//   now: () => Date
//   fetchImpl: fetch-kompatible Funktion
//   openUrl: (url) => void
//   rng: () => number  (fuer deterministische Tests)
//   locale: "de-DE" | "en-US" | ... (steuert Sprache der Antworten + Datum/Zeit-Format)
// }
export async function getSkillReply(rawText, ctx) {
  const text = (rawText || "").trim();
  if (!text) return null;
  // Fuer alle festen Trigger-Phrasen wird auf einer ASCII-gefalteten,
  // kleingeschriebenen Kopie gematcht (deutsche Sonderzeichen wie ß/ä
  // sind damit fuer Deutsch- UND Englisch-Muster gleichermassen egal).
  const t = normalizeDe(text.toLowerCase());
  const now = ctx.now ? ctx.now() : new Date();
  const locale = ctx.locale || "de-DE";
  const lang = locale.toLowerCase().startsWith("en") ? "en" : "de";
  const say = (de, en) => (lang === "en" ? en : de);

  if (/\b(stop|stopp|halt|sei still|ruhe)\b/.test(t)) {
    return { type: "stop", reply: null };
  }

  if (/(vergiss (alles|das alles|bitte alles)|forget everything|forget it all)/.test(t)) {
    clearMemory(ctx.storage);
    return { type: "forget", reply: say("Erledigt, ich habe mein Gedaechtnis geleert.", "Done, I've cleared my memory.") };
  }

  let m = text.match(/^(?:merke dir|merk dir|denk daran)(?: dass| das)?\s+(.+)/i) || text.match(/^remember(?: that)?\s+(.+)/i);
  if (m && m[1]) {
    saveMemoryFact(ctx.storage, m[1]);
    return { type: "remember", reply: say(`Alles klar, ich merke mir: "${m[1]}".`, `Got it, I'll remember: "${m[1]}".`) };
  }

  if (
    /(was weisst du( noch)?\??$|was hast du dir gemerkt|zeig(e)? (mir )?(meine )?erinnerungen|what do you know|what have you remembered|show my memories)/.test(
      t
    )
  ) {
    const facts = loadMemory(ctx.storage);
    if (!facts.length) return { type: "recall", reply: say("Ich habe mir noch nichts gemerkt.", "I haven't remembered anything yet.") };
    const list = facts.slice(-5).map((f) => f.text).join("; ");
    return { type: "recall", reply: say(`Das habe ich mir gemerkt: ${list}.`, `Here's what I remember: ${list}.`) };
  }

  if (/(wie spaet|wieviel uhr|wie viel uhr|uhrzeit|what time is it|what's the time|current time)/.test(t)) {
    const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return { type: "time", reply: say(`Es ist ${time} Uhr.`, `It's ${time}.`) };
  }

  if (/(welches datum|welcher tag|heutiges datum|datum heute|what's the date|what is the date|what day is it|today's date)/.test(t)) {
    const date = now.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return { type: "date", reply: say(`Heute ist ${date}.`, `Today is ${date}.`) };
  }

  m = text.match(/^(?:oeffne|öffne|starte|geh zu|open|go to|launch)\s+(.+)/i);
  if (m && m[1]) {
    const url = resolveSiteUrl(m[1]);
    if (url) {
      if (ctx.openUrl) ctx.openUrl(url);
      return { type: "open", reply: say(`Ich oeffne ${m[1].trim()} fuer dich.`, `Opening ${m[1].trim()} for you.`), url };
    }
  }

  m = text.match(/(?:suche(?:n)? (?:im internet )?nach|google|search(?: the web)? for)\s+(.+)/i);
  if (m && m[1]) {
    const query = m[1].trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    if (ctx.openUrl) ctx.openUrl(url);
    return { type: "search", reply: say(`Ich suche im Internet nach "${query}".`, `Searching the web for "${query}".`), url };
  }

  m = text.match(/wetter(?: in| fuer| für)?\s+(.+)/i) || text.match(/weather(?: in| for)?\s+(.+)/i);
  if (m && m[1] && ctx.fetchImpl) {
    const city = m[1].trim();
    try {
      const report = await fetchWeather(city, ctx.fetchImpl);
      return { type: "weather", reply: say(`Das Wetter: ${report}`, `The weather: ${report}`) };
    } catch {
      return {
        type: "weather",
        reply: say(
          `Ich konnte das Wetter fuer ${city} gerade nicht abrufen. Vielleicht ist keine Internetverbindung da.`,
          `I couldn't fetch the weather for ${city} right now. Maybe there's no internet connection.`
        ),
      };
    }
  }

  if (/(erzaehl(e)? (mir )?einen witz|witz bitte|mach (mal )?(ei nen |einen )?witz|tell me a joke|tell a joke)/.test(t)) {
    return { type: "joke", reply: pick(lang === "en" ? JOKES_EN : JOKES, ctx.rng) };
  }

  const mathReply = mathIntent(text);
  if (mathReply) return { type: "math", reply: mathReply };

  if (/(was kannst du|hilfe|welche befehle|was fuer befehle|what can you do|what commands)/.test(t)) {
    return {
      type: "help",
      reply: say(
        "Ich kann zum Beispiel: die Uhrzeit oder das Datum nennen, eine Website oeffnen, im Internet suchen, das Wetter nennen, rechnen, Witze erzaehlen, mir Dinge merken oder wieder vergessen — und mit 'Stop' unterbreche ich mich sofort.",
        "I can, for example: tell you the time or date, open a website, search the web, tell you the weather, do calculations, tell jokes, remember or forget things — and 'stop' interrupts me instantly."
      ),
    };
  }

  return null;
}
