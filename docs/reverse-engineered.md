# Reverse-Engineered Notes

This file is only for `.rhr` findings.

## `.rhr` replay format

- Parser lives in `app.js` (`parseRhr` plus the primitive readers).
- Replay magic is expected to be `20260222`.
- Frame stride is `17` bytes.
- Each frame is read as:
  - `time` (`f32`)
  - `x` (`f32`)
  - `y` (`f32`)
  - `health` (`f32`)
  - `isHit` (`u8`)
- String fields use 8-bit length prefixes.
- Header fields still left unresolved are kept as `unknownA` through `unknownD`.

## Replay interpretation

- Frame time is treated as replay-time milliseconds.
- Cursor position is linearly interpolated between adjacent frames.
- `isHit` is used to help classify beatmap notes as hit or miss.
- Notes are matched against frame hit times with `NOTE_HIT_TOLERANCE_MS`.
- Pause markers are derived from replay gaps larger than `PAUSE_GAP_MS`.
