# Anubis-Security-Tool

Terminal / SSH / SFTP / FTP / Telnet / serial / RDP / VNC / Spice client for Windows, macOS and Linux.

Homepage: https://anubis.locker (placeholder domain) · Command line: `anubis` · URL scheme: `anubis://`

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

On first start, if that folder is empty and a legacy `electerm` folder exists in the same
location, it is **copied** (never moved or deleted). The list of legacy folder names is the
`data.legacyDataDirs` setting in `src/common/brand.config.js` (set `[]` to disable).
Encrypted values (for example the storage key) are bound to the OS keychain; if they cannot be
decrypted after migration, re-enter the affected passwords.

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

## License

MIT