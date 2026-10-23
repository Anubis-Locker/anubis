# Windows machine-service installer

The Anubis-Security-Tool NSIS EXE is a **Windows x64, per-machine** package.
Setup and uninstallers request administrator approval; `anubis.exe` stays `asInvoker`.
The native `AnubisHost` automatic LocalSystem SCM service owns the continuous
headless machine engine. The GUI runs as the actual interactive Windows user;
closing it does not stop the service. There is no interactive SYSTEM GUI,
scheduled task, tray lifetime dependency, or PowerShell-created service.

## Installation and explicit authorization

Setup is silent after UAC, never launches the GUI, and returns zero only after
native package validation, SCM Running, and a broker identity check confirm the
actual SYSTEM/session-0 host **and machine engine**. SCM Running is published by
the native host only after engine/control readiness. `--console` adds installer
progress; service action diagnostics are also recorded in NSIS details.

```powershell
# Example for a future independently versioned release, not a publication step:
$p = Start-Process .\anubis-VERSION-win-x64-installer.exe `
  -ArgumentList '--console' -Wait -PassThru -ErrorAction Stop
exit $p.ExitCode
```

The only destination is the native Program Files known folder followed by
`Anubis-Security-Tool`. `/D=` is accepted only if it exactly names that location;
`/currentuser` and legacy/noncanonical machine install locations are rejected.
Detected per-user installations are rejected unless the explicit, same-account
`/MIGRATEPERUSER` option described below is supplied. Otherwise remove a legacy
application separately, retaining its data, rather than implicitly migrating it. Another
administrator's UAC approval is usable because setup modifies no user profile.

New installations authorize **no user workers** by default. An administrator
may explicitly supply `/ALLOWUSERSIDS=S-1-5-21-111-222-333-1001` (comma-separated
canonical account SIDs for several users). This is service provisioning only;
updates reject a nonempty allow-list option rather than replacing retained
authorization. No logged-on user is automatically authorized. The native host
still requires an authorized user to be logged on, and broker operations require
administrator approval. Administrators must manage subsequent authorization
changes separately against the protected native host configuration while the
service is stopped; setup never silently edits that configuration.

User profiles, bookmarks, DPAPI credentials and managed identity state are never
copied into SYSTEM. The stable machine profile is created separately by the
native host under its protected ProgramData root. Fresh SYSTEM enrollment may
need **separate approval** from the management service; readiness does not imply
enrollment/approval. Setup never copies user data or performs enrollment or
auto-approval; explicit migration only transitions the registrations described below.
`--delete-app-data` is rejected; uninstall retains host config/data and every
legacy/user profile. Reinstallation must match the native retained config
(including the original explicitly supplied SID list); mismatches fail closed.

## Protection, updates and uninstall

`windows-machine-install.ps1` resolves Program Files via the native KnownFolder
API, checks canonical paths, owners, writers and reparse points before changing
anything, and operates only on the dedicated package tree. Existing untrusted
packages are rejected rather than repaired. Fresh extracted files are normalized
to Administrators ownership and protected DACLs: SYSTEM/Administrators full
control, Users read/execute. No broad write grant or recursive ancestor ACL
change is made. The native helper then validates the **entire** actual package.
The installer-created `anubis-machine-install.json` selects the machine client.
The 32-bit NSIS bootstrap invokes native x64 PowerShell through Windows'
`Sysnative` alias; deployment rejects a 32-bit PowerShell process. Silent fatal
dialogs have a default response so failures return nonzero without waiting for
an invisible confirmation.
Before resolving installer cmdlets, deployment restricts `PSModulePath` to that
process's trusted `$PSHOME\Modules` and explicitly imports its built-in security
manifest. Inherited PowerShell 7 or user module paths cannot select incompatible
or substituted ACL cmdlets, including when setup is launched from `pwsh`.

Updates first validate the old protected package and exact service image/account,
then use the native stop command and poll SCM Stopped (up to 60 seconds).
The native host gracefully stops its retained contexts/jobs; only its exact jobs
can be closed on timeout. No process-name killing occurs. Setup also waits up to
60 seconds for any remaining same-name GUI to close normally; it does not bypass
confirmation or kill other users' sessions. An unrelated same-name process may
conservatively block setup. The updater must close its GUI normally.

Updated uninstallers retain the stopped service/config and protected root while
upstream atomic old-file removal runs. After extraction, hashes of the runtime,
ASAR and native helper must match staging; the new package is protected and
validated before restarting the retained service. Normal uninstall stops and
unregisters only the verified service, waits for deletion, then removes package
files without deleting ProgramData/user state. Any stop, inspection, extraction,
validation, registration or readiness failure is explicit/nonzero; setup does
not promise transactional rollback or automatically restart an old engine after
a failed update. Repair/retry is required, and retained data is not deleted.

Statuses include 0 success, 1 generic failure, 2 prior uninstaller launch failure,
5 service/protection/copy/readiness failure, 87 unsupported/destructive option,
and 1618 application still running. Prior uninstaller failures propagate.
UAC cancellation is process-creation error 1223, not success; callers must also
handle `Start-Process` exceptions.

## Build and package modes

`src\build\electron-builder.json` is the template; `npm run pb` resolves branded
resources into the root config. Both select the project-owned NSIS hooks.
Normal prepare copies all `src\app` files, including machine-client HTML, UI and
preload. The Windows x64 after-pack hook compiles `native\windows-host` using
Go >=1.26 (`ANUBIS_GO` may select an explicit executable), verifies amd64 PE
format and places `anubis-host.exe` beside `anubis.exe` before package signing.
The module's Go 1.26.0 declaration is a compatibility minimum, not the release
compiler choice. Windows release workflows pin Go **1.27.3** and LF native
source/module inputs; they never rely on ignored `native\windows-host\out`.

Portable EXE, tar/loose archives and AppX packages never receive the installation
marker and **do not provide a machine service**. They retain personal standalone
behavior even when an x64 helper is included. ia32 and ARM64 SCM installers fail
explicitly at build time; standalone architecture packages remain available.
macOS/Linux are unchanged. NSIS web/ZIP/custom-prepackaged installers are not
supported by these embedded 7z/ASAR verification hooks.

Run the targeted contracts without installing anything:

```powershell
node --test src\test\unit-ci\windows-installer.spec.js src\test\unit-ci\windows-machine-packaging.spec.js
```

The optional `windows-installer-native.spec.js` uses `ANUBIS_NSIS_COMPILER` and
`ANUBIS_NSIS_PLUGINS` to compile/run a disposable hook fixture. Service actions
are deliberately replaced with a fixture macro; no production registry,
shortcuts, SCM or installed package is modified. Deployment lifecycle tests mock
SCM/native boundaries and do not substitute for real elevated installer QA.
Before publishing, validate fresh install, update, failure recovery, UAC
cancellation and uninstall in a separately authorized disposable Windows VM.
Compile experimental payloads into a distinct output directory with publishing
disabled; never overwrite accepted stable assets or publish this experimental
machine package under the already accepted 5.6.12 version.

## Isolated installer QA edition (compile only)

`src\build\bin\windows-machine-edition.js` permits only three exact versioned
compile-time definitions: production, `installer-qa-7e66c0f5` and the separate
`migration-qa-7e66c0f5`. It generates an
embedded deployment script and NSIS include, never accepts arbitrary runtime
service/path overrides, and does not mutate production defaults. Both editions
run the same real native service/security/readiness lifecycle.

The QA edition fixes service `AnubisHost-QA-installer-7e66c0f5`, native Program
Files leaf `Anubis-Security-Tool-QA-installer-7e66c0f5`, application ID
`locker.anubis.securitytool.qa.installer7e66c0f5` and NSIS GUID
`c7b2045c-6a39-4b54-9f09-b9adc9917e66`. There are no protocol or file-association
registrations, desktop/start-menu shortcuts, AppUserModelId cleanup, or GUI
auto-launch (even `--force-run`). Its installer cache is isolated at the
invoking administrator's LocalAppData
`anubis-qa-installer-7e66c0f5-updater\installer.exe`, not `anubis-updater`.
The service-name-only marker is exactly version 1 plus the actual service name.

Only the QA service's dedicated ProgramData host root can receive QA policy.
After native service installation, **before start**, the installer checks the
private native-created ancestors/config and the empty user allow-list, then
creates a protected Administrators-owned `system-profile\machine-policy.json`
containing `{"managedEnabled":false}`. Existing broader ACLs, a nonempty native
allow-list, enabled/unknown policy or nonempty `/ALLOWUSERSIDS=` fail closed.
No existing enabled policy is silently overwritten. This prevents management
enrollment and does not import any user state. Production receives no policy
override.

The distinct QA GUID scopes install/uninstall registry keys and same-version
reinstallation to the QA package. Re-running the same installer exercises the
normal old-uninstaller/atomic-copy/restart path; normal uninstall uses the exact
QA installed uninstaller and retains QA host data. Both setup and the real
uninstaller reject `--delete-app-data`. No QA installer execution is authorized
by compilation: a separate operator must inspect the exact paths/GUID/service,
approve bounded execution, close any remaining same-name GUI normally and
preserve every legacy installation, production service and other QA package.

Supply this generated QA configuration to electron-builder **by its standalone
configuration file path**, with `extends: null`, not as inline build-option
overrides. Inline configuration merges can retain production association arrays
even when the overriding array is empty. Verify the effective loaded config
and final generated NSIS registration macros before accepting a QA artifact.

## Explicit same-account per-user migration

`/MIGRATEPERUSER` is an opt-in **registration/shortcut transition**, not a data
or credential migration. Without it, existing current-user app registrations
remain a hard error. Supplying it without an exact known legacy installation is
also an error. The actual invoking SID must match the interactive WTS account;
different-account UAC and session-0 migration are rejected. `/ALLOWUSERSIDS=`
remains separately explicit and is never inferred from migration.

Production accepts only the current user's native UserProgramFiles KnownFolder
followed by `anubis`, and the paired current-user NSIS keys for GUID
`745095cd-43ab-5c64-ac68-8eb0da974d57` (appId `locker.anubis.securitytool`).
Registration values must match the known NSIS product, version, canonical
location, shortcut names and quoted `/currentuser` uninstall commands.
Unknown values/subkeys, foreign owners/registrations, expanded or malicious
commands, noncanonical paths, reparse points and hard-linked shortcuts are
rejected. User folders must be local and non-reparse; redirected/network folders
and unrecognized older installer formats require separate manual handling.

Setup **never executes or copies a legacy uninstaller/executable**. At compile
time its old-version-removal macro bypasses the entire HKCU execution branch,
even if a user races the registry after validation. The protected HKLM machine
update path remains intact. No temporary removal/hiding of legacy registrations
is used to make that safety decision. Machine updates also ignore any
registry-provided uninstall command: they copy and hash-check only the fixed
uninstaller in the already native-validated protected package into a newly
created private ProgramData host staging directory, then invoke that verified,
write/delete-locked copy directly with `/allusers /S --updated --keep-shortcuts`.
The copy has its private Administrators ownership/DACL at creation; a user
temporary-directory copy is never executed. Only this owned staging copy and
its empty staging directory are removed afterward.

Only after native package, service and SYSTEM engine readiness does migration
revalidate and update existing, fixed current-user Desktop/Programs shortcuts
whose target is the canonical legacy executable and whose arguments are empty.
It rebinds only known current-user shell command keys that exactly invoke that
legacy executable with `"%1"`; the known NSIS file-class command may omit
executable quotes only when that canonical path has no whitespace. All new
commands quote the protected executable. Unrelated handlers are left untouched. File
association UserChoice hashes, other users' hives, pinned taskbar entries and
unrecognized shell extensions are not changed. Rewritten shortcuts have no
arguments or inherited AppUserModelId; manually re-pin taskbar links if needed.
QA packages do not create new shortcuts or protocol/file associations.

Filesystem objects are opened without following reparse points, checked against
their final path/owner/link count, and held against replacement; shortcut bytes
are updated through the same held handle, without COM activation.
Shortcut parsing accepts native Windows icon-environment metadata without
resolving or inheriting it, bounds each StringData field, and rejects nonempty
arguments and unsupported target-resolution flags. Registry
components are opened with `REG_OPTION_OPEN_LINK`; untrusted registry links are
rejected. The OS's HKCU Classes alias is addressed directly as the current SID's
`_Classes` hive, never through merged HKCR. Deletion of the validated legacy
install/uninstall leaf keys uses their held handles, never a registry-provided
command or an unvalidated recursive deletion.

All legacy payload stays in place as a backup. Profiles, databases, DPAPI
material and private managed identity are not imported, copied or deleted.
SYSTEM uses its separate machine profile/identity and may require separate
out-of-band enrollment approval; migration does not enroll or approve it.
A private `ProgramData\Anubis\Host\<service>\user-migration.json` records the SID,
retained legacy directory, old installation registration metadata, changed shell
surfaces and `planned`/`complete` status. Existing reports and partial/unknown
migration state fail closed for explicit repair, not silent rollback/retry.
Service readiness precedes shell changes, so a later migration failure can leave
a ready service and a partial transition; setup still reports failure.

Normal machine uninstall removes only that invoking account's still-matching
migrated shortcut/command bindings recorded in the protected report. Bindings
changed since migration and another account's bindings are retained explicitly.
The legacy backup, original user data and protected migration report remain;
the old application is not automatically reactivated or uninstalled.

**In-place update versus re-provisioning:** while the service remains installed,
use `/S` alone. Its existing authorization list is retained; do not repeat
`/ALLOWUSERSIDS=` or `/MIGRATEPERUSER` after a completed migration.
After a full normal uninstall, the service is absent but its protected
`host.json`, profile and migration report remain. Reinstalling is new service
provisioning: explicitly repeat the **identical retained** `/ALLOWUSERSIDS=`
list when it is nonempty, without `/MIGRATEPERUSER`. The requested list must
match the retained list exactly. An omitted/empty request fails when the
retained list is nonempty; any different list also fails closed. This does not
reset authorization, migrate again or authorize additional users. Do not erase
retained configuration or private state to bypass that check.

The separate migration QA edition fixes service
`AnubisHost-QA-migration-7e66c0f5`, Program Files **and synthetic UserProgramFiles
leaf** `Anubis-Security-Tool-QA-migration-7e66c0f5`, appId
`locker.anubis.securitytool.qa.migration7e66c0f5`, and GUID
`f71e08f8-f8b5-4b34-ade6-7e66c0f5a002`. Its shortcut basename is that QA leaf;
the only synthetic current-user class is `anubis-qa-migration-7e66c0f5`.
It cannot use real UserProgramFiles `anubis` or production registry keys.
Its private pre-start SYSTEM policy disables enrollment; the frozen runtime also
disables management for user-context workers. Its user allow-list defaults empty,
but this new edition may accept an explicitly supplied `/ALLOWUSERSIDS=` during
service provisioning. Migration does not implicitly authorize the invoking SID.
In-place updates retain the original list and must omit that provisioning-only option. The
historical installer-QA edition still rejects nonempty lists. Migration QA is
separate from the previously accepted installer-QA edition/data.
`windows-user-migration.spec.js` exercises disposable real registry/filesystem
fixtures, including a real registry link, junction and hard link; it does not
execute an installer, legacy binary or service.

### Parent-session acceptance (2026-10-23)

The parent session reported successful real installer QA using
`machine-installer-qa.cjs --diagnostic`; its `machine-installer-qa.json` records
`passed: true`. The accepted artifact is the **unsigned, experimental 5.6.12**
isolated QA installer with SHA256
`56C78DF969F01B663C577383200A249A25438C3BF3084CE6E744161414986AD4`,
not a public release. Execution was performed by the parent, not by this
packaging task, and was limited to silent `/S` runs as the already elevated
interactive **Root** administrator on the QA machine.

Fresh install, same-version update through the real old `--updated` uninstaller,
and normal installed-uninstaller removal all returned zero. Authenticated real
PTY commands confirmed SYSTEM SID `S-1-5-18`, session 0, exit zero and no timeout
before and after update. The registered native `prepare-update` operation used
a real protected copy with Administrators ownership and SYSTEM/Administrators-only
ACLs. Update created a new engine/context, left no old owned process survivors,
and preserved the SQLite file identity, private MCP identity bytes and host
configuration. The disabled machine policy remained intact; no managed identity
or enrollment was created.

The parent's final independent cleanup check found no target or bootstrap
service, target processes, QA installation registry keys or QA Program Files
package. ProgramData, database and private identity were retained, and the
original real user profile was unchanged. This acceptance does **not** cover
non-elevated launch/UAC approval or cancellation, another Windows account,
reboot persistence, a production rollout, or release signing/publication.

### Parent-session migration QA acceptance (2026-10-23)

The parent separately accepted the **unsigned, experimental 5.6.12** migration
QA artifact with SHA256
`B176F72A8099B674A00DBC3D4FFAB7F7A354D43515FB617A0E3E541D1A0CF612`.
Its `machine-migration-qa.json` records `passed: true`; the
`machine-migration-qa-first-migration-and-uninstall.json` and
`machine-migration-qa-retained-empty-authorization-rejected.json` reports retain
the initial migration and negative authorization evidence.

The parent reported successful explicit synthetic per-user migration with
genuine Windows shortcuts, retained-data re-provisioning with the identical
explicit Root SID, protected same-version `/S` update, and normal uninstall.
Omitted authorization against the retained nonempty list was rejected.
Authenticated SYSTEM SID `S-1-5-18`/session-0 MCP and PTY operations succeeded
before and after update; the new engine replaced the old owned processes.
Configuration, migration report, private token bytes and database file identity
were preserved, as were legacy payload and DPAPI state. Legacy execution
sentinels never ran, and the production profile/installation baseline was
unchanged. Final checks found no QA service/bootstrap, package, installation
registry keys, processes or synthetic fixture; private QA ProgramData remained.

Execution was parent-owned, limited to silent runs as the already elevated
interactive Root administrator. This is not production or release acceptance,
does not validate a later version/build, and does not cover reboot persistence,
other Windows users or non-elevated UAC approval/cancellation. This packaging
task performed no installer execution.

### Stable 5.7.0 production migration acceptance (2026-10-23)

The parent accepted the published **unsigned** Windows x64 installer
`anubis-5.7.0-win-x64-installer.exe`, SHA256
`95D99BA325D06150D498107C8167B3EBDFC112E4C3420B16B8F2D7E983C7A026`,
125371870 bytes, from immutable tag `v5.7.0` at commit
`2aecdb8aefcee1ae57f84aa0b04670555bcb3bd4`. Release run
[39937031578](https://github.com/Anubis-Locker/anubis/actions/runs/39937031578)
passed all platform jobs and published the release and own HTTPS mirrors.
All eight package assets matched the GitHub content digests and `SHA256SUMS`;
the installed EXE was downloaded from the verified own HTTPS mirror. No
experimental QA installer was substituted.

Actual migration of the existing per-user 5.6.12 installation used `/S
/MIGRATEPERUSER /ALLOWUSERSIDS=<exact interactive Root SID>` and returned zero.
The resulting protected package is under native Program Files; `AnubisHost`
is Running, Automatic, LocalSystem. The version-1 migration report is complete,
the old HKCU install/uninstall registrations are removed, the existing desktop
shortcut targets the protected executable with no arguments, and all nine
known protocol/file-class commands use its quoted path. The legacy payload
and all six original profile files were byte-identical before the Root worker
was started; the separate protected rollback snapshot remains intact.

The installed source-built native helper is exactly
`00057E89C33F55B4B28608D100CEEC0E963D8EA736B29D4F31A29C3EB400E9CE`,
with release compiler Go 1.27.3; the packaged app is 5.7.0 and managed SDK is
1.0.2. Seventeen installed runtime/UI/preload/parser files matched the tag's
exact Windows Git checkout bytes. Five differed from the local QA working
tree's raw bytes only because that tree mixed LF and CRLF: this is not a claim
of raw-byte equality between those QA and CI files.

A fresh, independent SYSTEM identity was matched against the gateway and
approved separately; the legacy user's identity and approval were retained.
The actual desktop shortcut was launched without QA/debug/development flags.
Native Windows accessibility inspection and selection confirmed SYSTEM
SID `S-1-5-18`/session 0 and the real Root SID/session 2, followed by a switch
back to SYSTEM. Authenticated native PTY commands independently confirmed both
tokens. The real Root backend's six original collections matched a private,
read-only rollback copy using an ephemeral HMAC comparison, including three
DPAPI-encrypted bookmarks, 13 quick commands and two themes; its configuration
`password` field also matched. The comparison emitted only counts and match
booleans; decrypted contents and the ephemeral comparison key were not persisted,
and the temporary private reader copy was removed.

After normal GUI close, the same HTTPS MCP session executed a SYSTEM PTY
command after **36.902 seconds** with no GUI window present, exceeding the
15-second heartbeat interval. The device stayed approved/online, and the SCM
process and SYSTEM engine/context were unchanged. Reopening the same desktop
shortcut reconnected to SYSTEM. Evidence includes
`production-machine-570-installed-validation.json`,
`production-persistence-570-reopen-accepted.json` and
`production-root-workspace-570-accepted.json`. Earlier reports retain strict
local-working-tree byte-check and native accessibility/input-pipe harness
failures; the installation was not repeated or automatically uninstalled to
resolve those diagnostics.

This production acceptance is limited to the existing elevated Root account
and live Windows session. It does **not** establish signing, reboot/pre-logon
or logoff persistence, other-account behavior, non-elevated UAC approval or
cancellation, or successful remote SSH/VNC/RDP/SPICE connections. Stable
production update/uninstall were not rerun on this retained installation.
Separately, the isolated unsigned 5.7.0 QA artifact `A1DD3763...` passed retained
re-provisioning, protected same-version update and normal uninstall with a
deliberately incompatible inherited PowerShell module path; that is bounded
QA evidence, not a second production migration.
