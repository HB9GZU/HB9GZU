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

// ---------------------------------------------------------------------------
// Wake-Word
// ---------------------------------------------------------------------------
export function containsWakeWord(text, name = DEFAULT_ASSISTANT_NAME) {
  const n = (name || "").trim();
  if (!n) return true;
  if (!text) return false;
  const re = new RegExp(`\\b${escapeRegExp(n)}\\b`, "i");
  return re.test(text);
}

// Entfernt den Namen (samt evtl. Komma/Anrede-Zeichen) aus dem Text, damit
// die Intent-Erkennung danach sauber auf dem Rest arbeiten kann.
export function stripWakeWord(text, name = DEFAULT_ASSISTANT_NAME) {
  const n = (name || "").trim();
  if (!n || !text) return (text || "").trim();
  const re = new RegExp(`\\b${escapeRegExp(n)}\\b[,!.]?\\s*`, "i");
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
  [/\bmultipliziert mit\b/gi, "*"],
  [/\bdividiert durch\b/gi, "/"],
  [/\bgeteilt durch\b/gi, "/"],
  [/\bdurch\b/gi, "/"],
  [/\bhoch\b/gi, "^"],
];

export function extractMathExpression(text) {
  if (!text) return null;
  let t = text.toLowerCase();
  for (const [re, sym] of WORD_OPS) t = t.replace(re, sym);
  t = t.replace(/,/g, ".");
  const match = t.match(/-?\d+(\.\d+)?\s*(?:[+\-*/^]\s*-?\d+(\.\d+)?\s*)+/);
  return match ? match[0].trim().replace(/\s+/g, "") : null;
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

const MATH_TRIGGER_RE = /\b(was ist|wie ?viel ist|rechne|berechne)\b/i;

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
// }
export async function getSkillReply(rawText, ctx) {
  const text = (rawText || "").trim();
  if (!text) return null;
  const t = text.toLowerCase();
  const now = ctx.now ? ctx.now() : new Date();

  if (/\b(stop|stopp|halt|sei still|ruhe)\b/.test(t)) {
    return { type: "stop", reply: null };
  }

  if (/vergiss (alles|das alles|bitte alles)/.test(t)) {
    clearMemory(ctx.storage);
    return { type: "forget", reply: "Erledigt, ich habe mein Gedaechtnis geleert." };
  }

  let m = text.match(/^(?:merke dir|merk dir|denk daran)(?: dass| das)?\s+(.+)/i);
  if (m && m[1]) {
    saveMemoryFact(ctx.storage, m[1]);
    return { type: "remember", reply: `Alles klar, ich merke mir: "${m[1]}".` };
  }

  if (/(was weisst du( noch)?\??$|was hast du dir gemerkt|zeig(e)? (mir )?(meine )?erinnerungen)/.test(t)) {
    const facts = loadMemory(ctx.storage);
    if (!facts.length) return { type: "recall", reply: "Ich habe mir noch nichts gemerkt." };
    const list = facts.slice(-5).map((f) => f.text).join("; ");
    return { type: "recall", reply: `Das habe ich mir gemerkt: ${list}.` };
  }

  if (/(wie spaet|wieviel uhr|wie viel uhr|uhrzeit)/.test(t.replace(/ä/g, "ae"))) {
    const time = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return { type: "time", reply: `Es ist ${time} Uhr.` };
  }

  if (/(welches datum|welcher tag|heutiges datum|datum heute)/.test(t)) {
    const date = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return { type: "date", reply: `Heute ist ${date}.` };
  }

  m = text.match(/^(?:oeffne|öffne|starte|geh zu)\s+(.+)/i);
  if (m && m[1]) {
    const url = resolveSiteUrl(m[1]);
    if (url) {
      if (ctx.openUrl) ctx.openUrl(url);
      return { type: "open", reply: `Ich oeffne ${m[1].trim()} fuer dich.`, url };
    }
  }

  m = text.match(/(?:suche(?:n)? (?:im internet )?nach|google)\s+(.+)/i);
  if (m && m[1]) {
    const query = m[1].trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    if (ctx.openUrl) ctx.openUrl(url);
    return { type: "search", reply: `Ich suche im Internet nach "${query}".`, url };
  }

  m = text.match(/wetter(?: in| fuer| für)?\s+(.+)/i);
  if (m && m[1] && ctx.fetchImpl) {
    const city = m[1].trim();
    try {
      const report = await fetchWeather(city, ctx.fetchImpl);
      return { type: "weather", reply: `Das Wetter: ${report}` };
    } catch {
      return {
        type: "weather",
        reply: `Ich konnte das Wetter fuer ${city} gerade nicht abrufen. Vielleicht ist keine Internetverbindung da.`,
      };
    }
  }

  if (/(erzaehl(e)? (mir )?einen witz|witz bitte|mach (mal )?(ei nen |einen )?witz)/.test(t.replace(/ä/g, "ae"))) {
    return { type: "joke", reply: pick(JOKES, ctx.rng) };
  }

  const mathReply = mathIntent(text);
  if (mathReply) return { type: "math", reply: mathReply };

  if (/(was kannst du|hilfe|welche befehle|was fuer befehle)/.test(t.replace(/ä/g, "ae"))) {
    return {
      type: "help",
      reply:
        "Ich kann zum Beispiel: die Uhrzeit oder das Datum nennen, eine Website oeffnen, im Internet suchen, das Wetter nennen, rechnen, Witze erzaehlen, mir Dinge merken oder wieder vergessen — und mit 'Stop' unterbreche ich mich sofort.",
    };
  }

  return null;
}
