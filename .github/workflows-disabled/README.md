# workflows-disabled

Legacy / architecture-specific / third-party-service workflows inherited from upstream electerm.
GitHub only runs `.github/workflows/*.yml`, so everything here is **inactive**.
They are NOT maintained for the fork: they still use upstream conventions (GitHub-release publishing,
`environment: build`, branch triggers, Cloudflare R2 upload, upstream mirrors/containers) and need rework before use.

| File(s) | What it did | Why disabled |
|---|---|---|
| `linux-arm.yml`, `linux-arm-legacy.yml`, `win-arm.yml`, `win-nsis-arm.yml` | arm64 builds | not in MVP; needs arm runners |
| `linux-loong64*.yml`, `linux-riscv64.yml`, `ppc64le.yml` | exotic arch cross-builds | not in MVP; use third-party electron forks |
| `linux-legacy.yml`, `win7-tar.yml`, `mac-10.yml`, `mac-test-*.yml` | old OS builds (electron 22) | needs custom legacy builder image (upstream's Docker Hub image) |
| `linux-rpm-snap.yml`, `snap-store-upload.yml` | rpm + snap | snap needs Snap Store account |
| `win-appx.yml`, `win-loose.yml`, `ms-store-upload.yml`, `winget.yml` | MS Store / winget | needs own Store identity (`appx.publisher`) / winget package |
| `sync-gitee.yml`, `sync-atomgit-release.yml` | mirrors to gitee/atomgit | upstream services |
| `upload-release-assets-r2.yml` | Cloudflare R2 upload | replaced by `publish-self-hosted` |
| `build-homepage-trigger.yml` | triggers upstream homepage rebuild | replaced by `publish-self-hosted` |
| `trigger-npm-publish.yml`, `electerm-react-publish.yml` | npm publish (npmjs OIDC) | replaced by `web-client-publish.yml` |

## How to re-enable one

1. `git mv .github/workflows-disabled/<name>.yml .github/workflows/`
2. Rebrand it: no `electerm` strings, repo org `ai-security-tool`, appId `locker.anubis.securitytool`.
3. Convert it to the MVP pattern (see `../workflows/win-nsis.yml`):
   - triggers: `workflow_call` + `workflow_dispatch` instead of `push` to branches;
   - remove `environment: build`, `GH_TOKEN` and `CF_R2_*` (electron-builder `publish` is `generic`, it uploads nothing);
   - set `WORKFLOW_NAME` and export `ANUBIS_UPDATE_URL` (see any MVP workflow) - `electron-builder.json` requires both;
   - upload the artifacts with `actions/upload-artifact@v4`;
   - add the job to `release.yml` (`uses: ./.github/workflows/<name>.yml`, `secrets: inherit`, and in the `release` job `needs`).
4. Artifact name suffix must keep matching the `installSrc` written by the build script
   (e.g. `linux-arm64.deb`) - clients find updates by `asset.name.includes(installSrc)`.
5. Signing steps must stay conditional on secrets (see `mac.yml`).
