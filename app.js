const els = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  openFile: document.getElementById("openFile"),
  canvas: document.getElementById("view"),
  playPause: document.getElementById("playPause"),
  speed: document.getElementById("speed"),
  seek: document.getElementById("seek"),
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
  mapLink: document.getElementById("mapLink"),
};

const ctx = els.canvas.getContext("2d");

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
  gracePostMs: 4000,     // silence after the last note / song end
  pauseCount: 0,         // user-triggered pauses during playback
  lastMissCount: 0,      // edge detector for the miss flash effect
  missFlashAt: 0,        // performance.now() of the most recent new miss
};

window.__rvState = state;

const RAW_FRAME_MS = 1000 / 60;

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
  const len = readU8(view, offObj.off);
  offObj.off += 1;
  const bytes = new Uint8Array(view.buffer, offObj.off, len);
  offObj.off += len;
  return new TextDecoder().decode(bytes);
}

function parseRhr(buffer) {
  const view = new DataView(buffer);
  const offObj = { off: 0 };

  const magic = readU32(view, offObj.off);
  offObj.off += 4;
  if (magic !== 20260222) {
    throw new Error("Unsupported replay magic. Expected 20260222 (.rhr)." );
  }

  const rawTimestamp = readI64(view, offObj.off);
  offObj.off += 8;

  const mode = readStr8(view, offObj);
  const mapId = readStr8(view, offObj);
  const mapPageId = Number(readI64(view, offObj.off));
  offObj.off += 8;
  const profileType = readStr8(view, offObj);
  const profileFlag = readU8(view, offObj.off);
  offObj.off += 1;
  const modsJson = readStr8(view, offObj);

  const replayStatus = readU8(view, offObj.off);
  offObj.off += 1;
  const accuracy = readF32(view, offObj.off);
  offObj.off += 4;
  const unknownA = readU64(view, offObj.off);
  offObj.off += 8;
  const mapLengthSec = readF32(view, offObj.off);
  offObj.off += 4;
  const noteCount = readU32(view, offObj.off);
  offObj.off += 4;
  const unknownB = readU32(view, offObj.off);
  offObj.off += 4;
  const unknownC = readF32(view, offObj.off);
  offObj.off += 4;
  const unknownD = readI32(view, offObj.off);
  offObj.off += 4;
  const frameCount = readU32(view, offObj.off);
  offObj.off += 4;

  const frames = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const t = readF32(view, offObj.off);
    const x = readF32(view, offObj.off + 4);
    const y = readF32(view, offObj.off + 8);
    const w = readF32(view, offObj.off + 12);
    frames[i] = { t, x, y, w };
    offObj.off += 16;
  }

  let frameFlags = new Uint8Array(0);
  if (offObj.off + frameCount <= view.byteLength) {
    frameFlags = new Uint8Array(buffer, offObj.off, frameCount);
    offObj.off += frameCount;
  }

  // Last replay-time millisecond (frame index N-1 at 60Hz). Used as a
  // fallback when SSPM length is unknown.
  const lastFrameMs = frameCount > 0 ? (frameCount - 1) * RAW_FRAME_MS : 0;

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
    frameFlags,
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

function chooseDurationMs(frames, mapLengthSec) {
  const frameDurationMs = Math.max(1000, (frames.length / 60) * 1000);

  if (isFiniteNumber(mapLengthSec) && mapLengthSec > 5 && mapLengthSec < 3600) {
    const mapMs = mapLengthSec * 1000;
    const ratio = Math.abs(mapMs - frameDurationMs) / Math.max(1, frameDurationMs);
    // Many replays store 100.0 here as a placeholder; avoid forcing all maps to 100s.
    if (Math.abs(mapLengthSec - 100) > 0.01 && ratio < 0.3) {
      return mapMs;
    }
  }

  if (frames.length > 2) {
    const candidates = [];
    for (let c = 0; c < 4; c++) {
      let prev = -Infinity;
      let nondecreasing = 0;
      let finiteCount = 0;
      for (let i = 0; i < frames.length; i++) {
        const v = c === 0 ? frames[i].t : c === 1 ? frames[i].x : c === 2 ? frames[i].y : frames[i].w;
        if (!isFiniteNumber(v)) continue;
        finiteCount++;
        if (v >= prev) nondecreasing++;
        prev = v;
      }
      if (finiteCount > 0) {
        candidates.push({ c, ratio: nondecreasing / finiteCount, first: getChannel(frames[0], c), last: getChannel(frames[frames.length - 1], c) });
      }
    }

    for (const cand of candidates) {
      const span = cand.last - cand.first;
      if (cand.ratio > 0.95 && isFiniteNumber(span) && span > 100 && span < 6000000) {
        return span;
      }
    }
  }

  return frameDurationMs;
}

function getChannel(frame, c) {
  if (c === 0) return frame.t;
  if (c === 1) return frame.x;
  if (c === 2) return frame.y;
  return frame.w;
}


function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ─── 3D Rendering System ─────────────────────────────────────────────────

// World dimensions: the hit plane is a flat square ±GRID_HALF in x and y, at z = 0.
// Notes (when added) will spawn at NOTE_SPAWN_Z and travel toward z = 0.
const GRID_HALF = 1.4;
const NOTE_SPAWN_Z = 18;

// Note travel timing (in song-time ms, before speedScale)
const NOTE_LOOKAHEAD_MS = 500; // distance from spawn to hit plane in song-time
// Hit radius in world units. SS hit box is ~1.14 units in 0..2 grid coords ≈ 0.57 cells.
const NOTE_HIT_RADIUS_CELLS = 0.62;

// Fixed perspective camera. Straight-on Rhythia POV: dead center, level
// (no pitch). Pulled back ~20% from the original distance for a wider
// view of the playfield.
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

  // NDC [-1,1] → pixel space; NDC Y is flipped (canvas Y increases downward)
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

// ─── Notes (SSPM v2) ────────────────────────────────────────────────────

/**
 * Parse a Sound Space Plus Map v2 file.
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
      // Unknown marker type — we can't reliably skip without a generic value reader.
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
  return "audio/mpeg";
}

/** Fetch the beatmap page from Rhythia's API and download + parse the .sspm. */
async function fetchMapAssets(mapPageId) {
  if (!Number.isFinite(mapPageId) || mapPageId <= 0) return null;
  const apiRes = await fetch("https://production.rhythia.com/api/getBeatmapPage", {
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
  return { ...parsed, beatmap: meta.beatmap };
}

/** Convert SSPM grid coordinates (x,y in [0,2]) to world coords on the hit plane.
 *  In Sound Space, x=0,1,2 are *cell centers*, not the outer edges of the playfield.
 *  So a 3-cell grid with half-extent GRID_HALF puts cells at ±(2/3)*GRID_HALF and 0. */
function noteToWorld(x, y) {
  const CELL = (2 * GRID_HALF) / 3;
  return {
    wx: (x - 1) * CELL,         // x=0 → -CELL, x=1 → 0, x=2 → +CELL
    wy: (1 - y) * CELL,         // y=0 (top in SS) → +CELL, y=2 (bottom) → -CELL
    wz: 0,
  };
}

/** Cursor decoding has been retired (frame-flag deltas never produced an
 *  accurate playhead). Every note is reported as a hit until a working
 *  decoder is rebuilt. The sliced miss markers still flow through the
 *  rest of the pipeline, so the moment we have real data we just
 *  populate the array here. */
function computeNoteHits(replay /*, speedScale */) {
  if (!replay || !replay.notes) return null;
  const out = new Array(replay.notes.length);
  for (let i = 0; i < replay.notes.length; i++) out[i] = "hit";
  return out;
}

async function loadMapNotes(replay) {
  const data = await fetchMapAssets(replay.mapPageId);
  if (!data || !data.notes || data.notes.length === 0) return;

  // Map note timing (raw song ms) to replay timeline ms. Replay frames are
  // recorded at the *played* speed, so notes need to be scaled to the replay
  // duration so that the last note lines up with the song's end.
  const mapMs = Math.max(
    data.lastMs || 0,
    data.notes[data.notes.length - 1]?.ms || 0,
  );
  const replayMs = state.durationMs || replay.lastFrameMs;
  let speedScale = 1;
  if (mapMs > 1000 && replayMs > 1000) {
    speedScale = replayMs / mapMs;
  }

  replay.notes = data.notes;
  replay.notesTimeScale = speedScale;
  replay.noteHits = computeNoteHits(replay, speedScale);

  if (Array.isArray(replay.noteHits)) {
    let misses = 0;
    for (const v of replay.noteHits) if (v === "miss") misses++;
    replay.missCount = misses;
    if (els.missVal) els.missVal.textContent = String(misses);
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

  const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;

  state.audio = audio;
  state.audioUrl = url;
  state.audioReady = false;
  state.audioTimeScale = notesTimeScale || 1;

  audio.addEventListener("loadedmetadata", () => {
    state.audioReady = true;
    syncAudioToTimeline(true);
  });
  audio.addEventListener("error", () => {
    console.warn("Audio failed to load");
    teardownAudio();
  });
}

function teardownAudio() {
  if (state.audio) {
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
  // Audio playback rate must equal replay-speed / notesTimeScale so that
  // d(songTime)/d(realTime) matches d(replayTime)/d(realTime) / notesTimeScale.
  const desiredRate = (state.speed || 1) / (state.audioTimeScale || 1);
  if (Math.abs(audio.playbackRate - desiredRate) > 0.001) {
    audio.playbackRate = Math.max(0.0625, Math.min(16, desiredRate));
  }
  if (force || Math.abs(audio.currentTime - targetSec) > 0.12) {
    try { audio.currentTime = Math.max(0, Math.min(audio.duration || targetSec, targetSec)); } catch {}
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

/** Render notes spawning at the back and traveling toward the hit plane.
 *  - Hit notes vanish at the hit time.
 *  - Missed notes continue flying past the hit plane for NOTE_MISS_FLY_MS,
 *    fading as they pass the player. */
function drawNotes(canvasW, canvasH) {
  const replay = state.replay;
  if (!replay || !replay.notes || replay.notes.length === 0) return;

  const speedScale = replay.notesTimeScale || 1;
  const tNow = replayMs();

  const lookahead = NOTE_LOOKAHEAD_MS * speedScale;
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

  // Collect visible notes — only future / current. Past notes (hit OR miss)
  // simply disappear once they reach the hit plane.
  const notes = replay.notes;
  const visible = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const adjMs = n.ms * speedScale;
    const dt = adjMs - tNow;
    if (dt > lookahead || dt < 0) continue;
    const verdict = hits ? hits[i] : "unknown";
    visible.push({ n, idx: i, dt, verdict });
  }
  // Far first so closer notes overlap correctly
  visible.sort((a, b) => b.dt - a.dt);

  for (const v of visible) {
    const { n, dt } = v;
    const z = (dt / lookahead) * NOTE_SPAWN_Z;
    const w = noteToWorld(n.x, n.y);

    const center = project3D(w.wx, w.wy, z, canvasW, canvasH);
    if (!center) continue;

    const depthScale = Math.max(0.06, refProj.depth / Math.max(1e-6, center.depth));
    const halfPx = Math.max(3, refPixelHalf * depthScale);

    const closeness = 1 - Math.min(1, dt / lookahead); // 0 far → 1 at hit
    const alpha = 0.35 + closeness * 0.55;
    // All notes use the same blue regardless of verdict.
    const baseColor = "110, 195, 255";
    if (alpha <= 0) continue;

    const cx = center.px;
    const cy = center.py;
    const radius = halfPx * 0.32;
    const stroke = Math.max(1.5, halfPx * 0.16);

    // Single hollow rounded square — no inner outline.
    ctx.lineWidth = stroke;
    ctx.strokeStyle = `rgba(${baseColor}, ${alpha.toFixed(3)})`;
    roundRect(cx - halfPx, cy - halfPx, halfPx * 2, halfPx * 2, radius);
    ctx.stroke();
  }
}

function draw3DField(canvasW, canvasH) {
  const G = GRID_HALF;
  // Match the real Rhythia HUD: no playfield fill (the bg is just black),
  // no outer border — only four L-shaped corner brackets framing the
  // projected hit plane.
  const tl = project3D(-G,  G, 0, canvasW, canvasH);
  const tr = project3D( G,  G, 0, canvasW, canvasH);
  const br = project3D( G, -G, 0, canvasW, canvasH);
  const bl = project3D(-G, -G, 0, canvasW, canvasH);
  if (!tl || !tr || !br || !bl) return;

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

function drawReplay() {
  ensureCanvasSize();
  const replay = state.replay;
  const w = els.canvas.width;
  const h = els.canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!replay || replay.frameCount === 0) {
    ctx.fillStyle = "rgba(245, 247, 255, 0.8)";
    ctx.font = "600 20px 'Space Grotesk'";
    ctx.fillText("Load a replay to begin", 24, 40);
    return;
  }

  // Draw 3D perspective field
  draw3DField(w, h);

  // Draw notes (back-to-front).
  drawNotes(w, h);

  // Cursor rendering removed — see computeNoteHits comment. The HUD walls
  // sit on top so the playfield reads as the focal element.
  drawHUDWalls(w, h);
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

  // Canvas corners (front edges) — kept for layout calls below.
  const ftl = { px: 0,  py: 0  };
  const ftr = { px: w,  py: 0  };
  const fbr = { px: w,  py: h  };
  const fbl = { px: 0,  py: h  };

  // No wall fills, no seam outlines, no mitre lines — only the central
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

  // Header is anchored to the canvas top, NOT the playfield — matches the
  // real Rhythia HUD where title/time stack vertically with a thin divider
  // running underneath.
  const centerX = w / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Title line
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 22px 'Space Grotesk'";
  ctx.fillText(songName, centerX, 40);

  // Time line
  ctx.fillStyle = "rgba(220,225,235,0.85)";
  ctx.font = "600 18px 'JetBrains Mono'";
  ctx.fillText(time, centerX, 70);

  // Top progress bar — display-only, grey track + white fill, sits under
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
  const w = els.canvas.width;
  const h = els.canvas.height;

  // --- Health bar: pinned just under the projected playfield bottom edge,
  // spans the playfield width (with a small outset). Green/red health colors.
  const healthPct = Math.max(0, Math.min(100, parseFloat(els.healthFill?.style.width || "100") || 0));
  const healthCol = els.healthFill?.style.background || "#4ade80";
  const HEALTH_H  = 12;
  const healthY   = bl.py + 22;
  const padX      = 40;
  const xLeft     = bl.px - padX;
  const xRight    = br.px + padX;
  const barW      = xRight - xLeft;
  ctx.fillStyle   = "rgba(255,255,255,0.10)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth   = 1;
  roundRect(xLeft, healthY, barW, HEALTH_H, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = healthCol;
  roundRect(xLeft, healthY, barW * (healthPct / 100), HEALTH_H, 6);
  ctx.fill();

  // --- Interactive song-progress bar: bottom of the canvas. Same colors
  // as the top progress bar (grey track, white fill) so it doesn't look
  // like the health bar.
  const pct = parseFloat(els.progressFill?.style.width || "0") || 0;
  const margin = Math.max(40, w * 0.06);
  const sxLeft  = margin;
  const sBarW   = w - margin * 2;
  const sBarH   = 8;
  const sy      = h - 28;

  state.seekBarRect = { x: sxLeft, y: sy, w: sBarW, h: sBarH };

  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(sxLeft, sy, sBarW, sBarH, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  roundRect(sxLeft, sy, sBarW * (pct / 100), sBarH, 4);
  ctx.fill();

  // Handle dot for drag affordance
  const hx = sxLeft + sBarW * (pct / 100);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(hx, sy + sBarH / 2, 6, 0, Math.PI * 2);
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
  // Real Rhythia: muted grey UPPERCASE label sits ABOVE the bold white
  // value, both centered.
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
  // Sit the column close to the playfield's left bracket (slightly inset
  // from canvas left), matching the real Rhythia HUD where COMBO/SS/ACC
  // hug the field instead of pinning to the screen edge.
  const h = els.canvas.height;
  const colX = Math.max(110, tl.px - 130);

  // Combo triangle — aligned vertically with the top playfield bracket
  drawComboTriangle(colX, tl.py + 30, els.comboVal?.textContent || "0x");

  // PAUSES — just below the combo triangle
  drawSideStat(colX, tl.py + 130,
    "PAUSES",
    els.pauseVal?.textContent || "0",
    { size: 22, gap: 28 });

  // Rank — large letter (no label in real game), centered vertically
  const rank = els.rankVal?.textContent || "D";
  ctx.fillStyle = "#f3c79a";
  ctx.font = "700 60px 'Space Grotesk'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(rank, colX, h * 0.55);

  // ACCURACY — closer to the rank letter, not pinned to the bottom bracket
  drawSideStat(colX, h * 0.72,
    "ACCURACY",
    els.accVal?.textContent || "0%",
    { size: 22, gap: 28 });
}

function drawRightWall(ftr, tr, br, fbr) {
  const w = els.canvas.width;
  const h = els.canvas.height;
  const colX = Math.min(w - 110, tr.px + 130);

  drawSideStat(colX, tr.py + 30,
    "SCORE",
    els.scoreVal?.textContent || "0",
    { size: 24, gap: 28 });

  drawSideStat(colX, tr.py + 130,
    "POINTS",
    els.pointsVal?.textContent || "0",
    { size: 22, gap: 28 });

  // MISSES — default white, only flashes red briefly when a miss lands.
  const flashElapsed = performance.now() - state.missFlashAt;
  const FLASH_DUR = 450;
  let missColor = "#ffffff";
  let shakeX = 0;
  if (state.missFlashAt > 0 && flashElapsed < FLASH_DUR) {
    const k = 1 - flashElapsed / FLASH_DUR;
    // Lerp red → white
    const r = 255;
    const g = Math.round(255 - (255 - 119) * k);
    const b = Math.round(255 - (255 - 133) * k);
    missColor = `rgb(${r},${g},${b})`;
    shakeX = Math.sin(flashElapsed * 0.08) * 4 * k;
  }
  ctx.save();
  ctx.translate(shakeX, 0);
  drawSideStat(colX, h * 0.55 - 14,
    "MISSES",
    els.missVal?.textContent || "0",
    { size: 22, color: missColor, gap: 28 });
  ctx.restore();

  // NOTES — closer to the misses block, not pinned to the bottom bracket
  drawSideStat(colX, h * 0.72,
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

/** Friendly short tag for a Rhythia mod identifier. */
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

  // Map link
  if (mapUrl) {
    els.mapLink.href = mapUrl;
    els.mapLink.textContent = `map #${replay.mapPageId} ↗`;
    els.mapLink.classList.remove("hidden");
  } else {
    els.mapLink.classList.add("hidden");
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function setLoadedState(loaded) {
  els.playPause.disabled = !loaded;
  els.speed.disabled = !loaded;
  els.seek.disabled = !loaded;
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
    return;
  }
  const end = state.durationMs;
  const safeEnd = Math.max(1, end);
  const pct = Math.min(1, Math.max(0, state.currentMs / safeEnd));
  if (els.seek) els.seek.value = String(pct);
  if (els.progressFill) els.progressFill.style.width = (pct * 100).toFixed(2) + "%";
  els.timeLabel.textContent = `${fmtTime(state.currentMs)} / ${fmtTime(end)}`;
}

function tick(ts) {
  if (!state.lastTick) state.lastTick = ts;
  const dt = ts - state.lastTick;
  state.lastTick = ts;

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

  // SS-style scoring approximation: 1000 per hit + small combo bonus.
  const score = hits * 1000 + Math.min(combo, 64) * 5 * hits;
  const accFrac = processed > 0 ? hits / processed : 0;

  // Health: starts full, each miss subtracts ~3.5%, each hit recovers ~0.7%.
  // No-fail mod prevents bottoming out from killing playback (we just clamp >= 0).
  let health = 100 - misses * 3.5 + hits * 0.7;
  if (health < 0) health = 0;
  if (health > 100) health = 100;

  if (els.comboVal)     els.comboVal.textContent     = combo + "x";
  if (els.scoreVal)     els.scoreVal.textContent     = String(score);
  if (els.missVal)      els.missVal.textContent      = String(misses);
  if (els.accVal)       els.accVal.textContent       = (processed > 0 ? (accFrac * 100).toFixed(1) : "0") + "%";
  if (els.rankVal)      els.rankVal.textContent      = accuracyToRank(accFrac);
  // X/Y where Y is the number of notes the player has reached so far
  // (hits + misses), NOT the total in the song. Mirrors how Rhythia's HUD
  // counts in real time.
  if (els.noteCountVal) els.noteCountVal.textContent = `${hits}/${hits + misses}`;
  if (els.pointsVal)    els.pointsVal.textContent    = "\u2014"; // pp not derivable from .rhr yet
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
  const buffer = await file.arrayBuffer();
  const replay = parseRhr(buffer);
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
  if (els.pauseVal) els.pauseVal.textContent = "0";
  els.playPause.innerHTML = "&#9654;";
  renderMeta(replay);
  setLoadedState(true);
  els.dropZone.classList.add("hidden");
  updateTimeUI();
  drawReplay();

  // Asynchronously fetch and decode the beatmap so we can render notes.
  loadMapNotes(replay).then(() => {
    if (state.replay === replay) drawReplay();
  }).catch((err) => console.warn("Map notes unavailable:", err));
}

function attachDnD() {
  const activate = () => els.fileInput.click();
  els.openFile.addEventListener("click", activate);
  els.dropZone.addEventListener("click", activate);
  els.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });

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
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove("drag-over");
    });
  });

  els.dropZone.addEventListener("drop", async (e) => {
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
  // Pause counter only ticks when the user pauses an active playback
  // (not when they press play to start). This mirrors how Rhythia counts
  // user-triggered pauses during a run.
  const willPause = state.isPlaying;
  state.isPlaying = !state.isPlaying;
  els.playPause.innerHTML = state.isPlaying ? "&#9646;&#9646;" : "&#9654;";
  if (willPause) {
    state.pauseCount += 1;
    if (els.pauseVal) els.pauseVal.textContent = String(state.pauseCount);
  }
  if (state.audio && state.audioReady) syncAudioToTimeline(true);
}

function attachControls() {
  // Play button is gone — click anywhere on the canvas (above the seek
  // bar) to toggle playback. The toolbar still has a hidden #playPause
  // node; we just don't bind a click listener to it.

  // Canvas click → toggle playback (but only when not interacting with the
  // seek bar, which has its own pointer handlers below).
  els.canvas.addEventListener("click", (e) => {
  if (!state.replay) return;
    const rect = els.canvas.getBoundingClientRect();
    const dpr = els.canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * dpr;
    const cy = (e.clientY - rect.top) * dpr;
    const sb = state.seekBarRect;
    if (sb && cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y - 12 && cy <= sb.y + sb.h + 12) {
      return; // seek bar handles this
    }
    togglePlayback();
  });

  // Seek bar drag handling (pointer-based for canvas)
  let dragging = false;
  const seekFromEvent = (e) => {
    const rect = els.canvas.getBoundingClientRect();
    const dpr = els.canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * dpr;
    const sb = state.seekBarRect;
    if (!sb) return;
    const t = Math.max(0, Math.min(1, (cx - sb.x) / sb.w));
    state.currentMs = t * state.durationMs;
    if (state.audio && state.audioReady) syncAudioToTimeline(true);
    updateTimeUI();
    drawReplay();
  };
  els.canvas.addEventListener("pointerdown", (e) => {
    if (!state.replay) return;
    const rect = els.canvas.getBoundingClientRect();
    const dpr = els.canvas.width / rect.width;
    const cx = (e.clientX - rect.left) * dpr;
    const cy = (e.clientY - rect.top) * dpr;
    const sb = state.seekBarRect;
    if (!sb) return;
    if (cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y - 12 && cy <= sb.y + sb.h + 12) {
      dragging = true;
      els.canvas.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    }
  });
  els.canvas.addEventListener("pointermove", (e) => {
    if (dragging) seekFromEvent(e);
  });
  els.canvas.addEventListener("pointerup", (e) => {
    if (dragging) {
      dragging = false;
      try { els.canvas.releasePointerCapture(e.pointerId); } catch {}
    }
  });

  // Spacebar = play/pause, matching the in-game shortcut. Ignored while
  // typing into form inputs so we don't hijack other UI.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    togglePlayback();
  });

  els.speed.addEventListener("change", () => {
    state.speed = Number(els.speed.value);
    if (state.audio && state.audioReady) syncAudioToTimeline(true);
  });

  els.seek.addEventListener("input", () => {
    if (!state.replay || state.replay.frameCount === 0) return;
    const end = state.durationMs;
    state.currentMs = Number(els.seek.value) * end;
    if (state.audio && state.audioReady) syncAudioToTimeline(true);
    drawReplay();
    updateTimeUI();
  });
}

setLoadedState(false);
attachDnD();
attachControls();
requestAnimationFrame(tick);
