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

### Web distribution

The runnable Web package is published only to our registry (Node 24 or newer):

```powershell
npm install -g anubis-web@5.6.12 --legacy-peer-deps --registry=https://npm.anubis.locker/
anubis-web
```

The CLI creates strong, independent Web credentials in its private configuration
directory and defaults to managed enrollment at `https://api.anubis.locker`.
Use `ANUBIS_WEB_HOME` to choose that writable directory, `--init` to prepare it
without starting the server, or `--standalone` to opt out of enrollment.
Existing configuration is preserved. Approving the device does not replace its
Web password/JWT login. Source installers are available as
`https://download.anubis.locker/scripts/one-line-web.bat` and
`https://download.anubis.locker/scripts/one-line-web.sh`; full source and usage
instructions are in [anubis-web](https://github.com/Anubis-Locker/anubis-web).
The published Web package has also completed controlled production HTTPS
acceptance: fingerprint approval, independent Web login, terminal execution,
MCP renderer tools and revocation of active SSE/WebSocket streams. Its test-only
fixture is `test/packaged/managed-live.js` in the Web repository; production
mutations require explicit opt-in and are limited to its verified fresh identity.

### Windows machine-workspace password

The native machine client has a separate **SYSTEM password** action for the
canonical machine workspace. In the normal, non-elevated client, approve the
explicit Windows UAC prompt first. The same client restarts without credentials;
click **SYSTEM password** again after restart and select the SYSTEM workspace.
Cancelling UAC reclaims the existing client singleton. Pending connection
requests must be cleared before this password-specific restart.

An existing application password must come from the workspace owner and must
be supplied to rotate it. Initial setup requires a genuinely uninitialized,
readable profile. Windows/RDP credentials, administrator dashboard tokens and
gateway grants do not replace that password. Unreadable encrypted data stops
authentication and provisioning instead of being treated as a fresh or
passwordless profile. Existing user-profile Settings still target that same
user profile.

This action requires a matching protected Windows broker/helper with the
native password-admission protocol. Credentials travel only over private pipes
after local OS-authorized admission; there is no Web RPC or remote reset API,
password retrieval, password command-line argument or central plaintext store.
Rotation preserves encryption keys and existing data, commits transactionally,
and revokes active browser sessions before reporting success. Pending login
and bootstrap results from before that revocation cannot issue new tokens or
reuse an invalidated session. An explicitly committed failure or unknown outcome
must not be automatically retried.

This source integration has offline protocol/storage/UI-logic coverage only.
It does not establish installed UAC, SCM/SYSTEM admission or live provisioning
acceptance, and an older installed runtime/helper remains unsupported.

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
Encrypted values (for example the storage key) are bound to the OS keychain.
Unreadable encrypted profiles stop authentication and password setup; restore
the correct OS account/keychain access rather than treating the profile as new
or resetting its storage keys.

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
| Management API / gateway | reports, approved device enrollment, live presence and authenticated remote browser/MCP access | `api.anubis.locker` |
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
A subsequent isolated check completed the same 5.6.10-to-5.6.11 upgrade through
the public release feed, verifying the downloaded installer hash, successful NSIS
exit and preservation of the encrypted password.
The 5.6.11-to-5.6.12 public-feed upgrade also completed with the exact accepted
installer hash, NSIS exit code zero, normal old-client shutdown and a readable
preserved encrypted bookmark.
Windows release workflows run the packaged smoke test before uploading artifacts
and use the checked-in dependency lock rather than replacing native-module
versions during the build.

Both macOS workflows run `src/test/packaged/unix-smoke.js` against the packaged
application before uploading the DMG. It checks native terminal execution, local
files, settings, OS-backed encryption and bookmark/password persistence after
restart. For a configured Unix desktop, set `ANUBIS_SMOKE_EXE` to the packaged
executable and run `node --test src/test/packaged/unix-smoke.js`.

## Build status

The published stable desktop release is
[5.6.12](https://github.com/Anubis-Locker/anubis/releases/tag/v5.6.12).
All eight exact accepted CI binaries and their SHA256 manifest are mirrored to
our download host; both stable update feeds advertise the same release.

**Windows lifecycle limitation in 5.6.12:** the backend and managed agent belong
to the desktop process. Closing the application stops them and takes the device
offline. This release does not install a Windows service or provide SYSTEM/user
execution-context switching. Installer elevation does not change the account
running the application or its terminals. The acceptance results below do not
establish unattended, GUI-independent operation; the machine-host replacement
is not yet released.

The experimental replacement has passed isolated real SCM/SYSTEM terminal and
GUI acceptance, same-window reconnection after a service restart, and an actual
logged-on Root WTS context with a separate password-protected QA profile.
Encrypted bookmarks survive a service restart without changing the working user
profile. This does not establish pre-logon/reboot behavior, another Windows
account, or acceptance of the production installer and device-identity migration.
See `docs/ADMIN-VS-USER.md` and `docs/WINDOWS-INSTALLER.md` for the current boundaries.

| Platform | Status |
|---|---|
| Linux (deb/AppImage/tar.gz) | 5.6.12 published. Exact CI tar.gz passed terminal execution, settings, native serial PTY input/output, bookmark persistence and OS-keyring encryption in an isolated Ubuntu desktop session; deb/AppImage installation was not exercised |
| Windows (NSIS) | 5.6.12 published and installed through the public updater with preserved encrypted data. Exact CI application passed actual production HTTPS approval, browser/native-store sharing, terminal, VNC pixels/input, independent password login, native MCP and active WebSocket/SSE revocation |
| macOS (dmg) | x64 and arm64 packaged applications passed native terminal execution, local files, settings, OS-keychain encryption and bookmark/password persistence after restart (5 checks per architecture). DMGs remain unsigned and not notarized; Gatekeeper installation acceptance is not established |

The hosted AI placeholder source is `services\ai-stub.js`; run it with
`node services\ai-stub.js` (`PORT` defaults to 7105, bound to loopback).
Reverse-proxy `/api/ai` on `ai.anubis.locker` to this service. Both ordinary
JSON and OpenAI/Anthropic SSE requests return the same explicit placeholder,
not generated commands or bookmarks; a real model is still required for those.

The management API source is `services\management-api.js`. Install its small
server-only dependency set with
`npm ci --prefix services --omit=dev --ignore-scripts`, then run
`node services\management-api.js`. It binds loopback on `PORT` (default 7106),
persists reports in `DATA_DIR` (default `/var/lib/anubis-mgmt`) and accepts desktop
reports at `POST /api/report`. Configure `ADMIN_TOKEN` only on the server:
`GET /api/installs` and `GET /api/reports` require its Bearer token and remain
inaccessible when the token is missing. `/api/installs` returns the latest report
per installation, not remote-access passwords. Storage failures return an error
instead of acknowledging a report that was not saved.

The administrator inventory is available at
`https://api.anubis.locker/admin` (or `/admin` on your management API host).
Deploy `services\management-dashboard.html`, `services\package.json` and its lock
alongside `management-api.js` (renamed `server.js` on the hosted service).
Sign in using the server's management administrator token, not a desktop MCP
token. The dashboard keeps this token only in tab memory and refreshes every
10 seconds. It lists the last report for each installation and opens its
filtered error/report history; `GET /api/reports?installId=<id>&limit=50`
requires the same administrator authentication.

The **Managed devices** section is separate from historical reports. New managed
installations create a private per-instance UUID and random credential; the
controller stores its SHA-256 fingerprint, never the credential. The first
enrollment is pending. Compare the full fingerprint with the local application,
check **Fingerprint verified locally**, and approve it. Unknown or revoked
instances cannot open a tunnel. Approved instances reconnect automatically;
**Online** requires both a real authenticated reverse connection and a successful
local Web readiness probe, not merely a recent report.

**Open device** creates a one-use, 30-second ticket. The browser exchanges it over
HTTPS POST for a host-only HttpOnly/Secure session cookie on the isolated
`device-<UUID-without-hyphens>.anubis.locker` origin. Neither administrator
credentials nor tickets appear in URLs. HTTP bodies and WebSocket sessions use
authenticated outbound channels, without opening inbound ports on the PC.
**Revoke** closes active channels and invalidates existing browser sessions.
Standalone Web user authentication remains an additional boundary. Enrollment and
reports do not contain SSH/RDP/VNC passwords or local service tokens. Authorized
application traffic travels through a trusted TLS-terminating gateway; this is
not end-to-end encryption against the gateway operator. This gateway does not dispatch arbitrary
install/update/restart tasks; application updates use the existing release updater.

Desktop 5.6.12 enables managed enrollment by default. Its private identity is
`app.getPath('userData')\managed-access-identity.json`; the native About panel
shows status and the complete fingerprint. Administrator environment overrides
are `ANUBIS_ADMIN_MANAGED_ENABLED=0` and `ANUBIS_ADMIN_MANAGED_URL`.
An existing desktop password remains an additional browser login requirement.
Changing that password invalidates browser sessions without revoking the device.

**MCP access** issues a separate temporary token and HTTPS `/mcp` URL for one
approved online device. Configure external MCP clients with
`Authorization: Bearer <temporary token>`. The grant lasts at most one hour and
permits only GET/POST/DELETE on that exact endpoint, not the browser UI, controller
API or WebSockets. The local authenticated MCP widget must actually be running.
The adapter inserts its local token on the device; controller enrollment and
issued MCP grants do not contain that token. Ordinary authorized Web widget
configuration follows its existing permissions and trusted-proxy model.
For Web renderer tools, start the widget from the authenticated browser session
that will serve those tools and keep that session connected.
Expiration closes active HTTP/SSE streams; device revocation cancels all grants.
Desktop MCP is a separate administrative capability acting on the native store,
not a means of unlocking browser data or bypassing OS-backed encryption.

The server requires a wildcard DNS A record for `*.anubis.locker` and a matching
TLS certificate. Include `services\nginx-managed-gateway.conf` in the Nginx HTTP
configuration and `services\nginx-managed-agent-location.conf` in the API virtual
host. The supplied files use the hosted VPS address/certificate paths; adjust
these for another deployment. They match only the reserved `device-` host prefix
and managed API paths, not the main website or existing demo. Keep WebSocket
upgrade forwarding and long data-channel timeouts: a short generic proxy timeout
would disconnect idle remote terminals. The client enforces HTTPS except for
explicit loopback test origins.

The shared transport is
[`@ai-security-tool/managed-access`](https://github.com/Anubis-Locker/anubis-managed-access),
published only to our registry. Its authenticated API is `GET /api/agents` and
administrator `POST /api/agents/<id>/approve`, `/connect`, `/mcp-token`, `/revoke`; first
enrollment uses `POST /api/agents/enroll`, then the per-instance credential
authenticates control/data WebSockets. First enrollment alone is not proof of
machine ownership: local fingerprint verification remains mandatory.

The login uses the existing `ADMIN_TOKEN` in the `anubis-mgmt-api` server
service configuration; a token for another management host is not reused.
The historical **Installations** section remains compatible with 5.6.11.
Its `installId` identifies an application profile, not necessarily a unique PC.
Those older reports have no device authentication and startup-only heartbeats,
so they are not treated as live managed presence. Optional reported Web addresses
are explicitly unverified; they cannot authorize a managed tunnel.
Run the focused API/browser checks with
`node --test src/test/unit-ci/management-api.spec.js src/test/integration/management-dashboard.spec.js`.
The browser check uses the declared Playwright dependency and its Chromium
browser installation.

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
Use `services\nginx-update-filter.conf` for the release JSON location: `?src=`
lookups are served by the same receiver, without depending on the website's
separate Node process. Exact asset names, platform suffixes and installer stems
are supported; blockmaps are excluded unless explicitly requested.

Linux desktop sessions need a working D-Bus session and an unlocked Secret
Service/keyring for OS-backed password encryption. The Ubuntu runtime check used
a private D-Bus session and an unlocked gnome-keyring, not a plaintext password
store. A bare VPS virtual display does not provide these services; disabling
encryption is not an acceptance workaround.

## License

MIT