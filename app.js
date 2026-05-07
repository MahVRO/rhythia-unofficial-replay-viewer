// DOM map for index.html ids.
// If markup moves, update this in one pass.
const els = {
  fileInput: document.getElementById("fileInput"),
  openFile: document.getElementById("openFile"),
  viewerSettingsBtn: document.getElementById("viewerSettingsBtn"),
  audioControlBtn: document.getElementById("audioControlBtn"),
  audioPopup: document.getElementById("audioPopup"),
  musicVolumeSlider: document.getElementById("musicVolumeSlider"),
  hitsoundVolumeSlider: document.getElementById("hitsoundVolumeSlider"),
  settingsPanel: document.getElementById("settingsPanel"),
  setHighlightMisses: document.getElementById("setHighlightMisses"),
  setShowFps: document.getElementById("setShowFps"),
  setReactionTime: document.getElementById("setReactionTime"),
  setReactionTimeVal: document.getElementById("setReactionTimeVal"),
  setShowHud: document.getElementById("setShowHud"),
  setShowCursor: document.getElementById("setShowCursor"),
  setShowNotes: document.getElementById("setShowNotes"),
  setTabMain: document.getElementById("setTabMain"),
  setTabMarkers: document.getElementById("setTabMarkers"),
  setTabCustomize: document.getElementById("setTabCustomize"),
  settingsMainPanel: document.getElementById("settingsMainPanel"),
  settingsMarkersPanel: document.getElementById("settingsMarkersPanel"),
  settingsCustomizePanel: document.getElementById("settingsCustomizePanel"),
  setMarkerMisses: document.getElementById("setMarkerMisses"),
  setMarkerPauses: document.getElementById("setMarkerPauses"),
  setSidePanelOpacity: document.getElementById("setSidePanelOpacity"),
  setSidePanelOpacityVal: document.getElementById("setSidePanelOpacityVal"),
  setAudioOffset: document.getElementById("setAudioOffset"),
  setAudioOffsetVal: document.getElementById("setAudioOffsetVal"),
  setCursorColor: document.getElementById("setCursorColor"),
  setNotesColor: document.getElementById("setNotesColor"),
  canvas: document.getElementById("view"),
  playPause: document.getElementById("playPause"),
  speedCurrent: document.getElementById("speedCurrent"),
  speedInput: document.getElementById("speedInput"),
  speedDown: document.getElementById("speedDown"),
  speedUp: document.getElementById("speedUp"),
  seek: document.getElementById("seek"),
  seekMarkers: document.getElementById("seekMarkers"),
  timeLabel: document.getElementById("timeLabel"),
  // top bar
  songName: document.getElementById("songName"),
  progressFill: document.getElementById("progressFill"),
  // left panel
  comboVal: document.getElementById("comboVal"),
  pauseVal: document.getElementById("pauseVal"),
  rankVal: document.getElementById("rankVal"),
  accVal: document.getElementById("accVal"),
  // right panel
  scoreVal: document.getElementById("scoreVal"),
  pointsVal: document.getElementById("pointsVal"),
  missVal: document.getElementById("missVal"),
  noteCountVal: document.getElementById("noteCountVal"),
  // bottom bar
  healthFill: document.getElementById("healthFill"),
  modsRow: document.getElementById("modsRow"),
  // misc
};

const ctx = els.canvas.getContext("2d");

// Runtime state.
// Timeline values are milliseconds.
const state = {
  replay: null,
  isPlaying: false,
  currentMs: 0,
  durationMs: 0,
  speed: 1,
  lastTick: 0,
  audio: null,           // HTMLAudioElement when a map's audio is loaded
  audioUrl: null,        // current object URL (for revoke on swap)
  audioReady: false,
  audioTimeScale: 1,     // playbackRate multiplier so song-time tracks replay-time
  gracePreMs: 400,       // silence before the first note
  gracePostMs: 2000,     // silence after the last note / song end
  pauseCount: 0,         // user-triggered pauses during playback
  lastMissCount: 0,      // edge detector for the miss flash effect
  missFlashAt: 0,        // performance.now() of the most recent new miss
  mapUrl: null,          // active map URL for song-title click target
  songTitleHover: false,
  songTitleHitbox: null,
  playfieldHitbox: null,
  dragFileOverWindow: false,
  dragFileOverGrid: false,
  loadingActive: false,
  loadingLabel: "",
  loadingProgress: 0,
  fpsSmoothed: 0,
  viewerSettings: null,
  settingsOpen: false,
  settingsTab: "main",
  audioPopupOpen: false,
  musicVolume: 1.0,      // 0.0 to 1.0
  hitsoundVolume: 1.0,   // 0.0 to 1.0 (for future hitsound effects)
  hitsoundPlayers: [],
  hitsoundPlayerIndex: 0,
  lastJudgedNoteIndex: -1,
  lastReplayMsForHitsound: 0,
};

const VIEWER_SETTINGS_KEY = "rvViewerSettingsV2";
const DEFAULT_STAGE_BG = "rgb(5, 10, 15)";
const RHR_MAGIC = 20260222;
const RHR_FRAME_STRIDE_BYTES = 17;
const NOTE_HIT_TOLERANCE_MS = 60;
const PAUSE_GAP_MS = 120;
const AUDIO_DRIFT_RESYNC_SEC = 0.12;
const DEFAULT_HITSOUND_URL = "assets/audio/default_hitsound.mp3";
// Keep this in one place so endpoint swaps are easy.
const RHYTHIA_API_BEATMAP_PAGE_URL = "https://production.rhythia.com/api/getBeatmapPage";
const DEFAULT_VIEWER_SETTINGS = {
  highlightMisses: true,
  showFps: false,
  reactionTimeMs: 500,
  showHud: true,
  showCursor: true,
  showNotes: true,
  markerMisses: true,
  markerPauses: false,
  sidePanelOpacity: 0.5,
  cursorColor: "#ffffff",
  notesColor: "#6ec3ff",
  musicVolume: 1.0,
  hitsoundVolume: 1.0,
  audioOffsetMs: 0,
};

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function normalizeHexColor(value, fallback) {
  const str = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(str) ? str.toLowerCase() : fallback;
}

function hexToRgb(value) {
  const hex = normalizeHexColor(value, "#ffffff").slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function initHitsoundPool() {
  const poolSize = 10;
  state.hitsoundPlayers = [];
  state.hitsoundPlayerIndex = 0;
  for (let i = 0; i < poolSize; i++) {
    const a = new Audio(DEFAULT_HITSOUND_URL);
    a.preload = "auto";
    a.volume = clamp(state.hitsoundVolume, 0, 1);
    state.hitsoundPlayers.push(a);
  }
}

function playHitsound() {
  if (!state.hitsoundPlayers.length) return;
  const volume = clamp(state.hitsoundVolume, 0, 1);
  if (volume <= 0) return;
  const idx = state.hitsoundPlayerIndex % state.hitsoundPlayers.length;
  const a = state.hitsoundPlayers[idx];
  state.hitsoundPlayerIndex = (idx + 1) % state.hitsoundPlayers.length;
  try {
    a.pause();
    a.currentTime = 0;
    a.volume = volume;
    a.play().catch(() => {});
  } catch {}
}

function loadViewerSettings() {
  try {
    const raw = localStorage.getItem(VIEWER_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_VIEWER_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      highlightMisses: parsed.highlightMisses !== false,
      showFps: !!parsed.showFps,
      reactionTimeMs: clamp(Number(parsed.reactionTimeMs) || DEFAULT_VIEWER_SETTINGS.reactionTimeMs, 200, 1200),
      showHud: parsed.showHud !== false,
      showCursor: parsed.showCursor !== false,
      showNotes: parsed.showNotes !== false,
      markerMisses: parsed.markerMisses !== false,
      markerPauses: parsed.markerPauses !== false,
      sidePanelOpacity: Number.isFinite(Number(parsed.sidePanelOpacity))
        ? clamp(Number(parsed.sidePanelOpacity), 0, 1)
        : DEFAULT_VIEWER_SETTINGS.sidePanelOpacity,
      cursorColor: normalizeHexColor(parsed.cursorColor, DEFAULT_VIEWER_SETTINGS.cursorColor),
      notesColor: normalizeHexColor(parsed.notesColor, DEFAULT_VIEWER_SETTINGS.notesColor),
      musicVolume: Number.isFinite(Number(parsed.musicVolume))
        ? clamp(Number(parsed.musicVolume), 0, 1)
        : DEFAULT_VIEWER_SETTINGS.musicVolume,
      hitsoundVolume: Number.isFinite(Number(parsed.hitsoundVolume))
        ? clamp(Number(parsed.hitsoundVolume), 0, 1)
        : DEFAULT_VIEWER_SETTINGS.hitsoundVolume,
      audioOffsetMs: Number.isFinite(Number(parsed.audioOffsetMs))
        ? clamp(Number(parsed.audioOffsetMs), -1000, 1000)
        : DEFAULT_VIEWER_SETTINGS.audioOffsetMs,
    };
  } catch {
    return { ...DEFAULT_VIEWER_SETTINGS };
  }
}

function saveViewerSettings() {
  try {
    localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(state.viewerSettings));
  } catch {
    // Ignore storage failures and keep runtime settings.
  }
}

state.viewerSettings = loadViewerSettings();

const RAW_FRAME_MS = 1000 / 60;

function ensureRemainingBytes(view, off, needed, label) {
  if (off + needed > view.byteLength) {
    throw new Error(`Malformed replay: unexpected end of file while reading ${label}.`);
  }
}

function readU8(view, off) {
  return view.getUint8(off);
}

function readU32(view, off) {
  return view.getUint32(off, true);
}

function readI32(view, off) {
  return view.getInt32(off, true);
}

function readU64(view, off) {
  const low = BigInt(view.getUint32(off, true));
  const high = BigInt(view.getUint32(off + 4, true));
  return (high << 32n) | low;
}

function readI64(view, off) {
  const low = BigInt(view.getUint32(off, true));
  const high = BigInt(view.getInt32(off + 4, true));
  return (high << 32n) | low;
}

function readF32(view, off) {
  return view.getFloat32(off, true);
}

function readStr8(view, offObj) {
  ensureRemainingBytes(view, offObj.off, 1, "string length");
  const len = readU8(view, offObj.off);
  offObj.off += 1;
  ensureRemainingBytes(view, offObj.off, len, "string payload");
  const bytes = new Uint8Array(view.buffer, offObj.off, len);
  offObj.off += len;
  return new TextDecoder().decode(bytes);
}

function parseRhr(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error("Malformed replay: expected binary ArrayBuffer input.");
  }

  const view = new DataView(buffer);
  const offObj = { off: 0 };

  ensureRemainingBytes(view, offObj.off, 4, "magic");
  const magic = readU32(view, offObj.off);
  offObj.off += 4;
  if (magic !== RHR_MAGIC) {
    throw new Error(`Unsupported replay magic. Expected ${RHR_MAGIC} (.rhr).`);
  }

  ensureRemainingBytes(view, offObj.off, 8, "timestamp");
  const rawTimestamp = readI64(view, offObj.off);
  offObj.off += 8;

  const mode = readStr8(view, offObj);
  const mapId = readStr8(view, offObj);
  ensureRemainingBytes(view, offObj.off, 8, "map page id");
  const mapPageId = Number(readI64(view, offObj.off));
  offObj.off += 8;
  const profileType = readStr8(view, offObj);
  ensureRemainingBytes(view, offObj.off, 1, "profile flag");
  const profileFlag = readU8(view, offObj.off);
  offObj.off += 1;
  const modsJson = readStr8(view, offObj);

  ensureRemainingBytes(view, offObj.off, 1, "replay status");
  const replayStatus = readU8(view, offObj.off);
  offObj.off += 1;
  ensureRemainingBytes(view, offObj.off, 4, "accuracy");
  const accuracy = readF32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 8, "unknownA");
  const unknownA = readU64(view, offObj.off);
  offObj.off += 8;
  ensureRemainingBytes(view, offObj.off, 4, "map length");
  const mapLengthSec = readF32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 4, "note count");
  const noteCount = readU32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 4, "unknownB");
  const unknownB = readU32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 4, "unknownC");
  const unknownC = readF32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 4, "unknownD");
  const unknownD = readI32(view, offObj.off);
  offObj.off += 4;
  ensureRemainingBytes(view, offObj.off, 4, "frame count");
  const frameCount = readU32(view, offObj.off);
  offObj.off += 4;

  if (!Number.isFinite(mapLengthSec) || mapLengthSec < 0) {
    throw new Error("Malformed replay: map length is invalid.");
  }

  const requiredFrameBytes = frameCount * RHR_FRAME_STRIDE_BYTES;
  if (requiredFrameBytes > view.byteLength - offObj.off) {
    throw new Error("Malformed replay: frame data is shorter than declared frame count.");
  }

  // Frame layout expected by this parser:
  //   Time      f32   replay-time milliseconds
  //   PositionX f32   cursor X in world units (centered, about +/- GRID_HALF)
  //   PositionY f32   cursor Y in world units (centered, about +/- GRID_HALF)
  //   Health    f32   0..1
  //   IsHit     u8    1 if a note was hit at this frame, else 0
  // Frames are INTERLEAVED, 17 bytes each, no separate flag block.
  const frames = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    ensureRemainingBytes(view, offObj.off, RHR_FRAME_STRIDE_BYTES, `frame ${i}`);
    const t      = readF32(view, offObj.off);
    const x      = readF32(view, offObj.off + 4);
    const y      = readF32(view, offObj.off + 8);
    const health = readF32(view, offObj.off + 12);
    const isHit  = readU8(view, offObj.off + 16) !== 0;
    frames[i] = { t, x, y, health, isHit };
    offObj.off += RHR_FRAME_STRIDE_BYTES;
  }

  // Last replay-time ms from frame data.
  const lastFrameMs = frameCount > 0 ? frames[frameCount - 1].t : 0;

  return {
    magic,
    rawTimestamp,
    mode,
    mapId,
    mapPageId,
    profileType,
    profileFlag,
    mods: safeJsonParse(modsJson, []),
    replayStatus,
    speedMod: accuracy,
    mapLengthSec,
    noteCount,
    frameCount,
    frames,
    lastFrameMs,
    unknownA,
    unknownB,
    unknownC,
    unknownD,
    unparsedTailBytes: view.byteLength - offObj.off,
  };
}

function isFiniteNumber(v) {
  return Number.isFinite(v) && !Number.isNaN(v);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 3D rendering.

// World dimensions: the hit plane is a flat square +/- GRID_HALF in x and y, at z = 0.
// Notes (when added) will spawn at NOTE_SPAWN_Z and travel toward z = 0.
const GRID_HALF = 1.4;
const NOTE_SPAWN_Z = 18;

// Note travel timing (in song-time ms, before speedScale)
const NOTE_PRE_HIT_FADE_MS = 50; // fade out during final approach before impact
const NOTE_MISS_PAST_MS = 20; // missed notes continue past the grid for a brief time
// Hit radius is approximated from projected cell size in drawNotes().

// Fixed perspective camera centered on the playfield.
const CAM_POS  = { x: 0, y: 0, z: -4.6 };
const CAM_LOOK = { x: 0, y: 0, z: 1 };
const CAM_FOV  = 55; // degrees

let _camBasis = null;

function normalize3(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function getCamBasis() {
  if (!_camBasis) {
    const fwd = normalize3({
      x: CAM_LOOK.x - CAM_POS.x,
      y: CAM_LOOK.y - CAM_POS.y,
      z: CAM_LOOK.z - CAM_POS.z,
    });
    const worldUp = { x: 0, y: 1, z: 0 };
    // Right-handed Y-up: +X world maps to screen right.
    const right = normalize3(cross3(worldUp, fwd));
    const up = normalize3(cross3(fwd, right));
    _camBasis = { fwd, right, up };
  }
  return _camBasis;
}

/**
 * Project a 3D world point (wx, wy, wz) onto canvas pixels.
 * Returns { px, py, depth } or null if the point is behind the camera.
 */
function project3D(wx, wy, wz, canvasW, canvasH) {
  const basis = getCamBasis();
  const dx = wx - CAM_POS.x;
  const dy = wy - CAM_POS.y;
  const dz = wz - CAM_POS.z;

  const camRight = dot3({ x: dx, y: dy, z: dz }, basis.right);
  const camUp    = dot3({ x: dx, y: dy, z: dz }, basis.up);
  const camDepth = dot3({ x: dx, y: dy, z: dz }, basis.fwd);

  if (camDepth < 0.05) return null; // behind or too close to camera

  const focalLen = 1 / Math.tan((CAM_FOV * Math.PI / 180) / 2);
  const aspect   = canvasW / canvasH;
  const ndcX     = (camRight / camDepth) * focalLen;
  const ndcY     = (camUp    / camDepth) * focalLen;

  // NDC [-1,1] to pixel space; NDC Y is flipped because canvas Y grows downward.
  const px = ((ndcX / aspect) + 1) * 0.5 * canvasW;
  const py = (1 - ndcY) * 0.5 * canvasH;

  return { px, py, depth: camDepth };
}

/** Project-and-draw a 3D line segment. */
function drawLine3D(ax, ay, az, bx, by, bz, canvasW, canvasH) {
  const pa = project3D(ax, ay, az, canvasW, canvasH);
  const pb = project3D(bx, by, bz, canvasW, canvasH);
  if (!pa || !pb) return;
  ctx.beginPath();
  ctx.moveTo(pa.px, pa.py);
  ctx.lineTo(pb.px, pb.py);
  ctx.stroke();
}

// Notes (SSPM v2).

/**
 * Parse an SSPM v2 map file.
 * Returns { notes: [{ ms, x, y }], lastMs, noteCount, audioBytes, audioMime }.
 * x,y are in [0,2] grid coords (integer mode) or floats (decimal mode).
 */
function parseSspm(buffer) {
  const u = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (u.length < 128 || u[0] !== 0x53 || u[1] !== 0x53 || u[2] !== 0x2B || u[3] !== 0x6D) {
    throw new Error("Not an SSPM file");
  }
  if (u[4] !== 2) {
    throw new Error("Only SSPM v2 is supported (got v" + u[4] + ")");
  }
  const lastMs    = dv.getUint32(30, true);
  const noteCount = dv.getUint32(34, true);
  const hasAudio  = u[45];
  const audioOff  = Number(dv.getBigUint64(64, true));
  const audioLen  = Number(dv.getBigUint64(72, true));
  const markersOff = Number(dv.getBigUint64(112, true));
  const markersLen = Number(dv.getBigUint64(120, true));
  const markersEnd = markersOff + markersLen;
  if (markersEnd > u.length) throw new Error("SSPM markers section out of bounds");

  let audioBytes = null;
  let audioMime = null;
  if (hasAudio && audioLen > 0 && audioOff + audioLen <= u.length) {
    audioBytes = u.slice(audioOff, audioOff + audioLen);
    audioMime = detectAudioMime(audioBytes);
  }

  const notes = [];
  let off = markersOff;
  while (off + 5 <= markersEnd) {
    const ms = dv.getUint32(off, true);
    off += 4;
    const type = u[off++];
    if (type !== 0) {
      // Unknown marker type; we cannot reliably skip without a generic value reader.
      // Bail out; we already have the notes that came before.
      break;
    }
    if (off + 1 > markersEnd) break;
    const isFloat = u[off++];
    let x;
    let y;
    if (isFloat) {
      if (off + 8 > markersEnd) break;
      x = dv.getFloat32(off, true); off += 4;
      y = dv.getFloat32(off, true); off += 4;
    } else {
      if (off + 2 > markersEnd) break;
      x = u[off++];
      y = u[off++];
    }
    notes.push({ ms, x, y });
  }
  notes.sort((a, b) => a.ms - b.ms);
  return { notes, lastMs, noteCount, audioBytes, audioMime };
}

/** Detect audio MIME from the first few bytes of a blob. */
function detectAudioMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg"; // ID3
  if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return "audio/mpeg"; // raw MP3 frame
  if (bytes.length >= 4 && bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg"; // OggS
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "audio/wav"; // RIFF
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac"; // fLaC
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (brand.startsWith("m4a") || brand === "mp4 " || brand.startsWith("isom") || brand.startsWith("iso2")) {
      return "audio/mp4";
    }
  }
  return "audio/mpeg";
}

/** Fetch beatmap page data and parse the .sspm. */
async function fetchMapAssets(mapPageId) {
  // Intentionally direct call so request flow stays easy to change.
  if (!Number.isFinite(mapPageId) || mapPageId <= 0) return null;
  const apiRes = await fetch(RHYTHIA_API_BEATMAP_PAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: mapPageId, session: "" }),
  });
  if (!apiRes.ok) throw new Error("Beatmap page fetch failed: " + apiRes.status);
  const meta = await apiRes.json();
  const beatmapUrl = meta?.beatmap?.beatmapFile;
  if (!beatmapUrl) return null;
  const sspmRes = await fetch(beatmapUrl);
  if (!sspmRes.ok) throw new Error("SSPM download failed: " + sspmRes.status);
  const buf = await sspmRes.arrayBuffer();
  const parsed = parseSspm(buf);
  return { ...parsed, beatmap: meta.beatmap, scores: Array.isArray(meta?.scores) ? meta.scores : [] };
}

function normalizeModsList(mods) {
  if (!Array.isArray(mods)) return [];
  return mods
    .map((m) => String(m || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function modsMatch(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function resolveAwardedSp(replay, scores, missCount) {
  if (!Array.isArray(scores) || scores.length === 0) return null;

  const replayMods = normalizeModsList(replay.mods);
  const replaySpeed = Number(replay.speedMod);
  const replayTs = Number(replay.rawTimestamp);
  const totalNotes = Array.isArray(replay.noteHits) ? replay.noteHits.length : 0;
  const replayAcc = totalNotes > 0
    ? ((totalNotes - missCount) / totalNotes) * 100
    : null;

  const matches = [];
  for (const s of scores) {
    if (!s || !Number.isFinite(Number(s.awarded_sp))) continue;
    if (!modsMatch(replayMods, normalizeModsList(s.mods))) continue;

    const sSpeed = Number(s.speed);
    if (Number.isFinite(replaySpeed) && Number.isFinite(sSpeed) && Math.abs(sSpeed - replaySpeed) > 0.002) continue;

    const sMisses = Number(s.misses);
    if (Number.isFinite(sMisses) && sMisses !== missCount) continue;

    const sAcc = Number(s.accuracy);
    if (Number.isFinite(replayAcc) && Number.isFinite(sAcc) && Math.abs(sAcc - replayAcc) > 0.05) continue;

    const createdAtMs = Date.parse(String(s.created_at || ""));
    const timeDiff = Number.isFinite(replayTs) && Number.isFinite(createdAtMs)
      ? Math.abs(createdAtMs - replayTs)
      : Number.POSITIVE_INFINITY;

    matches.push({
      awardedSp: Number(s.awarded_sp),
      timeDiff,
    });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.timeDiff - b.timeDiff);
  return matches[0].awardedSp;
}

function formatPoints(value) {
  if (!Number.isFinite(value)) return "\u2014";
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return String(rounded);
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

/** Convert SSPM grid coordinates (x,y in [0,2]) to world coords on the hit plane.
 *  x=0,1,2 are treated as cell centers, not outer edges.
 *  A 3-cell grid with half-extent GRID_HALF maps to +/- (2/3) * GRID_HALF and 0. */
function noteToWorld(x, y) {
  const CELL = (2 * GRID_HALF) / 3;
  return {
    wx: (x - 1) * CELL,         // x=0 -> -CELL, x=1 -> 0, x=2 -> +CELL
    wy: (1 - y) * CELL,         // y=0 (top in SS) -> +CELL, y=2 (bottom) -> -CELL
    wz: 0,
  };
}

/** Sample interpolated cursor position (in SSPM grid coords, 0..2) at
 *  replay-time `tMs`. Returns null when no frames are loaded.
 *  Uses linear interpolation between the two surrounding frames. */
function sampleCursor(replay, tMs) {
  if (!replay || !replay.frames || replay.frames.length === 0) return null;
  const frames = replay.frames;
  // Binary search for the first frame whose t > tMs.
  let lo = 0, hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= tMs) lo = mid + 1;
    else hi = mid - 1;
  }
  const i1 = Math.min(frames.length - 1, lo);
  const i0 = Math.max(0, i1 - 1);
  const a = frames[i0];
  const b = frames[i1];
  const span = b.t - a.t;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (tMs - a.t) / span)) : 0;
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    health: a.health + (b.health - a.health) * alpha,
    isHit: b.isHit,
  };
}

/** Classify each beatmap note as "hit" or "miss" using the per-frame IsHit
 *  flag. The replay records exactly one IsHit=true frame per note hit at
 *  the moment of impact, so we walk both timelines in order and pair them. */
function computeNoteHits(replay, speedScale) {
  if (!replay || !replay.notes) return null;
  const notes = replay.notes;
  const frames = replay.frames;
  const out = new Array(notes.length).fill("miss");

  // Collect all IsHit timestamps in replay-time ms (already chronological).
  const hitTimes = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].isHit) hitTimes.push(frames[i].t);
  }

  // Walk both lists in order. Note timing is in song-time ms, and the
  // replay's IsHit frames are also recorded in song-time, so the two line
  // up directly without applying speedScale.
  let hi = 0;
  for (let ni = 0; ni < notes.length && hi < hitTimes.length; ni++) {
    const noteT = notes[ni].ms;
    const ht = hitTimes[hi];
    if (ht < noteT - NOTE_HIT_TOLERANCE_MS) {
      hi++;
      ni--;
      continue;
    }
    if (Math.abs(ht - noteT) <= NOTE_HIT_TOLERANCE_MS) {
      out[ni] = "hit";
      hi++;
    }
  }
  return out;
}

async function loadMapNotes(replay) {
  const data = await fetchMapAssets(replay.mapPageId);
  if (!data || !data.notes || data.notes.length === 0) return;

  // .rhr frame times and SSPM note times are both song-time milliseconds.
  // Keep a 1:1 timeline so cursor, notes, and IsHit align exactly.
  const speedScale = 1;

  replay.notes = data.notes;
  replay.notesTimeScale = speedScale;
  replay.noteHits = computeNoteHits(replay, speedScale);
  rebuildReplayMarkers(replay);

  let misses = 0;
  if (Array.isArray(replay.noteHits)) {
    for (const v of replay.noteHits) if (v === "miss") misses++;
    replay.missCount = misses;
    if (els.missVal) els.missVal.textContent = String(misses);
  }

  const awardedSp = resolveAwardedSp(replay, data.scores, misses);
  replay.awardedSp = Number.isFinite(awardedSp) ? awardedSp : null;

  // Update song name from the properly-cased API title.
  if (data.beatmap?.title && state.replay === replay) {
    els.songName.textContent = data.beatmap.title;
  }

  // Wire audio if the SSPM provided it.
  if (data.audioBytes && data.audioBytes.length > 0) {
    setupAudio(data.audioBytes, data.audioMime, speedScale);
  }
}

/** Create/replace the HTMLAudioElement from raw bytes and prepare sync. */
function setupAudio(bytes, mime, notesTimeScale) {
  // Tear down any previous audio first
  teardownAudio();

  const detectedMime = detectAudioMime(bytes);
  const candidates = [
    mime,
    detectedMime,
    "audio/mp4",
    "audio/aac",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/flac",
    "",
  ];
  const mimeCandidates = Array.from(new Set(candidates.filter((m) => typeof m === "string")));

  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = state.musicVolume;

  state.audio = audio;
  state.audioUrl = null;
  state.audioReady = false;
  state.audioTimeScale = notesTimeScale || 1;

  let attempt = 0;
  let currentMime = "";

  const applyAttempt = () => {
    if (state.audio !== audio) return;
    if (attempt >= mimeCandidates.length) {
      const err = audio.error;
      const reason = err?.code === 1 ? "aborted"
        : err?.code === 2 ? "network"
        : err?.code === 3 ? "decode"
        : err?.code === 4 ? "src-not-supported"
        : "unknown";
      const headerHex = Array.from(bytes.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
      console.warn("Audio failed to load", {
        errorCode: err?.code || 0,
        reason,
        attemptedMimes: mimeCandidates,
        bytes: bytes.length,
        headerHex,
      });
      teardownAudio();
      return;
    }

    currentMime = mimeCandidates[attempt++];
    if (state.audioUrl) {
      try { URL.revokeObjectURL(state.audioUrl); } catch {}
      state.audioUrl = null;
    }
    const blob = currentMime ? new Blob([bytes], { type: currentMime }) : new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    state.audioUrl = url;
    audio.src = url;
    audio.load();
  };

  const onLoadedMetadata = () => {
    if (state.audio !== audio) return;
    state.audioReady = true;
    syncAudioToTimeline(true);
  };

  const onError = () => {
    if (state.audio !== audio) return;
    // Try the next MIME guess before giving up.
    applyAttempt();
  };

  audio.addEventListener("loadedmetadata", onLoadedMetadata);
  audio.addEventListener("error", onError);
  audio._rvOnLoadedMetadata = onLoadedMetadata;
  audio._rvOnError = onError;

  applyAttempt();
}

function teardownAudio() {
  if (state.audio) {
    if (state.audio._rvOnLoadedMetadata) {
      try { state.audio.removeEventListener("loadedmetadata", state.audio._rvOnLoadedMetadata); } catch {}
      state.audio._rvOnLoadedMetadata = null;
    }
    if (state.audio._rvOnError) {
      try { state.audio.removeEventListener("error", state.audio._rvOnError); } catch {}
      state.audio._rvOnError = null;
    }
    try { state.audio.pause(); } catch {}
    state.audio.src = "";
  }
  if (state.audioUrl) {
    try { URL.revokeObjectURL(state.audioUrl); } catch {}
  }
  state.audio = null;
  state.audioUrl = null;
  state.audioReady = false;
}

/** Convert replay-timeline ms to song-time seconds. */
function replayMsToSongSec(replayMs) {
  const scale = state.audioTimeScale || 1;
  return (replayMs / scale) / 1000;
}

/** Push the audio element to match the current replay state. */
function syncAudioToTimeline(force) {
  const audio = state.audio;
  if (!audio || !state.audioReady) return;
  const targetSec = replayMsToSongSec(replayMs());
  // Apply audio offset (convert milliseconds to seconds)
  const offsetSec = (state.viewerSettings?.audioOffsetMs || 0) / 1000;
  const adjustedSec = targetSec + offsetSec;
  // Audio playback rate must equal replay-speed / notesTimeScale so that
  // d(songTime)/d(realTime) matches d(replayTime)/d(realTime) / notesTimeScale.
  const desiredRate = (state.speed || 1) / (state.audioTimeScale || 1);
  if (Math.abs(audio.playbackRate - desiredRate) > 0.001) {
    audio.playbackRate = Math.max(0.0625, Math.min(16, desiredRate));
  }
  if (force || Math.abs(audio.currentTime - adjustedSec) > AUDIO_DRIFT_RESYNC_SEC) {
    try { audio.currentTime = Math.max(0, Math.min(audio.duration || adjustedSec, adjustedSec)); } catch {}
  }
  // Hard-mute (and pause) during the pre/post-roll grace windows so the
  // viewer is silent while the playfield is empty.
  const inGrace = state.currentMs < state.gracePreMs ||
                  state.currentMs > (state.durationMs - state.gracePostMs);
  if (inGrace) {
    if (!audio.paused) audio.pause();
    return;
  }
  if (state.isPlaying && audio.paused) {
    audio.play().catch(() => {});
  } else if (!state.isPlaying && !audio.paused) {
    audio.pause();
  }
}

/** Draw the player's cursor as a small dot on the hit plane. */
function drawCursor(canvasW, canvasH) {
  const replay = state.replay;
  if (!replay) return;
  const c = sampleCursor(replay, replayMs());
  if (!c) return;
  // Cursor x/y are already in world units on the hit plane.
  const p = project3D(c.x, c.y, 0, canvasW, canvasH);
  if (!p) return;

  const r = 6;
  ctx.fillStyle = state.viewerSettings.cursorColor || "#ffffff";
  ctx.beginPath();
  ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.stroke();
}

/** Render notes spawning at the back and traveling toward the hit plane.
 *  - Hit notes vanish at the hit time.
 *  - Missed notes continue flying past the hit plane for NOTE_MISS_FLY_MS,
 *    fading as they pass the player. */
function drawNotes(canvasW, canvasH) {
  const replay = state.replay;
  if (!replay || !replay.notes || replay.notes.length === 0) return;

  const speedScale = replay.notesTimeScale || 1;
  const tNow = replayMs();

  const lookahead = state.viewerSettings.reactionTimeMs * speedScale;
  const hits = replay.noteHits;

  // World-space size of one cell, used to size the on-screen note tile.
  const CELL = (2 * GRID_HALF) / 3;
  const NOTE_HALF_WORLD = CELL * 0.42;

  // Reference depth at the center of the hit plane, for perspective scaling.
  const refProj = project3D(0, 0, 0, canvasW, canvasH);
  if (!refProj) return;
  const refSizeProj = project3D(NOTE_HALF_WORLD, 0, 0, canvasW, canvasH);
  if (!refSizeProj) return;
  const refPixelHalf = Math.abs(refSizeProj.px - refProj.px);

  // Visible notes are only those still approaching the hit plane.
  const notes = replay.notes;
  const visible = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const adjMs = n.ms * speedScale;
    const dt = adjMs - tNow;
    const verdict = hits ? hits[i] : "unknown";
    const canShowPreHit = dt >= 0 && dt <= lookahead;
    const canShowMissLinger = verdict === "miss" && dt < 0 && -dt <= NOTE_MISS_PAST_MS * speedScale;
    if (!canShowPreHit && !canShowMissLinger) continue;
    visible.push({ n, idx: i, dt, verdict });
  }
  // Far first so closer notes overlap correctly
  visible.sort((a, b) => b.dt - a.dt);

  for (const v of visible) {
    const { n, dt } = v;
    // Notes travel toward the hit plane. Missed notes continue past the
    // grid briefly instead of stopping exactly at z=0.
    let z = (Math.max(0, dt) / lookahead) * NOTE_SPAWN_Z;
    if (v.verdict === "miss" && dt < 0) {
      const missPast = Math.min(NOTE_MISS_PAST_MS * speedScale, -dt);
      z = -(missPast / Math.max(1e-6, lookahead)) * NOTE_SPAWN_Z;
    }
    const w = noteToWorld(n.x, n.y);

    const center = project3D(w.wx, w.wy, z, canvasW, canvasH);
    if (!center) continue;

    const depthScale = Math.max(0.06, refProj.depth / Math.max(1e-6, center.depth));
    const halfPx = Math.max(3, refPixelHalf * depthScale);

    const closeness = 1 - Math.min(1, dt / lookahead); // 0 far, 1 at hit
    let alpha = 0.45 + closeness * 0.55;
    const isMiss = v.verdict === "miss";
    const preFadeWindow = NOTE_PRE_HIT_FADE_MS * speedScale;
    if (isMiss && dt < 0) {
      // Missed notes fade out while passing through the grid.
      const lingerWindow = NOTE_MISS_PAST_MS * speedScale;
      const lingerK = 1 - Math.min(1, (-dt) / Math.max(1e-6, lingerWindow));
      alpha = 0.15 + lingerK * 0.85;
    } else if (dt <= preFadeWindow) {
      // Fade out in the final NOTE_PRE_HIT_FADE_MS before the hit plane.
      const k = Math.max(0, dt / Math.max(1e-6, preFadeWindow));
      alpha *= k;
    }
    alpha = Math.max(0, Math.min(1, alpha));
    // Note body color is user-configurable; missed-note marker is separate.
    const noteRgb = hexToRgb(state.viewerSettings.notesColor);
    const baseColor = `${noteRgb.r}, ${noteRgb.g}, ${noteRgb.b}`;
    if (alpha <= 0) continue;

    const cx = center.px;
    const cy = center.py;
    const radius = halfPx * 0.32;
    const stroke = Math.max(1.5, halfPx * 0.16);

    // Single hollow rounded square with no inner outline.
    ctx.lineWidth = stroke;
    ctx.strokeStyle = `rgba(${baseColor}, ${alpha.toFixed(3)})`;
    roundRect(cx - halfPx, cy - halfPx, halfPx * 2, halfPx * 2, radius);
    ctx.stroke();

    if (state.viewerSettings.highlightMisses && isMiss) {
      const arm = halfPx * 0.55;
      ctx.lineWidth = Math.max(2, halfPx * 0.15);
      ctx.strokeStyle = `rgba(255, 90, 105, ${Math.min(1, alpha + 0.2).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy - arm);
      ctx.lineTo(cx + arm, cy + arm);
      ctx.moveTo(cx + arm, cy - arm);
      ctx.lineTo(cx - arm, cy + arm);
      ctx.stroke();
    }
  }
}

function draw3DField(canvasW, canvasH) {
  const G = GRID_HALF;
  // Draw a minimal field frame using four corner brackets.
  const tl = project3D(-G,  G, 0, canvasW, canvasH);
  const tr = project3D( G,  G, 0, canvasW, canvasH);
  const br = project3D( G, -G, 0, canvasW, canvasH);
  const bl = project3D(-G, -G, 0, canvasW, canvasH);
  if (!tl || !tr || !br || !bl) {
    state.playfieldHitbox = null;
    return;
  }

  state.playfieldHitbox = {
    x: Math.min(tl.px, tr.px, br.px, bl.px),
    y: Math.min(tl.py, tr.py, br.py, bl.py),
    w: Math.max(tl.px, tr.px, br.px, bl.px) - Math.min(tl.px, tr.px, br.px, bl.px),
    h: Math.max(tl.py, tr.py, br.py, bl.py) - Math.min(tl.py, tr.py, br.py, bl.py),
  };

  if (state.dragFileOverWindow) {
    const hb = state.playfieldHitbox;
    const inset = Math.max(6, Math.min(hb.w, hb.h) * 0.045);
    const boxX = hb.x + inset;
    const boxY = hb.y + inset;
    const boxW = Math.max(0, hb.w - inset * 2);
    const boxH = Math.max(0, hb.h - inset * 2);
    const radius = Math.max(10, Math.min(28, Math.min(boxW, boxH) * 0.1));
    if (boxW <= 0 || boxH <= 0) return;

    ctx.save();
    if (state.dragFileOverGrid) {
      ctx.fillStyle = "rgba(72, 188, 255, 0.22)";
      ctx.strokeStyle = "rgba(140, 226, 255, 0.98)";
      ctx.lineWidth = 3;
      ctx.shadowColor = "rgba(77, 199, 255, 0.58)";
      ctx.shadowBlur = 18;
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.strokeStyle = "rgba(188, 198, 214, 0.62)";
      ctx.lineWidth = 2;
      ctx.shadowBlur = 0;
    }
    roundRect(boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  const armX = Math.max(20, Math.min(46, (tr.px - tl.px) * 0.055));
  const armY = Math.max(20, Math.min(46, (bl.py - tl.py) * 0.055));
  const r    = 14; // corner radius

  ctx.strokeStyle = "rgba(170, 178, 190, 0.55)";
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = "round";

  // Top-left bracket
  ctx.beginPath();
  ctx.moveTo(tl.px,            tl.py + armY);
  ctx.lineTo(tl.px,            tl.py + r);
  ctx.quadraticCurveTo(tl.px,  tl.py, tl.px + r, tl.py);
  ctx.lineTo(tl.px + armX,     tl.py);
  ctx.stroke();

  // Top-right bracket
  ctx.beginPath();
  ctx.moveTo(tr.px - armX,     tr.py);
  ctx.lineTo(tr.px - r,        tr.py);
  ctx.quadraticCurveTo(tr.px,  tr.py, tr.px, tr.py + r);
  ctx.lineTo(tr.px,            tr.py + armY);
  ctx.stroke();

  // Bottom-right bracket
  ctx.beginPath();
  ctx.moveTo(br.px,            br.py - armY);
  ctx.lineTo(br.px,            br.py - r);
  ctx.quadraticCurveTo(br.px,  br.py, br.px - r, br.py);
  ctx.lineTo(br.px - armX,     br.py);
  ctx.stroke();

  // Bottom-left bracket
  ctx.beginPath();
  ctx.moveTo(bl.px + armX,     bl.py);
  ctx.lineTo(bl.px + r,        bl.py);
  ctx.quadraticCurveTo(bl.px,  bl.py, bl.px, bl.py - r);
  ctx.lineTo(bl.px,            bl.py - armY);
  ctx.stroke();
}

function ensureCanvasSize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = els.canvas.getBoundingClientRect();
  const targetW = Math.max(1, Math.round(rect.width * dpr));
  const targetH = Math.max(1, Math.round(rect.height * dpr));
  if (els.canvas.width !== targetW || els.canvas.height !== targetH) {
    els.canvas.width = targetW;
    els.canvas.height = targetH;
  }
}

function canvasPointFromEvent(e) {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = rect.width > 0 ? els.canvas.width / rect.width : 1;
  return {
    x: (e.clientX - rect.left) * dpr,
    y: (e.clientY - rect.top) * dpr,
  };
}

function isEventInPlayfield(e) {
  const hb = state.playfieldHitbox;
  if (!hb) return false;
  const p = canvasPointFromEvent(e);
  return p.x >= hb.x && p.x <= hb.x + hb.w && p.y >= hb.y && p.y <= hb.y + hb.h;
}

function dragHasFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

function setLoadingState(active, label = "", progress = 0) {
  state.loadingActive = !!active;
  state.loadingLabel = active ? String(label || "Loading...") : "";
  state.loadingProgress = active ? clamp(Number(progress) || 0, 0, 1) : 0;
  drawReplay();
}

function readReplayFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        const p = e.loaded / e.total;
        setLoadingState(true, "Loading...", p * 0.72);
      } else {
        setLoadingState(true, "Loading...", 0.35);
      }
    };

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read replay file."));
    reader.readAsArrayBuffer(file);
  });
}

function drawReplay() {
  // Draw order is intentional for stable visuals:
  // 1) stage background, 2) playfield, 3) notes, 4) cursor, 5) HUD overlays.
  ensureCanvasSize();
  const replay = state.replay;
  const w = els.canvas.width;
  const h = els.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = DEFAULT_STAGE_BG;
  ctx.fillRect(0, 0, w, h);

  // Keep playfield visible even before loading a replay.
  draw3DField(w, h);

  if (state.loadingActive || !replay || replay.frameCount === 0) {
    const center = project3D(0, 0, 0, w, h);
    const cx = center ? center.px : w * 0.5;
    const cy = center ? center.py : h * 0.5;
    if (state.loadingActive) {
      const barW = Math.min(420, w * 0.46);
      const barH = 12;
      const barX = cx - barW * 0.5;
      const barY = cy + 28;
      const pct = clamp(state.loadingProgress, 0, 1);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(245, 247, 255, 0.96)";
      ctx.font = "700 30px 'Space Grotesk'";
      ctx.fillText(state.loadingLabel || "Loading...", cx, cy - 6);

      ctx.fillStyle = "rgba(255,255,255,0.14)";
      roundRect(barX, barY, barW, barH, 999);
      ctx.fill();

      ctx.fillStyle = "rgba(122, 205, 255, 0.98)";
      roundRect(barX, barY, barW * pct, barH, 999);
      ctx.fill();

      ctx.font = "600 13px 'JetBrains Mono'";
      ctx.fillStyle = "rgba(228, 238, 255, 0.88)";
      ctx.fillText(`${Math.round(pct * 100)}%`, cx, barY + 26);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(245, 247, 255, 0.88)";
      ctx.font = "700 30px 'Space Grotesk'";
      ctx.fillText("Drop replay file", cx, cy);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
    return;
  }

  // Draw notes (back-to-front).
  if (state.viewerSettings.showNotes) {
    drawNotes(w, h);
  }

  // Player cursor on the hit plane.
  if (state.viewerSettings.showCursor) {
    drawCursor(w, h);
  }

  if (state.viewerSettings.showHud) {
    drawHUDWalls(w, h);
  }

  if (state.viewerSettings.showFps) {
    const fps = state.fpsSmoothed > 0 ? state.fpsSmoothed : 0;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "600 16px 'JetBrains Mono'";
    ctx.fillText(`${fps.toFixed(1)} FPS`, w - 16, 12);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

// ----------------------------------------------------------------------
// HUD WALLS
// ----------------------------------------------------------------------
// The HUD lives inside the 3D scene as four trapezoidal walls forming an
// open box around the playfield. Each wall's BACK edge is the projected
// edge of the hit plane (so the inner cutout is the playfield); each wall's
// FRONT edge is the corresponding canvas edge. Stat text is rendered into
// the screen-space gap between the two edges, kept upright for legibility.
function drawHUDWalls(w, h) {
  const G = GRID_HALF;
  const tl = project3D(-G,  G, 0, w, h);
  const tr = project3D( G,  G, 0, w, h);
  const br = project3D( G, -G, 0, w, h);
  const bl = project3D(-G, -G, 0, w, h);
  if (!tl || !tr || !br || !bl) return;

  // Store screen-space bounding box so canvas click handler can test it.
  state.playfieldHitbox = {
    x: Math.min(tl.px, tr.px, br.px, bl.px),
    y: Math.min(tl.py, tr.py, br.py, bl.py),
    w: Math.max(tl.px, tr.px, br.px, bl.px) - Math.min(tl.px, tr.px, br.px, bl.px),
    h: Math.max(tl.py, tr.py, br.py, bl.py) - Math.min(tl.py, tr.py, br.py, bl.py),
  };

  // Canvas corners (front edges) kept for layout calls below.
  const ftl = { px: 0,  py: 0  };
  const ftr = { px: w,  py: 0  };
  const fbr = { px: w,  py: h  };
  const fbl = { px: 0,  py: h  };

  // No wall fills, no seam outlines, no mitre lines; only the central
  // playfield square stays. HUD text panels are drawn flush against the
  // projected playfield edges below.

  drawTopWall(ftl, ftr, tl, tr);
  drawBottomWall(fbl, fbr, bl, br);
  drawLeftWall(ftl, tl, bl, fbl);
  drawRightWall(ftr, tr, br, fbr);
}

function drawTopWall(ftl, ftr, tl, tr) {
  const songName = els.songName?.textContent || "";
  const time     = els.timeLabel?.textContent || "";
  const w = els.canvas.width;

  // Header is anchored to the canvas top, not the playfield.
  const centerX = w / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Title line
  ctx.font = "600 22px 'Space Grotesk'";
  ctx.fillStyle = state.songTitleHover && state.mapUrl ? "#c8ced8" : "#ffffff";
  ctx.fillText(songName, centerX, 40);

  // Track a clickable hitbox for the title so it behaves like the old map link.
  const titleMeasure = ctx.measureText(songName);
  const titleW = titleMeasure.width;
  const ascent = titleMeasure.actualBoundingBoxAscent || 18;
  const descent = titleMeasure.actualBoundingBoxDescent || 6;
  state.songTitleHitbox = state.mapUrl ? {
    x: centerX - titleW / 2,
    y: 40 - ascent,
    w: titleW,
    h: ascent + descent,
  } : null;

  // Time line
  ctx.fillStyle = "rgba(220,225,235,0.85)";
  ctx.font = "600 18px 'JetBrains Mono'";
  ctx.fillText(time, centerX, 70);

  // Top progress bar: display-only, grey track + white fill, sits under
  // the title block. Width matches the health bar (playfield width + 40px
  // outset on each side) so the two read as a matched pair.
  const pct = parseFloat(els.progressFill?.style.width || "0") || 0;
  const padX = 40;
  const barX = tl.px - padX;
  const barW = (tr.px + padX) - barX;
  const barY = 92;
  const barH = 4;
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(barX, barY, barW * (pct / 100), barH);
}

function drawBottomWall(fbl, fbr, bl, br) {
  // --- Health bar: pinned just under the projected playfield bottom edge,
  // spans the playfield width (with a small outset). Green/red health colors.
  const healthPct = Math.max(0, Math.min(100, parseFloat(els.healthFill?.style.width || "100") || 0));
  const healthCol = els.healthFill?.style.background || "#4ade80";
  const HEALTH_H  = 9;
  const healthY   = bl.py + 28;
  const xLeft     = bl.px;
  const xRight    = br.px;
  const barW      = xRight - xLeft;
  ctx.fillStyle   = "rgba(255,255,255,0.10)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth   = 1;
  roundRect(xLeft, healthY, barW, HEALTH_H, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = healthCol;
  roundRect(xLeft, healthY, barW * (healthPct / 100), HEALTH_H, 5);
  ctx.fill();
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawSideStat(centerX, y, label, value, valueOpts = {}) {
  // Label above value, centered.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(180,185,195,0.75)";
  ctx.font = "600 13px 'Space Grotesk'";
  ctx.fillText(label, centerX, y);
  ctx.fillStyle = valueOpts.color || "#ffffff";
  ctx.font = `700 ${valueOpts.size || 22}px 'Space Grotesk'`;
  ctx.fillText(value, centerX, y + (valueOpts.gap || 26));
}

function drawComboTriangle(centerX, centerY, comboText) {
  // Equilateral triangle (point up). Geometric centroid sits 1/3 up from
  // the base, so we offset the text downward to land inside the triangle.
  const size = 86;
  const h    = size * 0.92;
  const apexY = centerY - h * 0.55;
  const baseY = centerY + h * 0.45;
  ctx.strokeStyle = "rgba(200,205,215,0.65)";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(centerX,             apexY);
  ctx.lineTo(centerX + size * 0.55, baseY);
  ctx.lineTo(centerX - size * 0.55, baseY);
  ctx.closePath();
  ctx.stroke();
  // Centroid of triangle = apexY + (2/3)*(baseY - apexY)
  const cy = apexY + (baseY - apexY) * (2 / 3);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 20px 'Space Grotesk'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(comboText, centerX, cy);
}

function drawLeftWall(ftl, tl, bl, fbl) {
  // Keep left stats close to the playfield edge.
  const h = els.canvas.height;
  const colX = Math.max(110, tl.px - 130);

  const panelAlpha = clamp(state.viewerSettings.sidePanelOpacity, 0, 1);
  if (panelAlpha > 0.001) {
    const panelW = 190;
    const panelTop = Math.max(24, tl.py - 12);
    const panelBottom = Math.min(h - 26, h * 0.83);
    const panelH = Math.max(40, panelBottom - panelTop);
    ctx.fillStyle = `rgba(0, 0, 0, ${panelAlpha.toFixed(3)})`;
    roundRect(colX - panelW * 0.5, panelTop, panelW, panelH, 16);
    ctx.fill();
  }

  // Combo triangle aligned vertically with the top playfield bracket
  drawComboTriangle(colX, tl.py + 80, els.comboVal?.textContent || "0x");

  // PAUSES: just below the combo triangle.
  drawSideStat(colX, tl.py + 210,
    "PAUSES",
    els.pauseVal?.textContent || "0",
    { size: 22, gap: 28 });

  // Rank: large letter (no label in real game), centered vertically.
  const rank = els.rankVal?.textContent || "D";
  ctx.fillStyle = "#f3c79a";
  ctx.font = "700 60px 'Space Grotesk'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(rank, colX, h * 0.60);

  // ACCURACY: closer to the rank letter, not pinned to the bottom bracket.
  drawSideStat(colX, h * 0.76,
    "ACCURACY",
    els.accVal?.textContent || "0%",
    { size: 22, gap: 28 });
}

function drawRightWall(ftr, tr, br, fbr) {
  const w = els.canvas.width;
  const h = els.canvas.height;
  const colX = Math.min(w - 110, tr.px + 130);

  const panelAlpha = clamp(state.viewerSettings.sidePanelOpacity, 0, 1);
  if (panelAlpha > 0.001) {
    const panelW = 190;
    const panelTop = Math.max(24, tr.py - 12);
    const panelBottom = Math.min(h - 26, h * 0.83);
    const panelH = Math.max(40, panelBottom - panelTop);
    ctx.fillStyle = `rgba(0, 0, 0, ${panelAlpha.toFixed(3)})`;
    roundRect(colX - panelW * 0.5, panelTop, panelW, panelH, 16);
    ctx.fill();
  }

  drawSideStat(colX, tr.py + 80,
    "SCORE",
    els.scoreVal?.textContent || "0",
    { size: 24, gap: 28 });

  drawSideStat(colX, tr.py + 210,
    "POINTS",
    els.pointsVal?.textContent || "0",
    { size: 22, gap: 28 });

  // MISSES: default white, only flashes red briefly when a miss lands.
  const flashElapsed = performance.now() - state.missFlashAt;
  const FLASH_DUR = 450;
  let missColor = "#ffffff";
  let shakeX = 0;
  if (state.missFlashAt > 0 && flashElapsed < FLASH_DUR) {
    const k = 1 - flashElapsed / FLASH_DUR;
    // Lerp red to white.
    const r = 255;
    const g = Math.round(255 - (255 - 119) * k);
    const b = Math.round(255 - (255 - 133) * k);
    missColor = `rgb(${r},${g},${b})`;
    shakeX = Math.sin(flashElapsed * 0.08) * 4 * k;
  }
  ctx.save();
  ctx.translate(shakeX, 0);
  drawSideStat(colX, h * 0.60 - 14,
    "MISSES",
    els.missVal?.textContent || "0",
    { size: 22, color: missColor, gap: 28 });
  ctx.restore();

  // NOTES: closer to the misses block, not pinned to the bottom bracket.
  drawSideStat(colX, h * 0.76,
    "NOTES",
    els.noteCountVal?.textContent || "0/0",
    { size: 22, gap: 28 });
}

function parseSongMeta(raw, playerName) {
  if (!raw) return { title: "Unknown Song", artist: "" };
  const text = String(raw).trim();
  const player = String(playerName || "").trim().toLowerCase();

  const parts = text.split("_-_").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return {
      artist: parts[1].replaceAll("_", " "),
      title: parts[2].replaceAll("_", " "),
    };
  }

  const dashed = text.split(" - ").map((p) => p.trim()).filter(Boolean);
  if (dashed.length >= 3) {
    const first = dashed[0].toLowerCase();
    const isCode = /^mm[a-z0-9]{4,}$/i.test(dashed[0]);
    if (first === player || isCode) {
      return { artist: dashed[1] || "", title: dashed.slice(2).join(" - ") };
    }
  }
  if (dashed.length === 2) {
    return { artist: dashed[0], title: dashed[1] };
  }

  return { title: text.replaceAll("_", " "), artist: "" };
}

function buildRhythiaMapUrl(mapPageId) {
  if (!Number.isFinite(mapPageId)) return null;
  if (mapPageId <= 0) return null;
  if (!Number.isInteger(mapPageId)) return null;
  return `https://www.rhythia.com/maps/${mapPageId}`;
}

/** Friendly short tag for a replay mod identifier. */
const MOD_LABELS = {
  mod_nofail: "NF",
  mod_no_fail: "NF",
  mod_hardrock: "HR",
  mod_hard_rock: "HR",
  mod_easy: "EZ",
  mod_doubletime: "DT",
  mod_double_time: "DT",
  mod_halftime: "HT",
  mod_half_time: "HT",
  mod_nightcore: "NC",
  mod_sudden_death: "SD",
  mod_suddendeath: "SD",
  mod_perfect: "PF",
  mod_flashlight: "FL",
  mod_hidden: "HD",
  mod_relax: "RX",
  mod_autoplay: "AT",
  mod_spinhide: "SP",
  mod_spinHide: "SP",
};

function modLabel(raw) {
  if (!raw) return "";
  const key = String(raw).toLowerCase();
  if (MOD_LABELS[key]) return MOD_LABELS[key];
  // Strip "mod_" prefix and uppercase the rest
  return String(raw).replace(/^mod_/i, "").replaceAll("_", " ").toUpperCase();
}

function renderMeta(replay) {
  const playerName = replay.mode || replay.profileType || "Unknown";
  const parsed = parseSongMeta(replay.mapId, playerName);
  const mapUrl = buildRhythiaMapUrl(replay.mapPageId);
  state.mapUrl = mapUrl;
  state.songTitleHover = false;
  state.songTitleHitbox = null;

  // Top bar
  const songFull = parsed.artist ? `${parsed.artist} - ${parsed.title}` : parsed.title;
  els.songName.textContent = songFull;

  // Reset stats
  els.accVal.textContent = "0%";
  els.missVal.textContent = "0";
  els.comboVal.textContent = "0x";
  els.scoreVal.textContent = "0";
  els.pointsVal.textContent = "0";
  els.pauseVal.textContent = "0";
  els.rankVal.textContent = "D";
  els.noteCountVal.textContent = `0/${replay.noteCount || 0}`;
  if (els.healthFill) els.healthFill.style.width = "100%";
  if (els.progressFill) els.progressFill.style.width = "0%";

  // Mods row (bottom bar). Speed mod becomes a tag if not 1x.
  const modsList = Array.isArray(replay.mods) ? replay.mods.filter(Boolean) : [];
  const speedMod = replay.speedMod;
  const hasSpeedMod = Number.isFinite(speedMod) && Math.abs(speedMod - 1.0) > 0.01;
  const tags = modsList.map(modLabel).filter(Boolean);
  if (hasSpeedMod) tags.push(speedMod.toFixed(2) + "x");
  els.modsRow.innerHTML = tags.length
    ? tags.map((t) => `<span class="mod-tag">${escapeHtml(t)}</span>`).join("")
    : "";

}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const SPEED_STEP = 0.25;

function setLoadedState(loaded) {
  els.playPause.disabled = !loaded;
  els.speedDown.disabled = !loaded;
  els.speedUp.disabled = !loaded;
  els.seek.disabled = !loaded;
}

function formatSpeedLabel(value) {
  return `x${Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}`;
}

function updateSpeedUI() {
  const speed = Number(state.speed) || 1;
  if (els.speedCurrent) els.speedCurrent.textContent = formatSpeedLabel(speed);
  if (els.speedDown) els.speedDown.disabled = speed <= SPEED_MIN;
  if (els.speedUp) els.speedUp.disabled = speed >= SPEED_MAX;
}

function commitSpeedEdit() {
  const raw = parseFloat(els.speedInput.value);
  if (!Number.isNaN(raw) && raw > 0) {
    state.speed = clamp(Math.round(raw / SPEED_STEP) * SPEED_STEP, SPEED_MIN, SPEED_MAX);
  }
  els.speedInput.style.display = "none";
  els.speedCurrent.style.display = "";
  updateSpeedUI();
  if (state.audio && state.audioReady) syncAudioToTimeline(true);
}

function fmtTime(ms) {
  const safe = Math.max(0, ms || 0);
  const s = Math.floor(safe / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateTimeUI() {
  const replay = state.replay;
  if (!replay || replay.frameCount === 0) {
    els.timeLabel.textContent = "00:00 / 00:00";
    if (els.progressFill) els.progressFill.style.width = "0%";
    if (els.seekMarkers) {
      els.seekMarkers.style.background = "linear-gradient(to right, rgba(255,255,255,0.08), rgba(255,255,255,0.08))";
    }
    return;
  }
  const end = state.durationMs;
  const safeEnd = Math.max(1, end);
  const pct = Math.min(1, Math.max(0, state.currentMs / safeEnd));
  if (els.seek) els.seek.value = String(pct);
  if (els.progressFill) els.progressFill.style.width = (pct * 100).toFixed(2) + "%";
  els.timeLabel.textContent = `${fmtTime(state.currentMs)} / ${fmtTime(end)}`;
  updateIpbMarkers();
}

function detectPauseMarkersMs(replay) {
  const frames = replay?.frames || [];
  if (frames.length < 2) return [];
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i].t - frames[i - 1].t;
    if (gap > PAUSE_GAP_MS) {
      out.push(frames[i - 1].t + gap * 0.5);
    }
  }
  return out;
}

function rebuildReplayMarkers(replay) {
  if (!replay) return;
  replay.pauseMarkersMs = detectPauseMarkersMs(replay);

  const missMarkers = [];
  if (Array.isArray(replay.noteHits) && Array.isArray(replay.notes)) {
    const speedScale = replay.notesTimeScale || 1;
    const n = Math.min(replay.noteHits.length, replay.notes.length);
    for (let i = 0; i < n; i++) {
      if (replay.noteHits[i] === "miss") {
        missMarkers.push(replay.notes[i].ms * speedScale);
      }
    }
  }
  replay.missMarkersMs = missMarkers;
}

function markerLayersFromTimes(timesMs, color, totalMs) {
  if (!Array.isArray(timesMs) || timesMs.length === 0) return [];
  const halfWidthPct = 0.08;
  const layers = [];
  for (const t of timesMs) {
    if (!Number.isFinite(t)) continue;
    const pct = (Math.max(0, Math.min(totalMs, t)) / totalMs) * 100;
    const left = Math.max(0, pct - halfWidthPct).toFixed(4);
    const right = Math.min(100, pct + halfWidthPct).toFixed(4);
    layers.push(`linear-gradient(to right, transparent ${left}%, ${color} ${left}%, ${color} ${right}%, transparent ${right}%)`);
  }
  return layers;
}

function updateIpbMarkers() {
  const replay = state.replay;
  if (!replay || !els.seekMarkers) return;
  const total = Math.max(1, state.durationMs);
  const offset = state.gracePreMs;
  const progressPct = ((Math.max(0, Math.min(total, state.currentMs)) / total) * 100).toFixed(4);

  const missTimes = state.viewerSettings.markerMisses
    ? (replay.missMarkersMs || []).map((t) => t + offset)
    : [];
  const pauseTimes = state.viewerSettings.markerPauses
    ? (replay.pauseMarkersMs || []).map((t) => t + offset)
    : [];

  const layers = [
    ...markerLayersFromTimes(pauseTimes, "rgba(90, 170, 255, 0.95)", total),
    ...markerLayersFromTimes(missTimes, "rgba(255, 82, 96, 0.95)", total),
    `linear-gradient(to right, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.95) ${progressPct}%, rgba(255,255,255,0.08) ${progressPct}%, rgba(255,255,255,0.08) 100%)`,
  ];
  els.seekMarkers.style.background = layers.join(", ");
}

function tick(ts) {
  if (!state.lastTick) state.lastTick = ts;
  const dt = ts - state.lastTick;
  state.lastTick = ts;

  if (dt > 0 && Number.isFinite(dt)) {
    const instant = 1000 / dt;
    state.fpsSmoothed = state.fpsSmoothed > 0
      ? state.fpsSmoothed * 0.9 + instant * 0.1
      : instant;
  }

  if (state.isPlaying && state.replay) {
    const end = state.durationMs;
    state.currentMs += dt * state.speed;
    if (state.currentMs >= end) {
      state.currentMs = end;
      state.isPlaying = false;
      els.playPause.innerHTML = "&#9654;";
      if (state.audio) { try { state.audio.pause(); } catch {} }
    }
  }

  // Keep audio in sync (rate + drift correction)
  if (state.audio && state.audioReady) syncAudioToTimeline(false);

  updateStatsUI();
  updateTimeUI();
  drawReplay();
  requestAnimationFrame(tick);
}

/** Map an accuracy 0..1 to an SS-style letter rank. */
function accuracyToRank(accFraction) {
  if (!Number.isFinite(accFraction)) return "D";
  if (accFraction >= 1.0)   return "SS";
  if (accFraction >= 0.95)  return "S";
  if (accFraction >= 0.90)  return "A";
  if (accFraction >= 0.80)  return "B";
  if (accFraction >= 0.70)  return "C";
  return "D";
}

/** Update combo / score / accuracy / misses / rank / health based on notes whose hit time has passed. */
function updateStatsUI() {
  const replay = state.replay;
  if (!replay || !replay.notes || !replay.noteHits) return;
  const speedScale = replay.notesTimeScale || 1;
  const tNow = replayMs();

  let hits = 0;
  let misses = 0;
  let combo = 0;
  let processed = 0;
  for (let i = 0; i < replay.notes.length; i++) {
    const tHit = replay.notes[i].ms * speedScale;
    if (tHit > tNow) break;
    processed++;
    const v = replay.noteHits[i];
    if (v === "hit") { hits++; combo++; }
    else { misses++; combo = 0; }
  }

  const justSeekedBack = tNow + 1 < state.lastReplayMsForHitsound;
  if (justSeekedBack || !state.isPlaying) {
    state.lastJudgedNoteIndex = processed - 1;
  } else if (processed - 1 > state.lastJudgedNoteIndex) {
    const start = Math.max(0, state.lastJudgedNoteIndex + 1);
    const end = processed - 1;
    for (let i = start; i <= end; i++) {
      if (replay.noteHits[i] === "hit") playHitsound();
    }
    state.lastJudgedNoteIndex = end;
  }
  state.lastReplayMsForHitsound = tNow;

  // SS-style scoring approximation: 1000 per hit + small combo bonus.
  const score = hits * 1000 + Math.min(combo, 64) * 5 * hits;
  const accFrac = processed > 0 ? hits / processed : 0;

  // Health: read straight from the replay's per-frame value. The replay
  // stores it as 0..1, so scale to a percentage for the bar.
  const cursor = sampleCursor(replay, tNow);
  let health = cursor ? cursor.health * 100 : 100;
  if (!Number.isFinite(health)) health = 100;
  if (health < 0) health = 0;
  if (health > 100) health = 100;

  if (els.comboVal)     els.comboVal.textContent     = combo + "x";
  if (els.scoreVal)     els.scoreVal.textContent     = String(score);
  if (els.missVal)      els.missVal.textContent      = String(misses);
  if (els.accVal)       els.accVal.textContent       = (processed > 0 ? (accFrac * 100).toFixed(2) : "0.00") + "%";
  if (els.rankVal)      els.rankVal.textContent      = accuracyToRank(accFrac);
  // X/Y where Y is notes reached so far (hits + misses), not total song notes.
  if (els.noteCountVal) els.noteCountVal.textContent = `${hits}/${hits + misses}`;
  if (els.pointsVal) {
    const totalPoints = Number(replay.awardedSp);
    if (Number.isFinite(totalPoints)) {
      const progress = replay.notes.length > 0 ? (processed / replay.notes.length) : 0;
      els.pointsVal.textContent = formatPoints(totalPoints * progress);
    } else {
      els.pointsVal.textContent = "\u2014";
    }
  }
  if (els.healthFill) {
    els.healthFill.style.width = health.toFixed(1) + "%";
    els.healthFill.style.background = health < 25 ? "#ff7785" : health < 55 ? "#f7c08a" : "#4ade80";
  }

  // Trigger a flash any time the miss tally grows. The render loop reads
  // state.missFlashAt and animates the MISSES panel.
  if (misses > state.lastMissCount) {
    state.missFlashAt = performance.now();
  }
  state.lastMissCount = misses;
}

/** Time in the underlying replay (sample/note timeline) given the playhead.
 *  The playhead lives in an extended timeline that includes a pre-roll and
 *  post-roll grace period; clamped so the cursor stays put during silence. */
function replayMs() {
  const replay = state.replay;
  if (!replay) return 0;
  const raw = state.currentMs - state.gracePreMs;
  const sampleEnd = replay.lastFrameMs;
  if (raw < 0) return 0;
  if (raw > sampleEnd) return sampleEnd;
  return raw;
}

async function loadReplayFile(file) {
  setLoadingState(true, "Loading...", 0.02);
  setLoadedState(false);
  try {
    const buffer = await readReplayFileWithProgress(file);
    setLoadingState(true, "Loading...", 0.82);
    const replay = parseRhr(buffer);
    setLoadingState(true, "Loading...", 0.94);

    // Stop and tear down any prior audio so a new file gets a clean slate
    teardownAudio();
    state.replay = replay;
    const sampleEnd = replay.lastFrameMs;
    state.durationMs = sampleEnd + state.gracePreMs + state.gracePostMs;
    state.currentMs = 0;
    state.isPlaying = false;
    state.pauseCount = 0;
    state.lastMissCount = 0;
    state.missFlashAt = 0;
    state.lastJudgedNoteIndex = -1;
    state.lastReplayMsForHitsound = 0;
    if (els.pauseVal) els.pauseVal.textContent = "0";
    els.playPause.innerHTML = "&#9654;";
    renderMeta(replay);
    rebuildReplayMarkers(replay);
    updateTimeUI();
    setLoadingState(true, "Loading...", 0.97);
    try {
      await loadMapNotes(replay);
    } catch (err) {
      console.warn("Map notes unavailable:", err);
    }

    setLoadingState(true, "Loading...", 1);
    setLoadedState(true);
    setLoadingState(false);
  } catch (err) {
    setLoadingState(false);
    throw err;
  }
}

function attachDnD() {
  const activate = () => els.fileInput.click();
  els.openFile.addEventListener("click", activate);

  els.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await loadReplayFile(file);
    } catch (err) {
      alert(err.message || "Failed to parse replay.");
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      const nextGrid = isEventInPlayfield(e);
      const changed = !state.dragFileOverWindow || state.dragFileOverGrid !== nextGrid;
      state.dragFileOverWindow = true;
      state.dragFileOverGrid = nextGrid;
      if (changed) drawReplay();
    });
  });

  window.addEventListener("dragleave", (e) => {
    if (!state.dragFileOverWindow) return;
    if (e.clientX > 0 && e.clientX < window.innerWidth && e.clientY > 0 && e.clientY < window.innerHeight) return;
    state.dragFileOverWindow = false;
    state.dragFileOverGrid = false;
    drawReplay();
  });

  window.addEventListener("drop", async (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const canDrop = isEventInPlayfield(e);
    state.dragFileOverWindow = false;
    state.dragFileOverGrid = false;
    drawReplay();
    if (!canDrop) return;

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      await loadReplayFile(file);
    } catch (err) {
      alert(err.message || "Failed to parse replay.");
    }
  });
}

function togglePlayback() {
  if (!state.replay) return;
  // Local viewer play/pause must NOT affect the replay pause counter.
  // Keep pause count reserved for player-origin replay data only.
  state.isPlaying = !state.isPlaying;
  els.playPause.innerHTML = state.isPlaying ? "&#9646;&#9646;" : "&#9654;";
  if (state.audio && state.audioReady) syncAudioToTimeline(true);
}

function attachControls() {
  // Play button is gone; click anywhere on the canvas to toggle playback.
  // The toolbar still has a hidden #playPause
  // node; we just don't bind a click listener to it.

  const updateSongTitleHover = (e) => {
    const hb = state.songTitleHitbox;
    if (!hb || !state.mapUrl) {
      if (state.songTitleHover) {
        state.songTitleHover = false;
        els.canvas.style.cursor = "";
        drawReplay();
      }
      return false;
    }
    const rect = els.canvas.getBoundingClientRect();
    const dpr = els.canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * dpr;
    const cy = (e.clientY - rect.top) * dpr;
    const hovered = cx >= hb.x && cx <= hb.x + hb.w && cy >= hb.y && cy <= hb.y + hb.h;
    if (hovered !== state.songTitleHover) {
      state.songTitleHover = hovered;
      els.canvas.style.cursor = hovered ? "pointer" : "";
      drawReplay();
    }
    return hovered;
  };

  // Canvas click:
  // - no replay loaded: open file picker
  // - replay loaded: toggle playback only when clicking inside the grid
  els.canvas.addEventListener("click", (e) => {
    if (!state.replay) {
      if (isEventInPlayfield(e)) {
        els.fileInput.click();
      }
      return;
    }
    if (updateSongTitleHover(e) && state.mapUrl) {
      if (state.isPlaying) togglePlayback();
      window.open(state.mapUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (isEventInPlayfield(e)) {
      togglePlayback();
    }
  });
  els.canvas.addEventListener("pointermove", (e) => {
    updateSongTitleHover(e);
  });

  els.canvas.addEventListener("pointerleave", () => {
    if (state.songTitleHover) {
      state.songTitleHover = false;
      els.canvas.style.cursor = "";
      drawReplay();
    }
  });
  // Spacebar toggles play/pause. Ignore when typing in form inputs.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    e.preventDefault();
    togglePlayback();
  });

  const changeSpeed = (delta) => {
    const next = Math.round((state.speed + delta) / SPEED_STEP) * SPEED_STEP;
    state.speed = clamp(next, SPEED_MIN, SPEED_MAX);
    updateSpeedUI();
    if (state.audio && state.audioReady) syncAudioToTimeline(true);
  };
  els.speedDown.addEventListener("click", () => changeSpeed(-SPEED_STEP));
  els.speedUp.addEventListener("click", () => changeSpeed(SPEED_STEP));

  els.speedCurrent.addEventListener("click", () => {
    els.speedInput.value = state.speed;
    els.speedInput.style.display = "";
    els.speedCurrent.style.display = "none";
    els.speedInput.select();
  });
  els.speedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitSpeedEdit(); }
    if (e.key === "Escape") {
      els.speedInput.style.display = "none";
      els.speedCurrent.style.display = "";
    }
  });
  els.speedInput.addEventListener("blur", commitSpeedEdit);

  els.seek.addEventListener("input", () => {
    if (!state.replay || state.replay.frameCount === 0) return;
    const end = state.durationMs;
    state.currentMs = Number(els.seek.value) * end;
    if (state.audio && state.audioReady) syncAudioToTimeline(true);
    drawReplay();
    updateTimeUI();
  });

  const syncSettingsUI = () => {
    const s = state.viewerSettings;
    const showMain = state.settingsTab === "main";
    const showMarkers = state.settingsTab === "markers";
    const showCustomize = state.settingsTab === "customize";
    els.setTabMain.classList.toggle("active", showMain);
    els.setTabMain.setAttribute("aria-selected", showMain ? "true" : "false");
    els.setTabMarkers.classList.toggle("active", showMarkers);
    els.setTabMarkers.setAttribute("aria-selected", showMarkers ? "true" : "false");
    els.setTabCustomize.classList.toggle("active", showCustomize);
    els.setTabCustomize.setAttribute("aria-selected", showCustomize ? "true" : "false");
    els.settingsMainPanel.classList.toggle("hidden", !showMain);
    els.settingsMarkersPanel.classList.toggle("hidden", !showMarkers);
    els.settingsCustomizePanel.classList.toggle("hidden", !showCustomize);

    els.setHighlightMisses.checked = !!s.highlightMisses;
    els.setShowFps.checked = !!s.showFps;
    els.setReactionTime.value = String(Math.round(s.reactionTimeMs));
    els.setReactionTimeVal.textContent = `${Math.round(s.reactionTimeMs)} ms`;
    els.setShowHud.checked = !!s.showHud;
    els.setShowCursor.checked = !!s.showCursor;
    els.setShowNotes.checked = !!s.showNotes;
    els.setMarkerMisses.checked = !!s.markerMisses;
    els.setMarkerPauses.checked = !!s.markerPauses;
    els.setSidePanelOpacity.value = String(Math.round(clamp(s.sidePanelOpacity, 0, 1) * 100));
    els.setSidePanelOpacityVal.textContent = `${Math.round(clamp(s.sidePanelOpacity, 0, 1) * 100)}%`;
    els.setAudioOffset.value = String(Math.round(s.audioOffsetMs));
    els.setAudioOffsetVal.textContent = `${Math.round(s.audioOffsetMs)} ms`;
    els.setCursorColor.value = normalizeHexColor(s.cursorColor, DEFAULT_VIEWER_SETTINGS.cursorColor);
    els.setNotesColor.value = normalizeHexColor(s.notesColor, DEFAULT_VIEWER_SETTINGS.notesColor);
    
    // Audio volume popup
    state.musicVolume = s.musicVolume;
    state.hitsoundVolume = s.hitsoundVolume;
    els.musicVolumeSlider.value = String(Math.round(s.musicVolume * 100));
    els.hitsoundVolumeSlider.value = String(Math.round(s.hitsoundVolume * 100));
    els.audioPopup.classList.toggle("hidden", !state.audioPopupOpen);
    if (state.audioPopupOpen) positionAudioPanel();
    
    els.settingsPanel.classList.toggle("hidden", !state.settingsOpen);
    if (state.settingsOpen) positionSettingsPanel();
  };

  const positionSettingsPanel = () => {
    if (!els.settingsPanel || !els.viewerSettingsBtn) return;

    const btnRect = els.viewerSettingsBtn.getBoundingClientRect();
    const panelRect = els.settingsPanel.getBoundingClientRect();
    const margin = 12;
    const panelW = panelRect.width || 300;

    const desiredLeft = btnRect.left + btnRect.width * 0.5 - panelW * 0.5;
    const maxLeft = Math.max(margin, window.innerWidth - panelW - margin);
    const clampedLeft = clamp(desiredLeft, margin, maxLeft);
    const bottom = Math.max(margin, window.innerHeight - btnRect.top + 8);

    els.settingsPanel.style.left = `${clampedLeft}px`;
    els.settingsPanel.style.bottom = `${bottom}px`;
  };

  const positionAudioPanel = () => {
    if (!els.audioPopup || !els.audioControlBtn) return;

    const btnRect = els.audioControlBtn.getBoundingClientRect();
    const panelRect = els.audioPopup.getBoundingClientRect();
    const margin = 12;
    const panelW = panelRect.width || 96;

    const desiredLeft = btnRect.left + btnRect.width * 0.5 - panelW * 0.5;
    const maxLeft = Math.max(margin, window.innerWidth - panelW - margin);
    const clampedLeft = clamp(desiredLeft, margin, maxLeft);
    const bottom = Math.max(margin, window.innerHeight - btnRect.top + 8);

    els.audioPopup.style.left = `${clampedLeft}px`;
    els.audioPopup.style.bottom = `${bottom}px`;
  };

  const applySettings = () => {
    saveViewerSettings();
    updateIpbMarkers();
    drawReplay();
  };

  els.viewerSettingsBtn.addEventListener("click", () => {
    state.settingsOpen = !state.settingsOpen;
    syncSettingsUI();
  });

  window.addEventListener("resize", () => {
    if (state.settingsOpen) positionSettingsPanel();
    if (state.audioPopupOpen) positionAudioPanel();
  });

  els.setTabMain.addEventListener("click", () => {
    state.settingsTab = "main";
    syncSettingsUI();
  });

  els.setTabMarkers.addEventListener("click", () => {
    state.settingsTab = "markers";
    syncSettingsUI();
  });

  els.setTabCustomize.addEventListener("click", () => {
    state.settingsTab = "customize";
    syncSettingsUI();
  });

  els.setHighlightMisses.addEventListener("change", () => {
    state.viewerSettings.highlightMisses = els.setHighlightMisses.checked;
    applySettings();
  });

  els.setShowFps.addEventListener("change", () => {
    state.viewerSettings.showFps = els.setShowFps.checked;
    applySettings();
  });

  els.setReactionTime.addEventListener("input", () => {
    state.viewerSettings.reactionTimeMs = clamp(Number(els.setReactionTime.value) || 500, 200, 1200);
    els.setReactionTimeVal.textContent = `${Math.round(state.viewerSettings.reactionTimeMs)} ms`;
    applySettings();
  });

  els.setShowHud.addEventListener("change", () => {
    state.viewerSettings.showHud = els.setShowHud.checked;
    applySettings();
  });

  els.setShowCursor.addEventListener("change", () => {
    state.viewerSettings.showCursor = els.setShowCursor.checked;
    applySettings();
  });

  els.setShowNotes.addEventListener("change", () => {
    state.viewerSettings.showNotes = els.setShowNotes.checked;
    applySettings();
  });

  els.setMarkerMisses.addEventListener("change", () => {
    state.viewerSettings.markerMisses = els.setMarkerMisses.checked;
    applySettings();
  });

  els.setMarkerPauses.addEventListener("change", () => {
    state.viewerSettings.markerPauses = els.setMarkerPauses.checked;
    applySettings();
  });

  els.setSidePanelOpacity.addEventListener("input", () => {
    const pct = clamp(Number(els.setSidePanelOpacity.value) || 0, 0, 100);
    state.viewerSettings.sidePanelOpacity = pct / 100;
    els.setSidePanelOpacityVal.textContent = `${Math.round(pct)}%`;
    applySettings();
  });

  els.setAudioOffset.addEventListener("input", () => {
    const offset = clamp(Number(els.setAudioOffset.value) || 0, -1000, 1000);
    state.viewerSettings.audioOffsetMs = offset;
    els.setAudioOffsetVal.textContent = `${Math.round(offset)} ms`;
    saveViewerSettings();
  });

  els.audioControlBtn.addEventListener("click", () => {
    state.audioPopupOpen = !state.audioPopupOpen;
    syncSettingsUI();
  });

  els.musicVolumeSlider.addEventListener("input", () => {
    const pct = clamp(Number(els.musicVolumeSlider.value) || 0, 0, 100);
    state.viewerSettings.musicVolume = pct / 100;
    state.musicVolume = state.viewerSettings.musicVolume;
    if (state.audio) {
      state.audio.volume = state.musicVolume;
    }
    saveViewerSettings();
  });

  els.hitsoundVolumeSlider.addEventListener("input", () => {
    const pct = clamp(Number(els.hitsoundVolumeSlider.value) || 0, 0, 100);
    state.viewerSettings.hitsoundVolume = pct / 100;
    state.hitsoundVolume = state.viewerSettings.hitsoundVolume;
    saveViewerSettings();
  });

  els.setCursorColor.addEventListener("input", () => {
    state.viewerSettings.cursorColor = normalizeHexColor(els.setCursorColor.value, DEFAULT_VIEWER_SETTINGS.cursorColor);
    applySettings();
  });

  els.setNotesColor.addEventListener("input", () => {
    state.viewerSettings.notesColor = normalizeHexColor(els.setNotesColor.value, DEFAULT_VIEWER_SETTINGS.notesColor);
    applySettings();
  });

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Escape") return;
    if (!state.settingsOpen && !state.audioPopupOpen) return;
    state.settingsOpen = false;
    state.audioPopupOpen = false;
    syncSettingsUI();
  });

  syncSettingsUI();
}

setLoadedState(false);
updateSpeedUI();
initHitsoundPool();
attachDnD();
attachControls();
requestAnimationFrame(tick);
