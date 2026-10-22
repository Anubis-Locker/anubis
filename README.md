# Anubis-Security-Tool

Terminal / SSH / SFTP / FTP / Telnet / serial / RDP / VNC / Spice client for Windows, macOS and Linux.

Homepage: https://anubis.locker · Command line: `anubis` · URL scheme: `anubis://`

> Anubis-Security-Tool is a fork of [electerm](https://github.com/electerm/electerm) (MIT). See `LICENSE` for the original copyright notice.

## Features

- Terminal / file manager and SSH, SFTP, FTP, Telnet, serial port, RDP, VNC and Spice client
- Multiple auth methods: public key, password, ssh agent, certificates, OTP
- Zmodem (rz, sz) and Trzsz (trz/tsz), tunnels and connection hopping
- Customizable UI: themes (default `anubis-dark`), background image, transparent window
- Global / session proxy, quick commands, triggers, quick input to one or all terminals
- Optional data sync (gist, WebDAV or custom server) and AI assistant integration
- MCP widget for AI assistants and external tools
- Deep links: `ssh://`, `telnet://`, `rdp://`, `vnc://`, `serial://`, `spice://` and `anubis://`
- Command line: run `anubis --help`

## Install

Pre-built installers are published to `download.anubis.locker` / `update.anubis.locker`
on every release.

Windows (self-elevates via UAC, installs silently, then launches the app):

```powershell
Invoke-WebRequest -Uri "https://download.anubis.locker/scripts/anubis-security-tool.bat" -OutFile "anubis-security-tool.bat"
cmd.exe /c ".\anubis-security-tool.bat"
# add --console to keep the window open and see live progress
```

Linux / macOS (picks deb/rpm/AppImage or dmg automatically, asks for sudo only if needed):

```bash
curl -fsSL https://download.anubis.locker/scripts/anubis-security-tool.sh | bash
# or: wget -qO- https://download.anubis.locker/scripts/anubis-security-tool.sh | bash
# add --console for verbose output
```

Both scripts read the current release from `update.anubis.locker/data/anubis-release.json`,
download the matching asset, install it, and report install/error events to
`api.anubis.locker/api/report` (see `ANUBIS_UPDATE_URL` / `ANUBIS_API_URL` env vars to override).
Or just grab a binary directly from the [releases page](https://download.anubis.locker).

## Data folder and migration

User data lives in the `anubis` folder under the OS app data directory
(Windows `%APPDATA%\anubis`, macOS `~/Library/Application Support/anubis`, Linux `~/.config/anubis`).
Override with `DATA_PATH=/custom/path`.

On first start, if that folder has no application data and a legacy `electerm` folder exists in the same
location, it is **copied** (never moved or deleted). The list of legacy folder names is the
`data.legacyDataDirs` setting in `src/common/brand.config.js` (set `[]` to disable).
Chromium startup locks, caches and crash logs do not suppress migration. Existing
application data and unrelated files prevent it; a copy failure stops startup
instead of opening a new, empty database.
Encrypted values (for example the storage key) are bound to the OS keychain; if they cannot be
decrypted after migration, re-enter the affected passwords.

## Admin vs. user settings

This fork adds a two-tier settings model on top of upstream electerm:

- **Admin policy** (`src/app/common/admin-policy.js` + client mirror) forces a fixed set of
  values on every start/config read/save: sync server URL, AI endpoint, auto-update, MCP
  server + token, error reporting endpoint, and (optionally) a global proxy. These are set at
  build time via `brand.config.js` or `ANUBIS_ADMIN_*` env vars and are **hidden/read-only**
  in the UI — a regular user cannot see or change them.
- **User settings** are everything else (theme, shortcuts, terminal options, per-connection
  proxy, etc.) — fully editable as in upstream electerm.

See `docs/DEFAULTS.md` for the full list of features enabled out of the box (auto sync,
autorun on login, deep links, MCP widget, batch operations, AI bookmark, secret gist, ...)
and `docs/ADMIN-VS-USER.md` for the policy implementation details.

## Built-in services (self-hosted, no official electerm infra)

All of the following run on our own domains, replacing the corresponding electerm.org /
GitHub services:

| Service | Purpose | Endpoint |
|---|---|---|
| Update/release site | version check, release JSON, install scripts | `update.` / `download.anubis.locker` |
| Sync server | settings/connections sync (replaces gist/webdav defaults) | `sync.anubis.locker` |
| AI stub | OpenAI/Anthropic-compatible chat endpoint (placeholder reply today, pluggable later) | `ai.anubis.locker` |
| Management API | receives install/error reports, lists installed instances | `api.anubis.locker` |
| Docs / theme mirror | wiki pages and iTerm-style theme catalogue | `docs.` / `theme.anubis.locker` |
| Demo | browser-based demo (electerm-web) with VNC/MCP | `demo.anubis.locker` |

## Branding and resources

Brand settings (name, id, domain, protocol, sponsor link, ...) are in `src/common/brand.config.js`.
The `sponsor.link` setting is empty by default, which hides the sponsor row in the info modal.

Logos and icons come from the resource package. It is looked up, in order, at:

1. `BRAND_RES_DIR` (relative to this repo, or absolute)
2. `../resource`
3. `node_modules/@ai-security-tool/resource`

The same path is used by the vite `@brand-res` alias, electron-builder
(`npm run pb` fills it into `electron-builder.json`) and the Linux build scripts.

## Dev

```bash
# needs nodejs 24.x
npm config set legacy-peer-deps true
npm i

# start vite dev server, requires port 5570
npm start

# in a separate terminal session run app
npm run app

# code format check / fix
npm run lint
npm run fix
```

## Test

```bash
npm run b
npm run prepare-test
cp ./src/build/.sample.env ./.env
# edit .env, fill your test host/username/password
npm run test

# unit tests that need no test host
node --test src/test/unit-ci
```

## Test build

```bash
npm i
npm run b
npm run pb   # copies electron-builder.json and resolves the @brand-res path
./node_modules/.bin/electron-builder --linux tar.gz
# check dist/ folder
```

Windows packaging runs `src/build/bin/after-pack.js` to place the architecture-matched
ConPTY DLL and console host next to the rebuilt `node-pty` module. Missing runtime
binaries fail the build. A successful build alone does not verify application
functionality: test the packaged executable, including terminal input/output.

After installing development dependencies, run the Windows packaged smoke test
from the repository root:

```powershell
npm run test-packaged-windows
# Optional: exercise the configured hosted AI service too
$env:ANUBIS_SMOKE_AI = "1"
# Optional: use a dedicated, short-lived test account for hosted sync
$env:ANUBIS_SMOKE_SYNC_TOKEN = "<test-account JWT>"
# To check an installed executable instead of dist\win-unpacked:
$env:ANUBIS_SMOKE_EXE = "C:\path\to\anubis.exe"
```

The smoke test uses temporary data and checks terminal input/output, local files,
encrypted bookmark persistence, loopback SSH/SFTP, authenticated MCP initialization,
VNC framebuffer and keyboard/pointer delivery, and legacy-data migration on a real
first portable startup. The hosted-sync check verifies encrypted upload/download
and automatic upload after a bookmark changes.
It temporarily trusts its loopback SSH fixture and removes only that fixture's
entry from `known_hosts` during cleanup. Autostart and error/installation reporting
are disabled in the test profile to avoid system changes or test-install records.
Hosted tests require explicit credentials; they never use an existing user's sync
account. `ANUBIS_SMOKE_RDP` and `ANUBIS_SMOKE_TUNNELS` enable the controlled VPS
acceptance fixture, which verifies real RDP pixels/input and an authenticated
reverse SSH tunnel; its RDP/VNC listeners bind loopback only. These checks are
not run by public CI and do not enable public access to the workstation.
Update unit tests exercise real HTTP streams and mock only installer
launch, so they do not establish successful installation between versions.
A separate isolated Windows check downloaded an actual NSIS package through the
desktop update UI and completed a visible, interactive installation from QA
version 5.6.10 to 5.6.11. The installed executable reported the new version, and
the existing bookmark and encrypted password remained readable. Production
updater code launched NSIS and requested normal application shutdown, preserving
the user's exit-confirmation setting. The check required no manual application
closure, process kills or Retry clicks; the harness operated only the normal
Next/Install/Finish installer controls. This used a loopback feed and a separately
named QA installation, not the public release feed or unattended installation.
Windows release workflows run the packaged smoke test before uploading artifacts
and use the checked-in dependency lock rather than replacing native-module
versions during the build.

Both macOS workflows run `src/test/packaged/unix-smoke.js` against the packaged
application before uploading the DMG. It checks native terminal execution, local
files, settings, OS-backed encryption and bookmark/password persistence after
restart. For a configured Unix desktop, set `ANUBIS_SMOKE_EXE` to the packaged
executable and run `node --test src/test/packaged/unix-smoke.js`.

## Build status

| Platform | Status |
|---|---|
| Linux (deb/AppImage/tar.gz) | CI artifacts built. Packaged tar.gz passed terminal execution, settings, bookmark persistence and OS-keyring encryption in an isolated Ubuntu desktop session; deb/AppImage installation and publication pending |
| Windows (NSIS) | Runtime repairs installed and checked: terminal, files, SSH/SFTP, MCP, AI, VNC/RDP display and input, encrypted hosted sync, reverse SSH tunnel and first-run migration. Isolated interactive NSIS replacement from QA 5.6.10 to 5.6.11 preserved bookmarks and passwords; public-feed rollout pending |
| macOS (dmg) | x64 and arm64 packaged applications passed native terminal execution, local files, settings, OS-keychain encryption and bookmark/password persistence after restart (5 checks per architecture). DMGs remain unsigned and not notarized; Gatekeeper installation acceptance is not established |

The hosted AI placeholder source is `services\ai-stub.js`; run it with
`node services\ai-stub.js` (`PORT` defaults to 7105, bound to loopback).
Reverse-proxy `/api/ai` on `ai.anubis.locker` to this service. Both ordinary
JSON and OpenAI/Anthropic SSE requests return the same explicit placeholder,
not generated commands or bookmarks; a real model is still required for those.

The management API source is `services\management-api.js`; run it with
`node services\management-api.js`. It binds loopback on `PORT` (default 7106),
persists reports in `DATA_DIR` (default `/var/lib/anubis-mgmt`) and accepts desktop
reports at `POST /api/report`. Configure `ADMIN_TOKEN` only on the server:
`GET /api/installs` and `GET /api/reports` require its Bearer token and remain
inaccessible when the token is missing. `/api/installs` returns the latest report
per installation, not remote-access passwords. Storage failures return an error
instead of acknowledging a report that was not saved.

The versioned release receiver is `services\release-api.js`, with no Go or npm
runtime dependencies. Configure `ANUBIS_WEBHOOK_SECRET`, `ANUBIS_RELEASE_PATH`
(`/github-anubis-api/<existing-path>`), `ANUBIS_RELEASE_JSON` and
`ANUBIS_UPDATE_DIR`; `PORT` defaults to loopback 7102. It accepts the existing
GitHub HMAC-signed `release/published` webhook format and uses
`services\publish-update.js` to update both JSON feed names before advertising
the new `version.html`. Drafts and prereleases are ignored. Failed publication
is logged and returns HTTP 500, not a successful acknowledgement. The legacy
Go receiver can remain a reference module; the deployed Node receiver keeps
backend recovery reproducible from this repository.
Include `services\nginx-release-location.conf` inside the update subdomain's
HTTPS server block, and configure the repository's Releases webhook to use the
same path and HMAC secret. The proxy preserves the request body and signature;
the normal static update/download routes are unchanged.

Linux desktop sessions need a working D-Bus session and an unlocked Secret
Service/keyring for OS-backed password encryption. The Ubuntu runtime check used
a private D-Bus session and an unlocked gnome-keyring, not a plaintext password
store. A bare VPS virtual display does not provide these services; disabling
encryption is not an acceptance workaround.

## License

MIT