# Windows releases

Build all supported Windows CPU architectures with:

```powershell
npm.cmd ci
npm.cmd run setup:release-bins
$env:VPN_BIN_DIR = (Resolve-Path resources/native/x64).Path
npm.cmd run release:win
npm.cmd run release:verify
```

Use Windows with Node.js 22.18 or newer, npm, PowerShell, and `tar.exe`.
The release preparation step downloads pinned official Xray, tun2socks, and
Wintun archives and verifies their SHA-256 hashes and CPU architectures.
Downloaded archives are cached in `.release-cache/`.

## Distributable files

Files are generated in `release/`:

| File | Windows architecture |
| --- | --- |
| `DragonForce-VPN-2.4.1-Setup.exe` | Automatically selects x64, ARM64, or x86 |
| `DragonForce-VPN-2.4.1-x64-Portable.exe` | Intel/AMD 64-bit |
| `DragonForce-VPN-2.4.1-arm64-Portable.exe` | ARM64, including Snapdragon |
| `DragonForce-VPN-2.4.1-ia32-Portable.exe` | 32-bit x86 |

Distribute the four EXEs together with `README.txt`, `SHA256SUMS.txt`, and
`BUILD-INFO.json`. The `win-*-unpacked` directories and builder metadata are
intermediate build outputs.

Windows 10/11 is required; 32-bit Windows uses the ia32 build. Electron does
not provide Windows ARM32 or other CPU targets. The application includes
its runtime and VPN engines, so end users do not need Node.js or npm.

## Legacy 3x-ui / NetMod links (2.4.1)

Encoded WebSocket paths are normalized on import, including double-encoded
exports such as `path=%252fws%252fchat` -> `/ws/chat`. The same normalization
applies when connecting with or sharing an existing saved profile. Escapes
inside already-decoded paths and query tokens are preserved.

For a server requiring `allowInsecure=true`, enable **Allow insecure certificate**
under **Edit server -> Security**. VLESS and VMess imports accept `true` or `1`
for `allowInsecure`, `insecure`, and `allow_insecure`. Current Xray versions use
the certificate presented at connection time as a fingerprint pin; they no
longer accept the old `allowInsecure` engine setting directly.

## Data and privileges

Installed and portable releases both use `%APPDATA%\DragonForce VPN` for
profiles, preferences, and logs. Uninstalling retains this directory.
Portable runtime files are extracted to a unique temporary directory for
each launch, which also allows administrator relaunch without overwriting
the running instance.

The normal application runs without elevation. System Proxy mode is
available immediately; TUN mode uses the app's administrator relaunch.
Closing the desktop window waits for the controller to disconnect and
restore its routes, Windows proxy, and terminal proxy variables.
The installer and uninstaller also request this normal window-close cleanup
before replacing or removing an installed application.

The release includes the complete `public/` dashboard and bundled
controller. Development state, profiles, test fixtures, and build caches
are excluded. To launch an isolated test instance, set `VPN_DATA_DIR` and
`VPN_UI_PORT`; equivalent command-line flags are `--vpn-data-dir=...` and
`--vpn-ui-port=...`.

## Verification

`npm run release:verify` checks the three unpacked architectures against
the pinned native manifests, checks dashboard/bundle freshness and private
data exclusion, then extracts the actual installer/portable payloads and
checks them against those verified files. It generates release hashes and
documentation only after every artifact passes.

Run an actual executable smoke check on a matching Windows host:

```powershell
node scripts/smoke-desktop.mjs release/DragonForce-VPN-2.4.1-x64-Portable.exe
```

The smoke check uses temporary data and isolated ports, verifies first-run
onboarding, all nine views, QR tools, included native resources, and normal
window-close cleanup. It removes its temporary data after exit.

Native config/routing regression checks can target a release engine:

```powershell
$env:VPN_BIN_DIR = (Resolve-Path resources/native/x64).Path
node --experimental-strip-types --test tests/routing.mts tests/verify.mts
```

ARM64 execution must be verified on ARM64 Windows hardware. The x64 build
machine can verify ARM64 payloads and architectures, but cannot execute
ARM64 Windows applications.

No code-signing certificate is configured for this release. The local
release command builds files; GitHub Actions handles publication on a tag push.

## Publishing a release

Two workflows run on GitHub-hosted Windows machines:

- **Windows CI** checks pushes to `main` and pull requests using the pinned x64 native engine.
- **Windows Release** builds the universal installer and three portables for tags beginning with `v`. It validates the version and changelog, runs tests, verifies every payload, smoke-tests x64 and x86, then publishes the seven release assets.

The release workflow uses GitHub's built-in `GITHUB_TOKEN`. It creates a draft while uploading and publishes only after all files are present. A failed run can be retried from **Actions**; an already published version must be followed by a new version.

To start a release manually for an existing version tag, use `gh workflow run windows-release.yml --ref v2.4.1`. Manual runs must target a tag whose version matches the source.

For the next bug-fix release:

```powershell
npm.cmd version patch --no-git-tag-version
```

This updates `package.json`, the lockfile, the dashboard, the landing page, and the executable examples in this document. Use `minor` for a feature release or `major` for breaking changes. Add an entry for the new version at the top of `CHANGELOG.md`, then:

```powershell
npm.cmd run release:notes
git add .
git commit -m "Release v2.4.2"
git tag -a v2.4.2 -m "DragonForce VPN v2.4.2"
git push origin main
git push origin v2.4.2
```

Replace `2.4.2` with your actual new version. The tag must match `package.json`. GitHub builds and hosts the downloads; developing new features only needs the source repository. Local EXEs and caches are optional and are excluded from Git.
