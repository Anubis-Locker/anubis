# Release and application distribution

Builds and updates use `Anubis-Locker/anubis`, our npm registry and our VPS.
The release workflow does not depend on a separate website repository and does
not deploy the main website or the public demo.

## Publishing

1. Update `package.json` and its lockfile. Commit the changes and push `vX.Y.Z`.
2. `release.yml` checks the version, runs unit regressions and builds Windows
   installer/portable/archive, Linux deb/archive/AppImage and both macOS DMGs.
3. `services/prepare-release.js` rejects incomplete, empty or duplicate artifacts,
   flattens nested artifact directories and generates `SHA256SUMS` for the exact
   attached bytes. Published release assets are never silently overwritten.
4. The signed release webhook publishes available GitHub asset URLs. The
   `publish-self-hosted` workflow independently verifies all checksums, uploads
   assets into `download.anubis.locker/releases/<tag>/`, verifies them again on
   the server and only then publishes metadata using our atomic update writer.

The updater reads `https://update.anubis.locker/version.html` and
`/data/anubis-github-release.json`. Both release JSON filenames are maintained.
Requests with `?src=<installSrc>` use the release API's platform filter.
The distribution server also maintains `/<tag>/` compatibility links for the
download mirror embedded in existing clients.

Manual `release` runs on branches build artifacts without publishing a release.
Manual `publish-self-hosted` runs accept an already published stable tag, including
an older tag for rollback. Prereleases do not change the stable update channel.
Existing clients do not automatically downgrade.

## Repository secrets

| Secret | Meaning |
|---|---|
| `DEPLOY_HOST`, `DEPLOY_PORT` | VPS hostname/IP and optional SSH port (22 by default) |
| `DEPLOY_USER` | Dedicated unprivileged distribution account, not root |
| `DEPLOY_SSH_KEY` | Separate deployment key; authorized with `restrict` |
| `DEPLOY_KNOWN_HOSTS` | Pinned, independently trusted SSH host key |
| `DEPLOY_PATH` | Absolute download docroot |
| `DEPLOY_UPDATE_PATH` | Absolute update docroot read by the release API |
| `DEPLOY_STATE_PATH` | Private writable staging directory outside docroots |
| `NPM_REGISTRY_URL`, `NPM_TOKEN` | Owned shared-client registry and publisher token |

The deploy account needs write access only to its private home/state and the two
distribution directories. It needs no sudo, root credentials, port forwarding or
write access to application services. SSH host checking is mandatory. Do not
grant world-writable permissions to docroots.

Optional signing credentials are `CSC_LINK`, `CSC_KEY_PASSWORD` and the relevant
`APPLE_*` notarization credentials. Without them, Windows/macOS artifacts are
unsigned and macOS is not notarized; operating systems may warn about them.

## Shared renderer and acceptance

`web-client-publish.yml` publishes `@ai-security-tool/electerm-react` into
`https://npm.anubis.locker/`; the web wrapper pins the same renderer version.

`src/test/packaged/extended-smoke.js` exercises a controlled real Spice guest and
a temporary private GitHub gist when `ANUBIS_SMOKE_EXTENDED=1`. It requires
`ANUBIS_SMOKE_EXE`, `ANUBIS_SMOKE_VERSION`, authenticated `gh`, and the explicit
VPS fixture credentials. It never uses the production user profile and deletes
the temporary gist and profile.

On the owned Ubuntu fixture host, install `qemu-system-x86`,
`qemu-system-gui`, `qemu-system-modules-spice` and `binutils`.
Run `sh src/test/integration/lib/spice-test-guest.sh start` as root before
acceptance and always run the same script with `stop` afterwards. The fixture
runs as `anubis-svc`, listens only on loopback port 5999, and never uses a
production VM or guest operating system image.

Unix packaged acceptance also opens a native serial port backed by a Python 3
PTY and verifies receive/transmit bytes and line endings. This is a real native
serial-driver integration check, not certification of physical serial hardware.
