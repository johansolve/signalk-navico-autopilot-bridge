# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3-alpha] - 2026-06-22

### Fixed
- Plugin now loads in the Signal K plugin registry even when the `@canboat/canboatjs`
  peer dependency is absent: `canboatjs` is required lazily inside `start()` instead of
  at module top level, so the module export no longer throws on `require`.

### Added
- Smoke test suite (Node.js built-in test runner, `npm test` → `node --test`) verifying
  the plugin loads, exports a valid `{id, name, start, stop}` object, and activates with
  schema defaults without throwing.
- This changelog.

## [0.3.2-alpha] - 2026-06-22

### Changed
- Source-priority documentation made version-aware for Signal K 2.28.

## [0.3.1-alpha]

### Changed
- Trimmed npm description under 255 chars for the appstore.

## [0.3.0-alpha]

### Added
- Show the set heading on the MFD via a populated PGN 127237.

## [0.2.0-alpha]

### Fixed
- Answer ISO requests so the MFD binds to the emulated AC.

## [0.1.0-alpha]

### Added
- Initial release: Simrad AC12/AC42 emulator bridging a Navico MFD's autopilot control
  view to the Signal K Autopilot V2 API.
