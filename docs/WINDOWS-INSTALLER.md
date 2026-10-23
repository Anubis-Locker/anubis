# Windows EXE installer

The NSIS EXE itself requests administrator approval at process creation, then
installs without a wizard. A BAT file is not required. Only the installer has a
`requireAdministrator` manifest; the installed app remains `asInvoker`.
Cancelling UAC prevents process creation, so the existing updater's
`Start-Process -PassThru` handshake and its normal exit confirmation remain intact.

## Command line

```powershell
# Wait for completion; propagate the actual installer's exit status.
$p = Start-Process .\anubis-5.6.11-win-x64-installer.exe `
  -ArgumentList '--console' -Wait -PassThru -ErrorAction Stop
exit $p.ExitCode
```

- No flags: UAC followed by a silent installation. Success does not open the app.
  Errors display a message and return nonzero.
- `--console`: same operation, with progress and final status on standard output.
  An inherited console/redirected output is reused; otherwise a console is opened.
  Error dialogs are suppressed in this mode. From an unelevated shell Windows
  may open a separate elevated console; use the waiting process's exit status.
- `/S`: supported, but redundant; setup is already silent.
- `/currentuser`, `/allusers`: electron-builder's explicit scope selectors.
  With neither flag, preserve the detected previous scope and installation
  location; fresh installs remain per-user. When both scopes exist, prefer the
  current user's installation rather than silently migrating it to all-users.
- `/D=C:\chosen\anubis`: optional destination override; must be the **last**
  argument and unquoted (NSIS syntax, including paths with spaces).
- `--delete-app-data`: rejected with exit code 87. Setup must preserve user data.

Expected statuses: 0 success, 1 generic setup failure, 2 previous uninstaller
could not start, 5 process inspection/copy/verification/registration failure,
87 destructive option, 1307 different-account elevation, 1618 running app.
Other failures from the previous uninstaller propagate its actual nonzero code.
UAC cancellation is a Windows process-creation error (1223), not an installer
success. In PowerShell catch the `Start-Process` exception as well as checking
`ExitCode`.

Setup waits at most 60 seconds for existing Anubis processes to exit normally.
It never closes/kills sessions. A process with the same executable name in
another session can conservatively block installation; close it normally and
retry. This also permits the updater to wait for the user's normal
`confirmBeforeExit` response without bypassing it. Newly generated uninstallers
also refuse to terminate running sessions.

## Install scope and identity limitation

Elevation with the **same Windows account** preserves HKCU, known folders,
bookmarks/passwords and existing install detection. Upgrades use the upstream
`--updated`/`/KEEP_APP_DATA` removal path, never app-data deletion. No services,
machine policies or application-level admin requirement are added.

When Explorer is present, setup compares its user SID with the elevated token.
Entering a **different administrator's credentials** at UAC would select that
administrator's HKCU/profile. Setup explicitly refuses that case with 1307,
before removing or changing any installation. It does not attempt an implicit
per-user-to-machine migration or copy another user's credential store.
In a shell-less administrative deployment the invoking account owns the
installation; there is no interactive Explorer identity to compare.
Supporting standard users with over-the-shoulder UAC while modifying their
per-user installation needs a separate original-user bootstrapper/token
handoff design; it is not silently approximated here.

## Build and verification

Project-owned hooks are in `src\build\windows-installer.nsh`, selected by
`nsis.include` in `src\build\electron-builder.json`; dependencies are not patched.
Keep the assisted NSIS template (`oneClick: false`) for upstream multi-user
detection; the custom header makes it silent and elevates its manifest.
The hooks target electron-builder's default embedded **7z/ASAR** installer path.
ZIP/web/prepackaged-folder custom installers need their own verification hooks.
After extraction, setup verifies the copied executable and app.asar against
the extraction staging files and checks install registration. Upstream's
unchecked last-resort extraction is not accepted as success.

Run `node --test src\test\unit-ci\windows-installer.spec.js` for contract checks.
The companion `windows-installer-native.spec.js` is opt-in on Windows: set
`ANUBIS_NSIS_COMPILER` to `makensis.exe` and `ANUBIS_NSIS_PLUGINS` to
electron-builder's NSIS resources `plugins\x86-unicode` directory. It compiles
the real hooks and tests copying, corrupt/missing files, previous-uninstaller
errors, scope selection and normal-exit waiting without installing anything or
writing registry keys. Its running-process timeout check takes 60 seconds.
Installer compilation/runtime QA must use a separate output/payload and distinct
application ID, never the live app, production registry or shared dist/work.
Validate actual UAC acceptance/cancellation and same-user install/upgrade on a
disposable Windows user/VM before publishing a new installer.
