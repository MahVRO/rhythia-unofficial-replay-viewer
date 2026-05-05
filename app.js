const els = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  openFile: document.getElementById("openFile"),
  canvas: document.getElementById("view"),
  playPause: document.getElementById("playPause"),
  speed: document.getElementById("speed"),
  seek: document.getElementById("seek"),
  timeLabel: document.getElementById("timeLabel"),
  // overlay elements
  songName: document.getElementById("songName"),
  songArtist: document.getElementById("songArtist"),
  songDiff: document.getElementById("songDiff"),
  songMods: document.getElementById("songMods"),
  comboVal: document.getElementById("comboVal"),
  scoreVal: document.getElementById("scoreVal"),
  accVal: document.getElementById("accVal"),
  missVal: document.getElementById("missVal"),
  playerName: document.getElementById("playerName"),
  playerType: document.getElementById("playerType"),
  mapLink: document.getElementById("mapLink"),
};

const ctx = els.canvas.getContext("2d");

const state = {
  replay: null,
  isPlaying: false,
  currentMs: 0,
  durationMs: 0,
  motionSmoothing: 0,
  motionModeOverride: "flags-abs",
  speed: 1,
  lastTick: 0,
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
    samples: buildPlaybackSamples(frames, frameFlags, mapLengthSec),
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

function choosePositionChannels(frames) {
  const channels = [0, 1, 2, 3].map((c) => {
    let finiteCount = 0;
    let inRangeCount = 0;
    for (let i = 0; i < frames.length; i++) {
      const v = getChannel(frames[i], c);
      if (!isFiniteNumber(v)) continue;
      finiteCount++;
      if (v >= -3.2 && v <= 3.2) inRangeCount++;
    }
    return {
      c,
      finiteCount,
      inRangeRatio: finiteCount ? inRangeCount / finiteCount : 0,
      score: finiteCount ? (inRangeCount / finiteCount) * finiteCount : 0,
    };
  });

  const sorted = channels.slice().sort((a, b) => b.score - a.score);
  if (sorted.length >= 2 && sorted[0].inRangeRatio > 0.2 && sorted[1].inRangeRatio > 0.2) {
    return { xChan: sorted[0].c, yChan: sorted[1].c, confidence: Math.min(sorted[0].inRangeRatio, sorted[1].inRangeRatio) };
  }

  return { xChan: -1, yChan: -1, confidence: 0 };
}

function decodeFlagToNorm(flag) {
  const hi = (flag >> 4) & 0x0f;
  const lo = flag & 0x0f;
  const x = hi / 15;
  const y = lo / 15;
  return { x, y };
}

function decodeFlagNibbles(flag, swapAxes = false) {
  const hi = (flag >> 4) & 0x0f;
  const lo = flag & 0x0f;
  if (swapAxes) {
    return { xNib: lo, yNib: hi };
  }
  return { xNib: hi, yNib: lo };
}

function nibbleToSigned(n) {
  return n <= 7 ? n : n - 16;
}

function applyAxisTransform(x, y, invX, invY) {
  return {
    x: invX ? 1 - x : x,
    y: invY ? 1 - y : y,
  };
}

function scoreCursorTrajectory(points) {
  if (points.length < 4) {
    return -1e9;
  }

  const coverage = measureCoverage(points);
  const edgeLock = edgeLockRatio(points);
  const smoothness = scorePointSeries(points);

  const steps = [];
  let bigJumps = 0;
  let hugeJumps = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].xNorm - points[i - 1].xNorm;
    const dy = points[i].yNorm - points[i - 1].yNorm;
    const d = Math.hypot(dx, dy);
    if (!Number.isFinite(d)) continue;
    steps.push(d);
    if (d > 0.22) bigJumps++;
    if (d > 0.32) hugeJumps++;
  }

  if (!steps.length) {
    return -1e9;
  }

  const meanStep = steps.reduce((a, b) => a + b, 0) / steps.length;
  const p95Step = percentile(steps, 0.95);
  const p99Step = percentile(steps, 0.99);
  const bigJumpRatio = bigJumps / steps.length;
  const hugeJumpRatio = hugeJumps / steps.length;

  // Reward broad but not edge-locked coverage and smooth local motion,
  // penalize pathological teleports and excessive edge sticking.
  const score =
    smoothness * 1.2 +
    coverage.diag * 0.7 -
    edgeLock * 0.8 -
    bigJumpRatio * 2.0 -
    hugeJumpRatio * 4.5 -
    p95Step * 0.6 -
    p99Step * 0.7 -
    Math.abs(meanStep - 0.03) * 2.5;

  return score;
}

function clampStep(prevX, prevY, nextX, nextY, maxStep) {
  const dx = nextX - prevX;
  const dy = nextY - prevY;
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d <= maxStep || maxStep <= 0) {
    return { x: clamp01(nextX), y: clamp01(nextY), clamped: false, step: d };
  }
  const s = maxStep / d;
  return {
    x: clamp01(prevX + dx * s),
    y: clamp01(prevY + dy * s),
    clamped: true,
    step: maxStep,
  };
}

function buildSamplesFromFlags(frames, frameFlags, options) {
  const samples = new Array(frames.length);
  if (frameFlags.length < frames.length) {
    return null;
  }

  const {
    mode,
    swapAxes = false,
    invX = false,
    invY = false,
    holdZero = true,
    deltaScale = 48,
    antiSpike = false,
    name,
  } = options;

  let x = 0.5;
  let y = 0.5;
  let avgStep = 0.03;
  let clampCount = 0;

  for (let i = 0; i < frames.length; i++) {
    const flag = frameFlags[i];
    const { xNib, yNib } = decodeFlagNibbles(flag, swapAxes);

    if (mode === "abs") {
      if (!holdZero || flag !== 0 || i === 0) {
        x = xNib / 15;
        y = yNib / 15;
      }
    } else {
      if (flag !== 0 || i === 0) {
        const rawX = x + nibbleToSigned(xNib) / deltaScale;
        const rawY = y + nibbleToSigned(yNib) / deltaScale;
        if (antiSpike && i > 0) {
          const adaptiveMaxStep = Math.max(0.085, Math.min(0.24, avgStep * 5.5 + 0.03));
          const clamped = clampStep(x, y, rawX, rawY, adaptiveMaxStep);
          x = clamped.x;
          y = clamped.y;
          if (clamped.clamped) clampCount++;
          if (Number.isFinite(clamped.step)) {
            avgStep = avgStep * 0.97 + clamped.step * 0.03;
          }
        } else {
          x = clamp01(rawX);
          y = clamp01(rawY);
        }
      }
    }

    const tr = applyAxisTransform(x, y, invX, invY);
    samples[i] = {
      t: i * RAW_FRAME_MS,
      xNorm: tr.x,
      yNorm: tr.y,
      flag,
    };
  }

  samples.sourceName = name;
  samples.sourceScore = scoreCursorTrajectory(samples) - (clampCount / Math.max(1, frames.length)) * 0.8;
  return samples;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function remapByRange(v, lo, hi) {
  const span = Math.max(1e-9, hi - lo);
  return clamp01((v - lo) / span);
}

function scorePointSeries(points) {
  if (points.length < 4) return 0;
  let smoothSteps = 0;
  let validSteps = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].xNorm - points[i - 1].xNorm;
    const dy = points[i].yNorm - points[i - 1].yNorm;
    const d = Math.hypot(dx, dy);
    if (!Number.isFinite(d)) continue;
    validSteps++;
    if (d < 0.12) smoothSteps++;
  }
  if (!validSteps) return 0;
  const smoothness = smoothSteps / validSteps;
  return smoothness;
}

function measureCoverage(points) {
  if (!points.length) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, diag: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.xNorm) || !Number.isFinite(p.yNorm)) continue;
    if (p.xNorm < minX) minX = p.xNorm;
    if (p.xNorm > maxX) maxX = p.xNorm;
    if (p.yNorm < minY) minY = p.yNorm;
    if (p.yNorm > maxY) maxY = p.yNorm;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, diag: 0 };
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const diag = Math.hypot(width, height);
  return { minX, maxX, minY, maxY, width, height, diag };
}

function edgeLockRatio(points) {
  if (!points.length) return 1;
  let edge = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.xNorm < 0.03 || p.xNorm > 0.97 || p.yNorm < 0.03 || p.yNorm > 0.97) {
      edge++;
    }
  }
  return edge / points.length;
}

function evaluateCandidate(points, type) {
  const smoothness = scorePointSeries(points);
  const coverage = measureCoverage(points);
  const edgeLock = edgeLockRatio(points);

  const minWidth = type === "flags" ? 0.04 : 0.08;
  const minHeight = type === "flags" ? 0.04 : 0.08;
  const minDiag = type === "flags" ? 0.10 : 0.16;

  const valid = coverage.width >= minWidth && coverage.height >= minHeight && coverage.diag >= minDiag;
  const score = smoothness + coverage.diag * 0.55 - edgeLock * 0.25;

  return { valid, score, smoothness, coverage, edgeLock };
}

function smoothAndClamp(points, alpha = 0.22, maxStep = 0.06) {
  if (!points.length) return points;
  const out = new Array(points.length);
  out[0] = { ...points[0] };
  for (let i = 1; i < points.length; i++) {
    let x = out[i - 1].xNorm + (points[i].xNorm - out[i - 1].xNorm) * alpha;
    let y = out[i - 1].yNorm + (points[i].yNorm - out[i - 1].yNorm) * alpha;

    const dx = x - out[i - 1].xNorm;
    const dy = y - out[i - 1].yNorm;
    const d = Math.hypot(dx, dy);
    if (d > maxStep) {
      const s = maxStep / d;
      x = out[i - 1].xNorm + dx * s;
      y = out[i - 1].yNorm + dy * s;
    }

    out[i] = {
      ...points[i],
      xNorm: clamp01(x),
      yNorm: clamp01(y),
    };
  }
  return out;
}

function smoothMovingAverage(points, radius = 3) {
  if (points.length < 3 || radius <= 0) return points;
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    let sx = 0;
    let sy = 0;
    let c = 0;
    const from = Math.max(0, i - radius);
    const to = Math.min(points.length - 1, i + radius);
    for (let j = from; j <= to; j++) {
      sx += points[j].xNorm;
      sy += points[j].yNorm;
      c++;
    }
    out[i] = {
      ...points[i],
      xNorm: clamp01(sx / c),
      yNorm: clamp01(sy / c),
    };
  }
  return out;
}

function normalizeTrajectory(points) {
  if (!points.length) return points;

  const xs = points.map((p) => p.xNorm);
  const ys = points.map((p) => p.yNorm);
  const x5 = percentile(xs, 0.05);
  const x95 = percentile(xs, 0.95);
  const y5 = percentile(ys, 0.05);
  const y95 = percentile(ys, 0.95);

  // Keep some margin so path does not clip into borders.
  const outMin = 0.08;
  const outMax = 0.92;
  const outSpan = outMax - outMin;

  if (Math.abs(x95 - x5) < 1e-5 || Math.abs(y95 - y5) < 1e-5) {
    return points;
  }

  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const nx = outMin + remapByRange(points[i].xNorm, x5, x95) * outSpan;
    const ny = outMin + remapByRange(points[i].yNorm, y5, y95) * outSpan;
    out[i] = { ...points[i], xNorm: clamp01(nx), yNorm: clamp01(ny) };
  }
  return out;
}

function buildCandidateFromFlags(frames, frameFlags, durationMs) {
  if (frameFlags.length < frames.length) return null;
  const candidates = [];

  const absoluteModes = [
    { name: "flags-abs", xf: (n) => n.x, yf: (n) => n.y },
    { name: "flags-abs-swap", xf: (n) => n.y, yf: (n) => n.x },
    { name: "flags-abs-invY", xf: (n) => n.x, yf: (n) => 1 - n.y },
    { name: "flags-abs-invX", xf: (n) => 1 - n.x, yf: (n) => n.y },
  ];

  for (const mode of absoluteModes) {
    const points = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const tMs = frames.length <= 1 ? 0 : (i / (frames.length - 1)) * durationMs;
      const n = decodeFlagToNorm(frameFlags[i]);
      points[i] = {
        t: tMs,
        xNorm: clamp01(mode.xf(n)),
        yNorm: clamp01(mode.yf(n)),
        flag: frameFlags[i],
      };
    }
    const evalResult = evaluateCandidate(points, "flags");
    if (!evalResult.valid) continue;
    candidates.push({ source: mode.name, points, score: evalResult.score });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function buildCandidateFromChannels(frames, frameFlags, durationMs, xChan, yChan, mode) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < frames.length; i++) {
    const xv = getChannel(frames[i], xChan);
    const yv = getChannel(frames[i], yChan);
    if (isFiniteNumber(xv) && isFiniteNumber(yv)) {
      xs.push(xv);
      ys.push(yv);
    }
  }
  if (xs.length < Math.max(32, Math.floor(frames.length * 0.4))) return null;

  const x5 = percentile(xs, 0.05);
  const x95 = percentile(xs, 0.95);
  const y5 = percentile(ys, 0.05);
  const y95 = percentile(ys, 0.95);
  if (Math.abs(x95 - x5) < 1e-9 || Math.abs(y95 - y5) < 1e-9) return null;

  const points = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const tMs = frames.length <= 1 ? 0 : (i / (frames.length - 1)) * durationMs;
    const xv = getChannel(frames[i], xChan);
    const yv = getChannel(frames[i], yChan);
    let xNorm = 0.5;
    let yNorm = 0.5;

    if (isFiniteNumber(xv) && isFiniteNumber(yv)) {
      if (mode === "game") {
        xNorm = clamp01((xv + 1.5) / 3);
        yNorm = clamp01((yv + 1.5) / 3);
      } else {
        xNorm = remapByRange(xv, x5, x95);
        yNorm = remapByRange(yv, y5, y95);
      }
    }

    points[i] = {
      t: tMs,
      xNorm,
      yNorm,
      flag: frameFlags.length > i ? frameFlags[i] : null,
    };
  }

  const evalResult = evaluateCandidate(points, "channels");
  if (!evalResult.valid) return null;

  let score = evalResult.score;
  if (mode === "game") score += 0.05;

  return {
    source: `channels(${xChan},${yChan})/${mode}`,
    points,
    score,
  };
}

function selectBestPositionSource(frames, frameFlags, durationMs, forcedMode = "auto") {
  const candidates = [];
  let rawFlagCandidate = null;
  let validFlagCandidate = null;

  // Float channels are still not reliably decoded for current .rhr samples.
  // Keep the implementation in codebase for future use, but prefer flag stream.

  const flagCandidate = buildCandidateFromFlags(frames, frameFlags, durationMs);
  if (flagCandidate) {
    candidates.push(flagCandidate);
    validFlagCandidate = flagCandidate;
  }

  if (forcedMode !== "auto") {
    const exact = candidates.find((c) => c.source === forcedMode);
    if (exact) return exact;
  }

  if (forcedMode === "auto") {
    const stable = candidates.find((c) => c.source === "flags-abs");
    if (stable) return stable;
  }

  if (frameFlags.length >= frames.length) {
    const points = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const tMs = frames.length <= 1 ? 0 : (i / (frames.length - 1)) * durationMs;
      const n = decodeFlagToNorm(frameFlags[i]);
      points[i] = { t: tMs, xNorm: n.x, yNorm: n.y, flag: frameFlags[i] };
    }
    rawFlagCandidate = { source: "flags-raw", points, score: 0.05 };
  }

  if (!candidates.length) {
    if (rawFlagCandidate) return rawFlagCandidate;

    const fallback = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const tMs = frames.length <= 1 ? 0 : (i / (frames.length - 1)) * durationMs;
      fallback[i] = {
        t: tMs,
        xNorm: 0.5,
        yNorm: 0.5,
        flag: frameFlags.length > i ? frameFlags[i] : null,
      };
    }
    return { source: "fallback-center", points: fallback, score: 0 };
  }

  candidates.sort((a, b) => b.score - a.score);
  if (validFlagCandidate) return validFlagCandidate;
  return candidates[0];
}

function buildPlaybackSamples(frames, frameFlags, mapLengthSec) {
  if (!frames.length) return [];

  if (frameFlags.length < frames.length) {
    const fallback = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      fallback[i] = {
        t: i * RAW_FRAME_MS,
        xNorm: 0.5,
        yNorm: 0.5,
        flag: null,
      };
    }
    fallback.sourceName = "fallback-center";
    fallback.sourceScore = 0;
    return fallback;
  }

  const variants = [
    { mode: "abs", name: "flags-abs", holdZero: true },
    { mode: "abs", name: "flags-abs-swap", holdZero: true, swapAxes: true },
    { mode: "abs", name: "flags-abs-invY", holdZero: true, invY: true },
    { mode: "abs", name: "flags-abs-invX", holdZero: true, invX: true },
    { mode: "abs", name: "flags-abs-swap-invY", holdZero: true, swapAxes: true, invY: true },
    { mode: "delta", name: "flags-delta-48", deltaScale: 48, antiSpike: true },
    { mode: "delta", name: "flags-delta-64", deltaScale: 64, antiSpike: true },
    { mode: "delta", name: "flags-delta-80", deltaScale: 80, antiSpike: true },
    { mode: "delta", name: "flags-delta-96", deltaScale: 96, antiSpike: true },
    { mode: "delta", name: "flags-delta-128", deltaScale: 128, antiSpike: true },
    { mode: "delta", name: "flags-delta-64-swap", deltaScale: 64, swapAxes: true, antiSpike: true },
    { mode: "delta", name: "flags-delta-96-swap", deltaScale: 96, swapAxes: true, antiSpike: true },
    { mode: "delta", name: "flags-delta-64-invY", deltaScale: 64, invY: true, antiSpike: true },
    { mode: "delta", name: "flags-delta-96-invY", deltaScale: 96, invY: true, antiSpike: true },
  ];

  const candidates = [];
  for (const v of variants) {
    const s = buildSamplesFromFlags(frames, frameFlags, v);
    if (!s) continue;
    candidates.push(s);
  }

  if (!candidates.length) {
    const fallback = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      fallback[i] = {
        t: i * RAW_FRAME_MS,
        xNorm: 0.5,
        yNorm: 0.5,
        flag: frameFlags[i],
      };
    }
    fallback.sourceName = "fallback-center";
    fallback.sourceScore = 0;
    return fallback;
  }

  candidates.sort((a, b) => b.sourceScore - a.sourceScore);
  return candidates[0];
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatSec(ms) {
  return (ms / 1000).toFixed(2) + "s";
}

function findFrameIndex(samples, tMs) {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < tMs) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.min(Math.max(lo, 0), samples.length - 1);
}

function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

function sampleCursor(samples, tMs) {
  if (!samples.length) {
    return { xNorm: 0.5, yNorm: 0.5 };
  }

  const iFloat = tMs / RAW_FRAME_MS;
  const i0 = Math.max(0, Math.min(samples.length - 1, Math.floor(iFloat)));
  const i1 = Math.max(0, Math.min(samples.length - 1, i0 + 1));
  const alpha = clamp01(iFloat - i0);

  const a = samples[i0];
  const b = samples[i1];

  const xNorm = lerp(a.xNorm, b.xNorm, alpha);
  const yNorm = lerp(a.yNorm, b.yNorm, alpha);

  return {
    xNorm,
    yNorm,
  };
}

// ─── 3D Rendering System ─────────────────────────────────────────────────

// World dimensions: the hit plane is a square ±GRID_HALF in x and y, at z = 0.
// Notes (when added) will spawn at NOTE_SPAWN_Z and travel toward z = 0.
const GRID_HALF = 1.5;
const NOTE_SPAWN_Z = 22;

// Fixed perspective camera
const CAM_POS  = { x: 0, y: 1.5, z: -3.5 };
const CAM_LOOK = { x: 0, y: 0,   z: 10  };
const CAM_FOV  = 65; // degrees

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
    const right = normalize3(cross3(fwd, worldUp));
    const up = normalize3(cross3(right, fwd));
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

/** Convert normalized cursor (0–1) to world coordinates on the hit plane (z = 0). */
function cursorToWorld(xNorm, yNorm) {
  return {
    wx: (xNorm - 0.5) * GRID_HALF * 2,
    wy: (0.5 - yNorm) * GRID_HALF * 2, // canvas Y increases downward; world Y is up
    wz: 0,
  };
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

function draw3DField(canvasW, canvasH) {
  const G = GRID_HALF;
  const SPAWN = NOTE_SPAWN_Z;

  // --- Depth rails: corner edges from hit plane to spawn plane ---
  ctx.strokeStyle = "rgba(138, 210, 185, 0.4)";
  ctx.lineWidth = 1.5;
  for (const [cx, cy] of [[-G, -G], [-G, G], [G, -G], [G, G]]) {
    drawLine3D(cx, cy, 0, cx, cy, SPAWN, canvasW, canvasH);
  }

  // Mid rails (optical guides into depth)
  ctx.strokeStyle = "rgba(138, 210, 185, 0.15)";
  ctx.lineWidth = 1;
  for (const [cx, cy] of [[-G, 0], [G, 0], [0, -G], [0, G]]) {
    drawLine3D(cx, cy, 0, cx, cy, SPAWN, canvasW, canvasH);
  }

  // --- Far (spawn) plane border ---
  ctx.strokeStyle = "rgba(100, 180, 255, 0.18)";
  ctx.lineWidth = 1.5;
  drawLine3D(-G, -G, SPAWN,  G, -G, SPAWN, canvasW, canvasH);
  drawLine3D( G, -G, SPAWN,  G,  G, SPAWN, canvasW, canvasH);
  drawLine3D( G,  G, SPAWN, -G,  G, SPAWN, canvasW, canvasH);
  drawLine3D(-G,  G, SPAWN, -G, -G, SPAWN, canvasW, canvasH);

  // --- Hit plane background fill ---
  const corners3D = [
    project3D(-G, -G, 0, canvasW, canvasH),
    project3D( G, -G, 0, canvasW, canvasH),
    project3D( G,  G, 0, canvasW, canvasH),
    project3D(-G,  G, 0, canvasW, canvasH),
  ];
  if (corners3D.every(Boolean)) {
    ctx.fillStyle = "rgba(4, 8, 10, 0.86)";
    ctx.beginPath();
    ctx.moveTo(corners3D[0].px, corners3D[0].py);
    for (let i = 1; i < corners3D.length; i++) {
      ctx.lineTo(corners3D[i].px, corners3D[i].py);
    }
    ctx.closePath();
    ctx.fill();
  }

  // --- Hit plane inner grid lines ---
  ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
  ctx.lineWidth = 1;
  const DIVS = 3;
  for (let i = 1; i < DIVS; i++) {
    const t = -G + (i / DIVS) * G * 2;
    drawLine3D(t, -G, 0, t, G, 0, canvasW, canvasH);
    drawLine3D(-G, t, 0, G, t, 0, canvasW, canvasH);
  }

  // --- Hit plane outer border ---
  ctx.strokeStyle = "rgba(138, 210, 185, 0.8)";
  ctx.lineWidth = 3;
  drawLine3D(-G, -G, 0,  G, -G, 0, canvasW, canvasH);
  drawLine3D( G, -G, 0,  G,  G, 0, canvasW, canvasH);
  drawLine3D( G,  G, 0, -G,  G, 0, canvasW, canvasH);
  drawLine3D(-G,  G, 0, -G, -G, 0, canvasW, canvasH);

  // --- Corner accent marks (BeatLeader-style) ---
  const EDGE = G * 0.35;
  ctx.strokeStyle = "rgba(138, 210, 185, 1.0)";
  ctx.lineWidth = 4;
  const accentCorners = [
    { ox: -G, oy: -G, ex:  EDGE, ey:  EDGE },
    { ox:  G, oy: -G, ex: -EDGE, ey:  EDGE },
    { ox:  G, oy:  G, ex: -EDGE, ey: -EDGE },
    { ox: -G, oy:  G, ex:  EDGE, ey: -EDGE },
  ];
  for (const { ox, oy, ex, ey } of accentCorners) {
    const pc  = project3D(ox,      oy,      0, canvasW, canvasH);
    const pe1 = project3D(ox + ex, oy,      0, canvasW, canvasH);
    const pe2 = project3D(ox,      oy + ey, 0, canvasW, canvasH);
    if (pc && pe1 && pe2) {
      ctx.beginPath();
      ctx.moveTo(pe1.px, pe1.py);
      ctx.lineTo(pc.px,  pc.py);
      ctx.lineTo(pe2.px, pe2.py);
      ctx.stroke();
    }
  }

  // --- Inner square accent ---
  const IS = G * 0.55;
  ctx.strokeStyle = "rgba(22, 180, 90, 0.4)";
  ctx.lineWidth = 2;
  drawLine3D(-IS, -IS, 0,  IS, -IS, 0, canvasW, canvasH);
  drawLine3D( IS, -IS, 0,  IS,  IS, 0, canvasW, canvasH);
  drawLine3D( IS,  IS, 0, -IS,  IS, 0, canvasW, canvasH);
  drawLine3D(-IS,  IS, 0, -IS, -IS, 0, canvasW, canvasH);
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

  if (!replay || replay.samples.length === 0) {
    ctx.fillStyle = "rgba(245, 247, 255, 0.8)";
    ctx.font = "600 20px 'Space Grotesk'";
    ctx.fillText("Load a replay to begin", 24, 40);
    return;
  }

  // Draw 3D perspective field
  draw3DField(w, h);

  // Sample cursor position and project onto hit plane (z = 0)
  const sample = sampleCursor(replay.samples, state.currentMs);
  const { wx, wy, wz } = cursorToWorld(sample.xNorm, sample.yNorm);
  const proj = project3D(wx, wy, wz, w, h);
  if (!proj) return;

  const cx = proj.px;
  const cy = proj.py;

  // Cursor size: scale with canvas width for consistent look regardless of DPR
  const radius = Math.max(5, w * 0.011);

  // Glow ring
  ctx.strokeStyle = "rgba(239, 71, 111, 0.35)";
  ctx.lineWidth = radius * 1.1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.9, 0, Math.PI * 2);
  ctx.stroke();

  // Cursor dot
  ctx.fillStyle = "#ef476f";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
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

function renderMeta(replay) {
  const mods = Array.isArray(replay.mods) ? replay.mods.filter(Boolean).join(", ") : String(replay.mods);
  const playerName = replay.mode || replay.profileType || "Unknown";
  const parsed = parseSongMeta(replay.mapId, playerName);
  const mapUrl = buildRhythiaMapUrl(replay.mapPageId);

  // Song overlay
  els.songName.textContent = parsed.title;
  els.songArtist.textContent = parsed.artist;
  els.songDiff.textContent = replay.profileType ? replay.profileType.replaceAll("_", " ") : "--";
  // Stat overlays — only show what's available from the replay header
  els.accVal.textContent = "--%";
  els.missVal.textContent = "--";
  els.comboVal.textContent = "0";
  els.scoreVal.textContent = "0";

  // Speed modifier badge in mods area
  const speedMod = replay.speedMod;
  const hasSpeedMod = Number.isFinite(speedMod) && Math.abs(speedMod - 1.0) > 0.01;
  const modsStr = mods && mods !== "none" && mods !== "" ? mods : "";
  if (hasSpeedMod || modsStr) {
    els.songMods.textContent = [modsStr, hasSpeedMod ? speedMod.toFixed(2) + "x" : ""].filter(Boolean).join(" ");
    els.songMods.classList.remove("hidden");
    } else {
      els.songMods.classList.add("hidden");
    }
  // Player overlay
  els.playerName.textContent = playerName;
  els.playerType.textContent = replay.noteCount ? `${replay.noteCount} notes` : "";

  // Map link in transport
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
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function updateTimeUI() {
  const replay = state.replay;
  if (!replay || replay.samples.length === 0) {
    els.timeLabel.textContent = "0:00 / 0:00";
    els.seek.value = "0";
    return;
  }
  const end = state.durationMs;
  const safeEnd = Math.max(1, end);
  els.seek.value = String(Math.min(1, Math.max(0, state.currentMs / safeEnd)));
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
    }

  }

  updateTimeUI();
  drawReplay();
  requestAnimationFrame(tick);
}

async function loadReplayFile(file) {
  const buffer = await file.arrayBuffer();
  const replay = parseRhr(buffer);
  state.replay = replay;
  state.durationMs = replay.samples.length ? replay.samples[replay.samples.length - 1].t : 0;
  state.currentMs = 0;
  state.isPlaying = false;
  els.playPause.innerHTML = "&#9654;";
  renderMeta(replay);
  setLoadedState(true);
  els.dropZone.classList.add("hidden");
  updateTimeUI();
  drawReplay();
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

function attachControls() {
  els.playPause.addEventListener("click", () => {
    if (!state.replay) return;
    state.isPlaying = !state.isPlaying;
    els.playPause.innerHTML = state.isPlaying ? "&#9646;&#9646;" : "&#9654;";
  });

  els.speed.addEventListener("change", () => {
    state.speed = Number(els.speed.value);
  });

  els.seek.addEventListener("input", () => {
    if (!state.replay || state.replay.samples.length === 0) return;
    const end = state.durationMs;
    state.currentMs = Number(els.seek.value) * end;
    drawReplay();
    updateTimeUI();
  });
}

setLoadedState(false);
attachDnD();
attachControls();
requestAnimationFrame(tick);
