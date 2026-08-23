# Cat-Bot Avatar

Ein lauffähiger Browser-Prototyp: Kamera-Tracking (Gesicht / Hände / Pose) plus
freihändige Sprachinteraktion, gerendert als animierter Katzen-Avatar. Reines
Frontend, kein Build-Schritt, kein Server nötig.

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

## Dateien

- `index.html` — Layout (Kamera-Panel, Avatar-Panel, Status/Chat-Panel)
- `style.css` — Styling
- `app.js` — Tracking-Pipeline, Avatar-Rendering, Sprachlogik
