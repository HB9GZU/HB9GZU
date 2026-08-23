// Cat-Bot Avatar — läuft komplett im Browser.
// Tracking: MediaPipe Tasks Vision (Face/Hand/Pose Landmarker, echte ML-Modelle).
// Sprache: Web Speech API (SpeechRecognition + SpeechSynthesis, native Browser-Engines).
// Dialog: lokaler Regel-Responder mit optionalem Hook auf einen eigenen Server (siehe unten).

import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
const video = $("cam");
const overlay = $("camOverlay");
const overlayCtx = overlay.getContext("2d");
const avatarCanvas = $("avatar");
const actx = avatarCanvas.getContext("2d");
const startBtn = $("startBtn");
const statusPill = $("statusPill");
const subtitle = $("subtitle");
const logEl = $("log");

const metrics = {
  frame: $("mFrame"),
  face: $("mFace"),
  hands: $("mHands"),
  state: $("mState"),
  asr: $("mAsr"),
};

// ---------------------------------------------------------------------------
// Optionaler Hook für eine echte LLM-Anbindung.
// Standard: lokaler Regel-Responder (kein Server, keine Keys nötig).
// Wer echte Konversation will, setzt window.CATBOT_LLM_ENDPOINT auf einen
// eigenen Server, der z.B. die Claude API serverseitig aufruft (Key bleibt
// dort, nie im Browser). Erwartet: POST {text} -> {reply}.
// ---------------------------------------------------------------------------
async function getBotReply(userText) {
  if (window.CATBOT_LLM_ENDPOINT) {
    try {
      const res = await fetch(window.CATBOT_LLM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: userText }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.reply === "string") return data.reply;
      }
    } catch (e) {
      console.warn("LLM endpoint failed, falling back to rule responder", e);
    }
  }
  return ruleResponder(userText);
}

function ruleResponder(text) {
  const t = text.toLowerCase().trim();
  const greetWords = ["hallo", "hi", "hey", "servus", "grüezi", "guten tag"];
  const byeWords = ["tschüss", "ciao", "bye", "auf wiedersehen"];
  const nameWords = ["wie heisst du", "wie heißt du", "dein name"];
  const howAreYou = ["wie geht", "wie gehts", "wie geht's"];

  if (greetWords.some((w) => t.includes(w))) {
    return pick(["Hallo! Schön, dass du da bist.", "Miau! Hi!", "Hey, ich höre dir zu."]);
  }
  if (byeWords.some((w) => t.includes(w))) {
    return pick(["Bis bald!", "Tschüss, war schön mit dir zu reden.", "Man sieht sich!"]);
  }
  if (nameWords.some((w) => t.includes(w))) {
    return "Ich bin Cat-Bot, dein Kamera-Avatar.";
  }
  if (howAreYou.some((w) => t.includes(w))) {
    return "Mir geht's gut, danke! Und dir?";
  }
  if (t.endsWith("?")) {
    return `Gute Frage. Du hast gefragt: "${text}" — sag mir mehr dazu.`;
  }
  if (t.length < 3) {
    return "Kannst du das etwas ausführlicher sagen?";
  }
  return pick([
    `Verstehe: "${text}". Erzähl mir mehr.`,
    "Interessant, sprich weiter.",
    `Du meinst also "${text}"?`,
  ]);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Logging / UI helpers
// ---------------------------------------------------------------------------
function log(role, text) {
  const line = document.createElement("div");
  line.className = role;
  const label = role === "me" ? "Du" : role === "bot" ? "Cat-Bot" : "System";
  line.textContent = `${label}: ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setPill(state) {
  statusPill.className = "pill " + state;
  const labels = {
    idle: "bereit",
    listening: "hört zu",
    speaking: "spricht",
    error: "Fehler",
  };
  statusPill.textContent = labels[state] || state;
  metrics.state.textContent = state;
}

// ---------------------------------------------------------------------------
// Avatar-Zustand — wird vom Tracking + von der Sprache getrieben.
// ---------------------------------------------------------------------------
const avatarState = {
  yaw: 0, pitch: 0, roll: 0,
  blinkL: 0, blinkR: 0,
  mouthOpen: 0, smile: 0,
  browUp: 0,
  pawX: null, pawY: null, pawVisible: false,
  breathing: 0,
  idleBlinkTimer: 0,
  lastAutoBlink: performance.now(),
};

function drawAvatar(t) {
  const w = avatarCanvas.width, h = avatarCanvas.height;
  actx.clearRect(0, 0, w, h);

  avatarState.breathing = Math.sin(t / 900) * 3;

  const cx = w / 2 + avatarState.yaw * 40;
  const cy = h / 2 + avatarState.pitch * 30 + avatarState.breathing;
  const roll = avatarState.roll;

  actx.save();
  actx.translate(cx, cy);
  actx.rotate(roll);

  // Ohren
  actx.fillStyle = "#3a3f52";
  drawEarTriangle(-90, -150, 40);
  drawEarTriangle(90, -150, 40, true);

  // Kopf
  const headR = 150;
  actx.beginPath();
  actx.fillStyle = "#eab676";
  actx.ellipse(0, 0, headR, headR * 0.92, 0, 0, Math.PI * 2);
  actx.fill();

  // Wangen-Streifen (Katzen-Look)
  actx.strokeStyle = "rgba(0,0,0,0.15)";
  actx.lineWidth = 2;
  for (let i = -1; i <= 1; i += 2) {
    for (let j = 0; j < 3; j++) {
      actx.beginPath();
      actx.moveTo(i * 60, 20 + j * 12);
      actx.lineTo(i * 130, 10 + j * 12);
      actx.stroke();
    }
  }

  // Augen (Blink von Blendshapes gesteuert)
  drawEye(-55, -10, avatarState.blinkL);
  drawEye(55, -10, avatarState.blinkR);

  // Augenbrauen
  actx.strokeStyle = "#5a3c1e";
  actx.lineWidth = 4;
  const browY = -55 - avatarState.browUp * 15;
  actx.beginPath(); actx.moveTo(-80, browY); actx.lineTo(-30, browY - 6); actx.stroke();
  actx.beginPath(); actx.moveTo(30, browY - 6); actx.lineTo(80, browY); actx.stroke();

  // Nase
  actx.fillStyle = "#c76a5b";
  actx.beginPath();
  actx.moveTo(-8, 30); actx.lineTo(8, 30); actx.lineTo(0, 42);
  actx.closePath(); actx.fill();

  // Mund (öffnet mit mouthOpen, Lächeln mit smile)
  const mouthW = 40 + avatarState.smile * 20;
  const mouthH = 6 + avatarState.mouthOpen * 55;
  actx.fillStyle = "#5a2a20";
  actx.beginPath();
  actx.ellipse(0, 60, mouthW, mouthH, 0, 0, Math.PI * 2);
  actx.fill();

  // Schnurrhaare
  actx.strokeStyle = "rgba(60,50,40,0.6)";
  actx.lineWidth = 2;
  for (let i = -1; i <= 1; i++) {
    actx.beginPath(); actx.moveTo(-40, 35 + i * 10); actx.lineTo(-140, 30 + i * 14); actx.stroke();
    actx.beginPath(); actx.moveTo(40, 35 + i * 10); actx.lineTo(140, 30 + i * 14); actx.stroke();
  }

  actx.restore();

  // Pfote (Hand-Tracking)
  if (avatarState.pawVisible && avatarState.pawX != null) {
    const px = avatarState.pawX * w;
    const py = avatarState.pawY * h;
    actx.fillStyle = "#eab676";
    actx.beginPath();
    actx.ellipse(px, py, 26, 22, 0, 0, Math.PI * 2);
    actx.fill();
    actx.fillStyle = "#5a2a20";
    for (const dx of [-14, 0, 14]) {
      actx.beginPath();
      actx.ellipse(px + dx, py - 20, 6, 8, 0, 0, Math.PI * 2);
      actx.fill();
    }
  }
}

function drawEarTriangle(x, y, size, mirror = false) {
  actx.beginPath();
  actx.moveTo(x - size * (mirror ? -1 : 1), y + size);
  actx.lineTo(x, y - size);
  actx.lineTo(x + size * 0.6 * (mirror ? -1 : 1), y + size);
  actx.closePath();
  actx.fill();
}

function drawEye(x, y, blink) {
  const openness = Math.max(0, 1 - blink);
  actx.fillStyle = "#fff";
  actx.beginPath();
  actx.ellipse(x, y, 22, 16 * openness + 1, 0, 0, Math.PI * 2);
  actx.fill();
  if (openness > 0.1) {
    actx.fillStyle = "#2c2c2c";
    actx.beginPath();
    actx.ellipse(x, y, 9, 9 * openness, 0, 0, Math.PI * 2);
    actx.fill();
  }
}

function autoBlinkTick(now) {
  if (!faceDetectedRecently()) {
    if (now - avatarState.lastAutoBlink > 4000 + Math.random() * 3000) {
      avatarState.lastAutoBlink = now;
      triggerBlink();
    }
  }
}

let blinkAnim = null;
function triggerBlink() {
  if (blinkAnim) return;
  const start = performance.now();
  blinkAnim = requestAnimationFrame(function step(t) {
    const p = (t - start) / 220;
    if (p >= 1) {
      avatarState.blinkL = avatarState.blinkR = 0;
      blinkAnim = null;
      return;
    }
    const v = p < 0.5 ? p * 2 : (1 - p) * 2;
    avatarState.blinkL = avatarState.blinkR = v;
    blinkAnim = requestAnimationFrame(step);
  });
}

let lastFaceTs = 0;
function faceDetectedRecently() {
  return performance.now() - lastFaceTs < 500;
}

// ---------------------------------------------------------------------------
// MediaPipe Tracking-Pipeline
// ---------------------------------------------------------------------------
let faceLandmarker, handLandmarker, poseLandmarker;
let trackingRunning = false;

async function initTrackers() {
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO",
    numFaces: 1,
  });

  handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });

  poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

function blendshapeValue(categories, name) {
  const c = categories?.find((c) => c.categoryName === name);
  return c ? c.score : 0;
}

function matrixToEuler(m) {
  // m ist eine 4x4 Spalten-Major-Matrix (Float32Array, Länge 16)
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r21 = m[6], r22 = m[10];
  const yaw = Math.atan2(-r20, Math.sqrt(r00 * r00 + r10 * r10));
  const pitch = Math.atan2(r21, r22);
  const roll = Math.atan2(r10, r00);
  return { yaw, pitch, roll };
}

function processTrackingResults(now) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const faceRes = faceLandmarker.detectForVideo(video, now);
  const handRes = handLandmarker.detectForVideo(video, now);
  const poseRes = poseLandmarker.detectForVideo(video, now);

  // Gesicht
  if (faceRes.faceLandmarks && faceRes.faceLandmarks.length > 0) {
    lastFaceTs = now;
    metrics.face.textContent = "ja";

    const bs = faceRes.faceBlendshapes?.[0]?.categories;
    avatarState.blinkL = blendshapeValue(bs, "eyeBlinkLeft");
    avatarState.blinkR = blendshapeValue(bs, "eyeBlinkRight");
    avatarState.mouthOpen = blendshapeValue(bs, "jawOpen");
    avatarState.smile =
      (blendshapeValue(bs, "mouthSmileLeft") + blendshapeValue(bs, "mouthSmileRight")) / 2;
    avatarState.browUp = blendshapeValue(bs, "browInnerUp");

    const mats = faceRes.facialTransformationMatrixes;
    if (mats && mats[0]) {
      const { yaw, pitch, roll } = matrixToEuler(mats[0].data);
      avatarState.yaw = clamp(yaw, -1, 1);
      avatarState.pitch = clamp(pitch, -1, 1);
      avatarState.roll = clamp(roll, -0.5, 0.5);
    }

    drawFaceOverlay(faceRes.faceLandmarks[0]);
  } else {
    metrics.face.textContent = "nein";
  }

  // Hände
  if (handRes.landmarks && handRes.landmarks.length > 0) {
    metrics.hands.textContent = String(handRes.landmarks.length);
    avatarState.pawVisible = true;
    const wrist = handRes.landmarks[0][0];
    avatarState.pawX = 1 - wrist.x; // gespiegelt, passend zur Video-Spiegelung
    avatarState.pawY = wrist.y;
    for (const hand of handRes.landmarks) drawHandOverlay(hand);
  } else {
    metrics.hands.textContent = "0";
    avatarState.pawVisible = false;
  }

  // Pose (Overlay only — Skelett fürs Tracking-Bild)
  if (poseRes.landmarks && poseRes.landmarks.length > 0) {
    drawPoseOverlay(poseRes.landmarks[0]);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function drawFaceOverlay(landmarks) {
  overlayCtx.fillStyle = "rgba(255,159,67,0.8)";
  for (const p of landmarks) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x * overlay.width, p.y * overlay.height, 1, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

function drawHandOverlay(landmarks) {
  overlayCtx.strokeStyle = "rgba(108,140,255,0.9)";
  overlayCtx.fillStyle = "rgba(108,140,255,0.9)";
  overlayCtx.lineWidth = 2;
  const connections = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];
  for (const [a, b] of connections) {
    const pa = landmarks[a], pb = landmarks[b];
    overlayCtx.beginPath();
    overlayCtx.moveTo(pa.x * overlay.width, pa.y * overlay.height);
    overlayCtx.lineTo(pb.x * overlay.width, pb.y * overlay.height);
    overlayCtx.stroke();
  }
  for (const p of landmarks) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x * overlay.width, p.y * overlay.height, 3, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

function drawPoseOverlay(landmarks) {
  overlayCtx.strokeStyle = "rgba(61,220,151,0.8)";
  overlayCtx.lineWidth = 2;
  const connections = [
    [11,12],[11,13],[13,15],[12,14],[14,16],
    [11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],
  ];
  for (const [a, b] of connections) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!pa || !pb) continue;
    overlayCtx.beginPath();
    overlayCtx.moveTo(pa.x * overlay.width, pa.y * overlay.height);
    overlayCtx.lineTo(pb.x * overlay.width, pb.y * overlay.height);
    overlayCtx.stroke();
  }
}

function trackingLoop() {
  if (!trackingRunning) return;
  const frameStart = performance.now();
  processTrackingResults(frameStart);
  const frameTime = performance.now() - frameStart;
  metrics.frame.textContent = `${frameTime.toFixed(1)} ms`;
  requestAnimationFrame(trackingLoop);
}

function avatarLoop(t) {
  autoBlinkTick(t);
  drawAvatar(t);
  requestAnimationFrame(avatarLoop);
}

// ---------------------------------------------------------------------------
// Sprache: kontinuierliches ASR + TTS mit Barge-In
// ---------------------------------------------------------------------------
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isSpeaking = false;
let currentUtterance = null;
let finalizeTimer = null;
let pendingTranscript = "";

function initSpeech() {
  if (!SpeechRecognitionCtor) {
    log("sys", "Web Speech API (ASR) wird von diesem Browser nicht unterstützt. Nutze Chrome/Edge.");
    metrics.asr.textContent = "nicht verfügbar";
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "de-DE";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }

    // Barge-In: sobald der Nutzer spricht, TTS sofort abbrechen.
    if (isSpeaking && (interim.trim() || final.trim())) {
      window.speechSynthesis.cancel();
      isSpeaking = false;
      setPill("listening");
      triggerBlink();
    }

    if (interim) subtitle.textContent = interim;

    if (final.trim()) {
      pendingTranscript += (pendingTranscript ? " " : "") + final.trim();
      subtitle.textContent = pendingTranscript;
      clearTimeout(finalizeTimer);
      // kurze Pause nach Satzende abwarten, dann Antwort starten (<400ms Ziel)
      finalizeTimer = setTimeout(() => handleUserUtterance(pendingTranscript), 350);
    }
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    console.warn("ASR error", e.error);
  };

  recognition.onend = () => {
    // Dauerschleife: ASR läuft immer, auch während der Avatar spricht.
    if (trackingRunning) {
      try { recognition.start(); } catch (_) { /* schon aktiv */ }
    }
  };

  recognition.start();
  metrics.asr.textContent = "aktiv";
  setPill("listening");
}

async function handleUserUtterance(text) {
  pendingTranscript = "";
  subtitle.textContent = "";
  log("me", text);

  const reply = await getBotReply(text);
  speak(reply);
}

function speak(text) {
  if (!window.speechSynthesis) {
    log("sys", "TTS nicht verfügbar in diesem Browser.");
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "de-DE";
  utter.rate = 1.0;

  utter.onstart = () => {
    isSpeaking = true;
    setPill("speaking");
    log("bot", text);
    subtitle.textContent = text;
  };
  utter.onboundary = () => {
    // grobe Lippen-Synchronisation über Wortgrenzen
    pulseMouth();
  };
  utter.onend = () => {
    isSpeaking = false;
    setPill("listening");
    subtitle.textContent = "";
    avatarState.mouthOpen = 0;
  };
  utter.onerror = () => {
    isSpeaking = false;
    setPill("listening");
  };

  currentUtterance = utter;
  window.speechSynthesis.speak(utter);
}

let mouthPulseAnim = null;
function pulseMouth() {
  if (mouthPulseAnim) cancelAnimationFrame(mouthPulseAnim);
  const start = performance.now();
  const target = 0.3 + Math.random() * 0.5;
  function step(t) {
    const p = (t - start) / 140;
    if (p >= 1) {
      avatarState.mouthOpen = faceDetectedRecently() ? avatarState.mouthOpen : 0;
      mouthPulseAnim = null;
      return;
    }
    const v = p < 0.5 ? p * 2 : (1 - p) * 2;
    if (!faceDetectedRecently()) avatarState.mouthOpen = v * target;
    mouthPulseAnim = requestAnimationFrame(step);
  }
  mouthPulseAnim = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Starte…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;

    log("sys", "Lade Tracking-Modelle…");
    await initTrackers();
    log("sys", "Tracking bereit.");

    trackingRunning = true;
    trackingLoop();
    requestAnimationFrame(avatarLoop);

    initSpeech();
    speak("Hallo, ich höre dir jetzt zu.");

    startBtn.textContent = "Läuft";
  } catch (err) {
    console.error(err);
    setPill("error");
    log("sys", `Fehler beim Start: ${err.message}`);
    startBtn.disabled = false;
    startBtn.textContent = "Erneut versuchen";
  }
});

setPill("idle");
