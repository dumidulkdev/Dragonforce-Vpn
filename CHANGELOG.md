# Changelog

## [2.4.1] - 2026-11-01

### Highlights

- First public Windows release, built by **DragonForce**.
- One offline installer that selects x64, ARM64, or x86 automatically, plus a portable EXE for each architecture.
- VLESS and VMess connections, System Proxy and full-device TUN routing, subscriptions, and QR import/sharing.
- Interactive dashboard, Ad & Tracker Shield, smart split tunneling, usage analytics, data caps, speed tests, and light/dark themes.

### Fixes and compatibility

- Normalize legacy NetMod and 3x-ui encoded transport paths while preserving path text and intentional query escapes.
- Handle legacy `allowInsecure`, `insecure`, and `allow_insecure` flags consistently across VLESS/VMess imports and exports.
- Support servers requiring insecure TLS through per-connection certificate fingerprint pinning with current Xray versions.
- Keep saved profiles, edited configurations, and shared links consistent.
- Restore owned network settings during disconnect, shutdown, and controller replacement.

### Development and releases

- Add automatic Windows checks for pushes and pull requests.
- Build, verify, smoke-test, and publish Windows downloads when a version tag is pushed.
- Include SHA-256 checksums, native component versions, and installation notes with every release.
- Replace the old BAT launchers with direct administrator relaunch and document npm-based development.
- Add the illustrated README and contribution instructions.
