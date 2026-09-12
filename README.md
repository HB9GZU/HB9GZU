# Cat-Bot — Jarvis-Modus

Ein lauffähiger Browser-Prototyp: Kamera-Tracking (Gesicht / Hände / Pose) plus
freihändige Sprachinteraktion, gerendert als animierter Katzen-Avatar — jetzt
mit einem "Jarvis"-artigen Skill-System obendrauf. Reines Frontend, kein
Build-Schritt, kein Server nötig.

## Jarvis-Funktionen

Inspiriert von [isair/jarvis](https://github.com/isair/jarvis) (Wake-Word
irgendwo im Satz, lokale Werkzeuge vor LLM-Fallback, automatische Redaktion,
persistentes Gedächtnis) und
[rajkishorbgp/JARVIS-AI-Assistant](https://github.com/rajkishorbgp/JARVIS-AI-Assistant)
(einfache Sprachbefehle wie Website öffnen, Uhrzeit nennen, Web-Suche) — auf
das reduziert, was im Browser ohne Server/API-Keys tatsächlich sauber
umsetzbar ist:

- **Wake-Word**: Standardmäßig reagiert der Assistent nur, wenn sein Name
  (Standard "Jarvis", änderbar) irgendwo im Satz vorkommt — lässt sich in den
  Einstellungen abschalten, um wie zuvor auf jede Aussage zu reagieren.
- **Lokale Skills** (laufen ohne LLM/Server, siehe `skills.js`):
  Uhrzeit, Datum, Website öffnen ("öffne YouTube"), Web-Suche ("suche nach…"),
  Wetter (`wttr.in`, kein API-Key nötig), ein sicherer Taschenrechner (kein
  `eval`), Witze, sowie ein einfaches Gedächtnis ("merke dir, dass…" /
  "was weißt du noch?" / "vergiss alles").
- **Sofort-Stop**: "Stop" (per Sprache oder Button) unterbricht die
  Sprachausgabe augenblicklich — zusätzlich zum bestehenden Barge-In, das
  jede erkannte Nutzeräußerung während der Ausgabe sofort abbricht.
- **Automatische Redaktion**: E-Mail-Adressen, Tokens/JWTs und lange
  Zahlenfolgen werden vor dem Speichern in Gedächtnis/Chatverlauf entfernt.
- **Persistenter Chatverlauf**: Das Gespräch überlebt einen Seiten-Reload
  (localStorage, redigiert, auf die letzten 200 Einträge begrenzt).
- **Einstellungen-Panel**: Assistenten-Name, Wake-Word an/aus, Sprache
  (Deutsch/Englisch), eigener LLM-Endpoint — alles ohne Build/Server direkt
  in der UI, persistiert in localStorage.
- **Robuster Tracking-Fallback**: Ist das MediaPipe-CDN nicht erreichbar
  (Firewall, offline), läuft die Kamera ohne Gesichts-/Hand-Tracking weiter —
  Sprache und Skills funktionieren unabhängig davon.

Skill-Reihenfolge bei jeder Äußerung: lokale Jarvis-Skills →
optionaler eigener LLM-Endpoint → einfacher Regel-Responder als letzter
Fallback.

## Starten

Kamera und Mikrofon funktionieren im Browser nur über HTTPS oder `localhost`.
Einfach lokal ausliefern, z. B.:

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000` in **Chrome oder Edge** öffnen (Web Speech API
ist dort am zuverlässigsten implementiert; Firefox/Safari unterstützen die
ASR-Seite nicht vollständig). Auf "Starten" klicken und Kamera-/Mikrofon-
Berechtigung erteilen.

## Was hier technisch passiert

- **Tracking**: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision)
  läuft clientseitig im Browser (WASM/WebGL) und liefert pro Frame:
  - Face Landmarker: 478 Face-Landmarks, 52 ARKit-kompatible Blendshapes,
    6-DoF-Kopfpose (Transformationsmatrix) — treibt Blinzeln, Mundform,
    Augenbrauen und Kopfdrehung des Avatars.
  - Hand Landmarker: 21 Landmarks pro Hand — treibt die Pfoten-Anzeige.
  - Pose Landmarker: Oberkörper-Skelett, als Overlay im Kamerabild.
  Modelle werden von Googles öffentlichem MediaPipe-CDN geladen.
- **Sprache**: native `SpeechRecognition` (kontinuierlich, mit Zwischenergebnissen)
  und `SpeechSynthesis` des Browsers. Barge-In ist implementiert: sobald ASR
  während der TTS-Ausgabe Sprache erkennt, wird `speechSynthesis.cancel()`
  sofort ausgelöst.
- **Dialog**: ein einfacher, lokaler Regel-Responder (`ruleResponder` in
  `app.js`) — keine Cloud-KI, keine API-Keys nötig. Für echte Konversation
  siehe unten.

## Was in der ursprünglichen Anforderung nicht realistisch war

Die Ausgangs-Spec forderte ein "fotorealistisches, von echtem Video nicht
unterscheidbares" Avatar-System mit Werten wie <80 ms End-to-End-Latenz für
volle 3D-Rekonstruktion, <50 ms Barge-In, physikalisch simulierter
Sekundärbewegung (Haare, Kleidung, Haut) usw. Das sind Zielwerte aus
Marketing-Sprache, keine mit Browser-Bordmitteln erreichbaren Ingenieurswerte.
Was diese App stattdessen tatsächlich liefert:

- Echtes ML-Tracking (kein Fake), aber ein stilisierter Cartoon-Avatar statt
  Fotorealismus.
- Sprach-Timing hängt von der jeweiligen Browser-Engine ab (typischerweise
  einige hundert ms für ASR-Finalisierung, TTS-Start), nicht garantiert <400 ms.
- Kein Voice-Activity-Detection-Modell mit <100 ms-Garantie — genutzt wird die
  interim/final-Erkennung des Browsers.
- Keine echte Physik-Engine (Verlet/PBD) für Sekundärbewegung; Blinzeln/Atmen
  sind einfache Canvas-Animationen.

## Eigene KI-Anbindung (optional)

Der Dialog ist absichtlich austauschbar. Um echte LLM-Antworten (z. B. über
die Claude API) zu nutzen, **niemals den API-Key im Browser einbetten**.
Stattdessen einen eigenen kleinen Server bauen, der:

1. `POST { text }` entgegennimmt,
2. serverseitig die Claude API aufruft (Key bleibt dort),
3. `{ reply }` zurückgibt.

Dann vor dem Laden von `app.js` setzen:

```html
<script>window.CATBOT_LLM_ENDPOINT = "https://dein-server.example/chat";</script>
```

Die App nutzt den Endpoint automatisch, sobald er gesetzt ist, und fällt bei
Fehlern auf den lokalen Regel-Responder zurück.

## Tests

```bash
# Reine Logik (Wake-Word, Redaktion, Rechnen, Gedächtnis, Skill-Dispatcher) — Node, keine Abhängigkeiten
node --test test/skills.test.mjs

# Voller Browser-Smoke-Test (echtes headless Chromium, simulierte Web-Speech-APIs)
node test/e2e.mjs
```

`test/e2e.mjs` startet einen kleinen lokalen Static-File-Server, öffnet die
Seite in Chromium (mit Fake-Kamera/Mikrofon), mockt `SpeechRecognition` und
`speechSynthesis` (da echte Sprach-Engines headless nicht verfügbar sind) und
prüft den kompletten Fluss End-to-End: Wake-Word-Gate, alle Skills, Barge-In,
Einstellungen-Persistenz und den Tracking-Fallback bei nicht erreichbarem
MediaPipe-CDN.

Der Test braucht Playwright (`npm i -D playwright` in einer eigenen
Umgebung, falls nicht schon global vorhanden). Liegt es an einem anderen Pfad
als `node_modules/playwright`, per `PLAYWRIGHT_MODULE_PATH=/pfad/zu/playwright
node test/e2e.mjs` überschreiben.

## Dateien

- `index.html` — Layout (Kamera-Panel, Avatar-Panel, Status/Chat/Einstellungen-Panel)
- `style.css` — Styling
- `app.js` — Tracking-Pipeline, Avatar-Rendering, Sprachlogik, Einstellungen
- `skills.js` — DOM-freie Jarvis-Skill-Logik (Wake-Word, Redaktion, Rechnen, Gedächtnis, Intents)
- `test/skills.test.mjs` — Node-Unit-Tests für `skills.js`
- `test/e2e.mjs` — Playwright-Smoke-Test für die komplette Seite
