# DragonForce VPN

**Built by DragonForce. Powered by Xray-core.**

DragonForce VPN is a Windows desktop VPN client that brings server management, traffic routing, network-level filtering, and connection monitoring into one clear interface. Import your own VLESS or VMess configurations from a provider or a server you manage, then connect through System Proxy or full-device TUN mode.

It is designed for everyday use with practical controls: choose which destinations use the VPN, manage subscriptions, share profiles through QR codes, and keep track of your traffic without hand-editing configuration files.

![DragonForce VPN dashboard](gallery/dashboard.png)

## Why use DragonForce VPN?

- **Your servers, your choice:** use your own connection links and subscriptions.
- **Control your traffic:** choose proxy or TUN routing, with domain and IP-based split tunneling.
- **Everything in one place:** manage connections, filtering, usage, and troubleshooting from the same app.
- **Ready for Windows:** choose an installer or a portable EXE for x64, ARM64, or x86.

## Features

- **VLESS & VMess profiles** with TCP, WebSocket, gRPC, HTTPUpgrade, and XHTTP transports, plus TLS and Reality settings.
- **Interactive dashboard** with server locations, connection status, exit IP, and live upload/download activity.
- **System Proxy & Full TUN** modes, local HTTP/SOCKS5 ports, LAN bypass, and terminal proxy controls.
- **Smart Split Tunneling** with Bypass VPN and VPN Only modes, app/website-group presets, custom domains/IP subnets, and a route inspector.
- **Privacy & Ad Shield** with ad, tracker, and malware-domain filtering, custom blocklists, allowlists, optional AdGuard DNS, and blocked-connection logs.
- **Usage analytics & speed tests** with traffic history, per-server usage, data-cap alerts, optional cap-triggered disconnect, and download/upload testing.
- **Server & subscription management** with profile editing, latency checks, feed refresh, and quota/expiry information where available.
- **QR Code Studio** for sharing profiles and importing QR codes from images, clipboard, screen capture, or a camera.
- **Legacy configuration compatibility** for encoded paths from NetMod/older panels and servers requiring the Allow insecure certificate option.
- **Desktop conveniences** including light/dark themes, live logs, locally saved preferences, and network-setting restoration when disconnecting or closing the app.

## Installation

Download the installer or a portable build from the **[latest release](https://github.com/dumidulkdev/Dragonforce-Vpn/releases/latest)**.

| Download | Choose it for |
| --- | --- |
| `DragonForce-VPN-<version>-Setup.exe` | Installation with automatic architecture selection |
| `DragonForce-VPN-<version>-x64-Portable.exe` | Intel/AMD 64-bit Windows |
| `DragonForce-VPN-<version>-arm64-Portable.exe` | ARM64 Windows, including Snapdragon PCs |
| `DragonForce-VPN-<version>-ia32-Portable.exe` | 32-bit x86 Windows |

Requires **Windows 10 or 11** with a matching architecture. Release builds include the application runtime and VPN engines.

## How to use

1. **Open DragonForce VPN** and complete or skip the welcome tour.
2. **Add a connection:** paste a `vless://` or `vmess://` link in **Servers**, add a feed in **Subs**, or use **Scan QR**.
3. **Choose a routing mode** in **Settings**:
   - **System Proxy** routes applications that use Windows proxy settings.
   - **Full TUN** captures device traffic through the virtual adapter. Use **Restart as administrator** to enable it.
4. **Select a server and connect.** Use the dashboard's **Tunnel check** to verify the connection.
5. **Customize your connection:** configure filtering in **Shield**, routing rules in **Split**, and traffic limits in **Usage**. Run **Speed** for a speed test or open **Logs** for troubleshooting.
6. **Disconnect when finished.** Closing the desktop window also disconnects and restores the network settings the app changed.

For servers requiring `allowInsecure=true`, open **Edit server → Security → Allow insecure certificate**, save, and reconnect. Encoded WebSocket paths such as `%252fws%252fchat` are normalized to `/ws/chat` automatically.

Installed and portable builds save profiles and preferences in `%APPDATA%\DragonForce VPN`.

## Screenshots

<details>
<summary>Explore the app</summary>

| | |
| --- | --- |
| **Server Manager**<br>![Server Manager](gallery/servers.png) | **Server Editor**<br>![Server Editor](gallery/server-editor.png) |
| **Privacy & Ad Shield**<br>![Privacy and Ad Shield](gallery/shield.png) | **Smart Split Tunneling**<br>![Smart Split Tunneling](gallery/split-tunneling.png) |
| **Usage Analytics**<br>![Usage analytics and data caps](gallery/usage-analytics.png) | **Speed Test**<br>![Speed test](gallery/speed-test.png) |
| **Subscriptions**<br>![Subscription Manager](gallery/subscriptions.png) | **Connection Logs**<br>![Connection logs](gallery/logs.png) |
| **QR Sharing**<br>![QR profile sharing](gallery/qr-share.png) | **QR Scanner**<br>![QR scanner and import](gallery/qr-scanner.png) |
| **Settings**<br>![Routing and connection settings](gallery/settings.png) | **Dark Theme**<br>![Dashboard in dark mode](gallery/dark-theme.png) |

</details>

## Build from source

Use a **Windows x64** development machine with **Node.js 22.18 or newer**, npm, PowerShell, and `tar.exe`. Download or clone this repository, then open PowerShell in the project folder.

### Run locally

```powershell
npm.cmd ci
npm.cmd run setup:bins
npm.cmd start
```

This installs dependencies, downloads the x64 development engines, builds the app, and launches it. Development profiles are saved in the project's `data/` folder.

### Build Windows releases

```powershell
npm.cmd run release:win
npm.cmd run release:verify
```

The build runs checks and tests, downloads verified release engines, and packages the universal installer and all three portable EXEs. The verification step checks the packaged files and generates checksums and build information in `release/`.

For packaging details and executable smoke checks, see [RELEASE.md](RELEASE.md).

### GitHub Actions

Pushes to `main` and pull requests run Windows checks, tests, and a build. Pushing a version tag such as `v2.4.1` builds all four Windows EXEs, verifies them, and publishes a GitHub Release with checksums and notes from [CHANGELOG.md](CHANGELOG.md).

See [Publishing a release](RELEASE.md#publishing-a-release) for the version and tagging commands.

### Run checks

```powershell
npm.cmd run typecheck
npm.cmd test
```

## Android App Plan

> **Status: planned, not started.** This section describes how the Android version of DragonForce VPN will be built. The final deliverable is a **working, signed Android app** published on GitHub Releases next to the Windows downloads.

### Project decisions

| Decision | Choice |
| --- | --- |
| Distribution | Signed APKs on **GitHub Releases** (no Google Play for now) |
| App ID | `com.dragonforce.vpn` (same as the Windows app; permanent after release) |
| Minimum Android version | **Android 7.0** (API 24) and newer |
| Target Android version | Latest version required by Android tooling at release time |
| CPU builds | `arm64-v8a`, `armeabi-v7a`, `x86_64` (emulator), plus one universal APK |
| Testing | A real Android phone; Android Studio/SDK set up when building starts |
| Android-only extras | Per-app split tunneling, Quick Settings tile and home-screen widget, Material You colours |
| Not in the first release | Auto-connect on boot or untrusted Wi-Fi, Google Play publishing |

### Architecture

The Android app reuses the existing VPN logic; only the platform layer is new.

```text
┌───────────────────────────────────────────────┐
│  App screens (Capacitor 8 + HTML/CSS/JS)      │  ← redesigned for phones and tablets
├───────────────────────────────────────────────┤
│  Shared core (TypeScript, packages/core)      │  ← shared by Windows, Android and Linux
│  link parsing, subscriptions, Xray config,    │
│  Shield rules, split rules, usage, data caps  │
├───────────────────────────────────────────────┤
│  Native Android layer (Kotlin)                │
│  VPN service, Xray engine, notifications,     │
│  Quick Settings tile, widget, background jobs │
├───────────────────────────────────────────────┤
│  Xray-core 26.10.31 (same as desktop)         │
│  + hev-socks5-tunnel (phone tunnel)           │
└───────────────────────────────────────────────┘
```

Planned repository layout:

```text
packages/core/     shared parser, config, rules (moved from src/main)
apps/desktop/      current Windows Electron app
apps/android/      Capacitor app + Kotlin VPN service
```

What changes from the desktop app:

- **Reused directly:** link parsing, subscriptions, server editing, Xray config generation, Ad Shield, split-tunnel rules, usage tracking and data caps.
- **Small replacements:** a few shared files use desktop-only Node.js features (random IDs, IP checks, file reading); these get phone-safe versions.
- **Moved to Kotlin:** certificate pinning for insecure-TLS servers, Xray start/stop, the tunnel, and traffic statistics.
- **Not needed on Android:** Windows System Proxy mode, terminal proxy variables, and administrator relaunch. Android's own one-time VPN permission prompt replaces them, and every connection is full-device (like TUN mode).

### Features

| Desktop feature | Android version |
| --- | --- |
| Dashboard & world map | Large Connect button, animated status ring, live speed, map card with route arc, exit IP |
| Servers | Import by paste, clipboard, **camera QR scan**, QR from a gallery image; edit, ping all, share as QR |
| Subscriptions | Add, refresh, quota/expiry info, **automatic background refresh** |
| Privacy & Ad Shield | Same blocklists and allowlists, blocked counters by category |
| Smart Split Tunneling | Domain/IP rules and presets **plus per-app selection** (for example, banking apps bypass the VPN) |
| Usage analytics & data caps | History charts, per-server usage, 80%/100% alerts, optional auto-disconnect |
| Speed test | Download, upload, ping, jitter |
| Logs | Live viewer with copy and share |
| Settings | Theme, DNS, Mux, IPv6, insecure-TLS default, per-app rules, notification preferences |
| Onboarding | Mobile welcome flow that explains the VPN and notification permissions |
| **Android extras** | Quick Settings tile, home-screen widget, support for Android's always-on VPN and kill switch |

### UI design

- **Mobile-first navigation:** bottom bar with **Home, Servers, Shield, Stats, Settings**; split tunneling, speed test, subscriptions and logs under **More**.
- **Responsive layouts:**
  - Small phones: single column.
  - Large phones: wider cards.
  - Tablets and foldables: side navigation and two-pane screens.
  - Portrait and landscape throughout.
- **Visual style:** DragonForce light and dark themes, an optional **Material You** theme on Android 12+, smooth connect animations, live speed graphs, haptic feedback and loading placeholders.
- **Usability:** large touch targets, swipe actions on servers (ping, edit, delete), pull-to-refresh, readable text sizes and screen-reader labels.
- Design mockups for every screen are approved **before** screens are built.

### Notifications

| Notification | When | Default |
| --- | --- | --- |
| **VPN status (persistent)** | While connected: server and flag, live ↑↓ speed, session time, **Disconnect** and **Switch server** buttons | Always on (required by Android) |
| Connected / disconnected | Connection state changes | On |
| Connection lost / reconnecting | Server drops unexpectedly | On |
| Connection failed | With a short reason, such as certificate error or unreachable server | On |
| Data cap warning | At 80% and 100% of the limit, including auto-disconnect | On |
| Subscription updates | Servers added/removed, refresh failed, subscription expiring | On |
| Usage summary | Daily or weekly | Off |
| Shield milestones | For example, "10,000 ads blocked" | Off |

Each type uses its own **notification channel**, so it can be switched off individually in Android settings. On Android 13+, the app explains notifications before requesting permission.

### Build phases

| Phase | Work | Finished when | Estimate |
| --- | --- | --- | --- |
| **0. Proof of concept** | Android project setup; connect one VLESS server on a real phone | Websites load through the VPN on the test phone | 1 week |
| **1. Shared core** | Move reusable logic to `packages/core`; replace desktop-only parts | Windows app unchanged; all existing tests plus new core tests pass | 1 week |
| **2. VPN engine** | Kotlin VPN service, Xray start/stop, traffic stats, certificate pinning, reconnect on Wi-Fi ↔ mobile-data changes | Reliable connect/disconnect, survives network changes and screen-off | 2–3 weeks |
| **3. Design & screens** | Mockups, design system, all main screens, responsive layouts, themes | All screens approved and working on phone and tablet sizes | 3–4 weeks |
| **4. Full features** | Servers, QR camera, subscriptions, Shield, split tunneling with per-app rules, usage and data caps, speed test, logs, settings | Every feature in the table above works | 3 weeks |
| **5. Notifications & extras** | All notifications, Quick Settings tile, widget, background subscription refresh | Each notification and shortcut tested on the phone | 1–2 weeks |
| **6. Quality & security** | Encrypted storage for server credentials, battery-saver handling, low-memory phones, automated tests | Tested on several Android versions; no crashes or traffic leaks | 2 weeks |
| **7. Release automation** | GitHub Actions builds signed APKs; Android added to the version-tag release | One tag publishes Windows and Android downloads together | 1 week |
| **8. Beta & final release** | Test group, fixes, release notes and screenshots | **Working Android app published on GitHub Releases** | 1–2 weeks |

Estimated total: **14–18 weeks**. Each phase ends with an installable build for testing.

### Final release checklist

- [ ] Signed APKs (per CPU and universal) with SHA-256 checksums on GitHub Releases
- [ ] Import, connect, browse, switch servers and disconnect work on a real phone
- [ ] Connection survives Wi-Fi ↔ mobile-data changes and screen-off
- [ ] All desktop features from the table above work
- [ ] Per-app split tunneling, Quick Settings tile, widget and Material You theme work
- [ ] Every notification type appears correctly and can be turned off
- [ ] No DNS or traffic leaks when connected; clean stop after disconnect or phone restart
- [ ] Layouts tested on small phones, large phones, tablets, portrait and landscape
- [ ] Same version and changelog entry as the Windows release (for example **v2.5.0**)

### Requirements before building

1. An **Android phone** with USB debugging enabled (emulators don't test VPN behaviour reliably).
2. **Android Studio**, the Android SDK and JDK installed on the development PC.
3. A **signing key**, created once and stored in GitHub Secrets. If it is lost, existing installs can't be updated.

### Risks

- **Battery savers** on some phone brands may stop the VPN; users will be guided to exempt the app.
- **App size:** the Xray engine adds roughly 30–40 MB per CPU build.
- **Shared core coordination:** Linux and Android work should use the same `packages/core` structure, agreed before Phase 1.

## Contributing

**Contributors are welcome!** Bug reports, feature ideas, documentation, design improvements, and code contributions are all appreciated.

Fork the repository, create a branch, make a focused change, and open a pull request describing what you improved. Run the relevant checks before submitting code changes, and include screenshots for interface changes. You can also use **Issues** to report a problem or suggest a feature.

## Credits

Created and maintained by **DragonForce**.

Built with [Electron](https://www.electronjs.org/), [Xray-core](https://github.com/XTLS/Xray-core), [tun2socks](https://github.com/xjasonlyu/tun2socks), and [Wintun](https://www.wintun.net/).
