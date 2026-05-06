# Changelog

This is just the short list of notable viewer changes.

## [Unreleased]

### Added
- Basic project docs for easier handoff and cleanup work.
- `DEV_README` for the dev workflow.
- `docs/reverse-engineered.md` for reverse-engineered notes.

### Changed
- Parser and playback constants were named to reduce magic numbers.
- `.rhr` parsing now performs stronger malformed-file boundary checks.
- Beatmap API endpoint moved to a named constant.

### Removed
- `window.__rvState` debug exposure removed to reduce global surface area.

## [2026-05-06]

### Changed
- Broad optimization cleanup in `df17439`.
- Removed the old skin-loading pipeline.
- Removed stale skin-related styles.
- Kept the viewer focused on active features.
