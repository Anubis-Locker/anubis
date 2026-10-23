# Anubis Windows SCM foundation

This is a native Windows host, not an Electron GUI, scheduled task, tray app, or
production enrollment tool. It requires the parent application to supply a real
headless `anubis.exe` implementing the contract below. An existing unmodified GUI
executable is **not** a service engine.

The native host installs as an automatic LocalSystem SCM service, independently
of interactive logon and GUI lifetime. There is one canonical SYSTEM machine
engine. `launch-context` with `target: "system"` returns that existing engine;
it never starts another SYSTEM profile/agent. User workers run under explicitly
authorized **already logged-on** users and are separate headless workspaces.
They must not register another central machine agent.

## Build and read-only inspection

Windows amd64, Go 1.26 or newer:

Put an existing Node runtime on PATH to include the real Node/libuv pipe
integration test; that one test explicitly skips if Node is unavailable.

```powershell
go test -count=1 ./...
go vet ./...
go build -trimpath -o out\anubis-host.exe .
.\out\anubis-host.exe identity
```

`identity` reports the real process token's SID, resolved account, elevation,
session ID, and PID. It does not infer identity from `CWD`, environment variables,
`USERPROFILE`, or a `systemprofile` directory. For a worker or terminal, invoke
this primitive **inside that context**; inspecting the GUI's identity does not
establish the terminal's user.

Only the top-level `anubis-host.exe identity` CLI also includes
`"systemDirectory":"C:\\Windows\\System32"` (the actual path may differ).
This is the authoritative Win32 `GetSystemDirectory` result; an AMD64 helper
returns native System32 without consulting `SystemRoot`, `WINDIR`, the registry,
or PATH. API failure fails the command, with no fallback. Parent may use it to
construct a fully qualified system PowerShell path and must fail closed if
absent. Broker identity and context descriptors retain their existing schemas
without this CLI-only field.

The packaged runtime can also invoke this read-only command without elevation:

```powershell
.\anubis-host.exe validate-install --install-dir "C:\Program Files\Anubis" --runtime-relative-path anubis.exe
```

Success is one JSON line
`{"valid":true,"installDir":"...","runtimeRelativePath":"anubis.exe"}`.
Failure exits nonzero with an explicit stderr error. This checks the actual
helper location and entire package against the native Program Files known
folder, ACLs, owners, and reparse points; it does not read secret machine config
or trust an environment-supplied Program Files path. Parent must derive these
arguments from its actual packaged executable, not untrusted GUI/client input.

## Protected installation and configuration

The installer must first stage the complete, trusted package in a dedicated
directory **below the native Program Files known folder**. The host filename is
fixed: `anubis-host.exe`. `runtimeRelativePath` defaults to `anubis.exe`; an
administrator may configure an exact canonical relative `.exe` path in this
package, never an external executable, arbitrary command, or client-supplied
argument list.

The entire package tree is checked: no reparse points, untrusted owners, or
untrusted write ACEs. Accepted owners/writers are SYSTEM, Administrators, and
TrustedInstaller. User-writable AppData, Desktop, temp, UNC, and external runtime
locations are rejected, even when the caller is elevated. Unusual ACL entry
types are rejected rather than guessed safe. This is an ACL trust boundary,
not a code-signature/supply-chain attestation; the installer must authenticate
its package.

The data root is derived from the Windows ProgramData known folder, not an
environment variable:

```text
<ProgramData>\Anubis\Host\<serviceName>\
  host.json
  host.log
  system-profile\                 persistent machine state, never per-launch
  runs\<actual SID>\<contextId>\
    ready.json                    host-precreated, worker writes in place
    error.json                    host-precreated, worker writes in place
    stop.request                  host creates to request graceful shutdown
    data\                         user-context scratch/metadata only
```

Machine ancestors, configuration, and SYSTEM profile must be private to
SYSTEM/Administrators (TrustedInstaller is also trusted). Existing broad read
ACLs are rejected, not silently inherited or weakened. New directories use
protected ACLs and Administrators ownership. A selected user receives read and
traverse on its unique run directory, write access to **only** the precreated
ready/error files, and full access to its own `data` leaf. It cannot replace
the run directory or redirect SYSTEM stop writes. Control-file reads open the
reparse point itself and reject links/directories/oversized files.

Example administrator-created config (the CLI normally writes it):

```json
{
  "version": 1,
  "serviceName": "AnubisHost",
  "installDir": "C:\\Program Files\\Anubis",
  "runtimeRelativePath": "anubis.exe",
  "allowedUserSids": ["S-1-5-21-111-222-333-1001"]
}
```

Only explicit canonical account SIDs are accepted. An empty allow-list permits
no user contexts. No user DPAPI state is read, imported, decrypted, or copied
into the machine identity/profile. A user engine derives its real user profile,
home, and AppData under its own token. Its generated `--anubis-data-dir` is
scratch/metadata, **not** an override for the real user profile.

## Administrative CLI

### Protected downloaded-installer staging

An already elevated administrator runs the **installed** helper:

```powershell
.\anubis-host.exe prepare-update --name AnubisHost --source-file "C:\Users\person\Downloads\installer.exe" --sha256 <64hex> --size <bytes>
```

Success writes exactly one JSON result:

```json
{"path":"C:\\ProgramData\\Anubis\\Host\\AnubisHost\\updates\\<random32hex>\\installer.exe","size":123,"sha256":"<lowercase64hex>"}
```

The illustrated ProgramData path is resolved from Windows' native known folder,
never from environment variables. Size must be positive and at most 2147483648
bytes. Failure exits nonzero with an explicit stderr error and no success JSON.
The caller must have an unrestricted elevated token with enabled Administrators
membership; this command neither requests UAC elevation nor impersonates SYSTEM.

The command verifies retained private `host.json`, the protected complete install
tree, its own exact installed helper path, and the registered service's exact
helper image/arguments, own-process type, and LocalSystem account. A missing or
mismatched service is an error, even if its retained data exists. It does not
require the service to be running and never changes SCM state.

The source may be a user-owned temporary download, but must be a canonical local
drive path to a single-link regular `.exe`. UNC/network/device paths, alternate
streams, reparse points (including ancestors), DOS devices, and directories are
rejected. A retained native file handle denies concurrent write/delete sharing;
the handle's actual path and byte size are checked before copying.

`updates`, its fresh random leaf, and the output file are created atomically with
Administrators ownership and protected SYSTEM/Administrators-only full-access
DACLs. Existing unsafe staging parents are rejected rather than repaired. No
individual-user ACE is added: the same user's non-elevated token cannot rewrite
the staged installer or its ACL through implicit file ownership. The copy hashes
the actual bytes with SHA256, bounds the read, verifies the expected digest and
exact size, flushes/closes the file, then publishes `installer.exe` without
replacement. Failures remove only the newly created file and empty unique leaf;
previous successful stages remain intact. A shared empty `updates` directory may
remain. Successful stages are retained for the parent updater's lifecycle.

This is not publisher verification or installer execution. The parent must
authenticate the release/hash, perform any required signature checks, consume
the returned protected path, and own installer launch and eventual stage removal.
No profile, machine identity, policy, enrollment, or runtime state is changed.

Windows tests exercise actual file sharing, reparse rejection, copy/hash,
atomic ownership/DACLs, restricted same-account write denial, and exact failure
cleanup. A full protected Program Files/ProgramData fixture substitutes **only**
the SCM query, never the file/security APIs; it registers or launches no service
and executes only a copied Go test helper, not an installer. Its unique fixture
package/data directories are removed on completion.

### Service lifecycle

The following commands are a deployment contract, not authorization to run them
against a real installation. SCM QA requires explicit approval of its unique
`AnubisHost-QA-<suffix>` name and protected isolated package/data paths.

```powershell
# Run the host already staged in the protected Program Files package:
.\anubis-host.exe install --name AnubisHost-QA-UNIQUE --install-dir "C:\Program Files\Anubis-QA-UNIQUE" --allow-user-sids "S-1-5-21-111-222-333-1001"
.\anubis-host.exe start --name AnubisHost-QA-UNIQUE
.\anubis-host.exe status --name AnubisHost-QA-UNIQUE
.\anubis-host.exe broker-client --name AnubisHost-QA-UNIQUE --operation identity
.\anubis-host.exe broker-client --name AnubisHost-QA-UNIQUE --operation list-sessions
.\anubis-host.exe broker-client --name AnubisHost-QA-UNIQUE --operation launch-context --target user --session 2
.\anubis-host.exe stop --name AnubisHost-QA-UNIQUE
# Wait for status.scm.State == 1 (SCM Stopped), then:
.\anubis-host.exe uninstall --name AnubisHost-QA-UNIQUE
```

`install` creates an automatic LocalSystem service but does **not** start it.
It fails if the service already exists. Reinstallation may reuse an identical
retained configuration; it never silently changes the allow-list/runtime.
New config is removed if service creation fails. A failure to finish recovery
configuration attempts to delete the newly created service; failure to roll
back is explicitly returned and its config is retained. `uninstall` requires
SCM Stopped and retains all data/config; no recursive data deletion occurs.
`start`, `stop`, and `uninstall` verify the service's configured image/account
before modifying it. Start/stop submissions are asynchronous; use `status`.

`service --name ...` is SCM-only. `console --name ...` uses the same validated
machine config and lifecycle, requires an actual LocalSystem session-0 token,
and exits on Ctrl+C. It is not a way to turn an administrator into SYSTEM.
The broker's exclusive pipe prevents simultaneous hosts for the same name.

`status` returns actual SCM state/PID/exit codes, configured image/account, and
automatic-start status. SCM values include Stopped=1, StartPending=2,
StopPending=3, Running=4. It is not a claim of GUI or terminal identity.

## Runtime launch contract

The host launches exactly the configured protected runtime, with one fixed mode
and host-generated selectors only:

```text
anubis.exe --anubis-machine-host
  --anubis-data-dir <stable machineRoot\system-profile>
  --anubis-context-id <32 lowercase random hex characters>
  --anubis-ready-file <unique run\ready.json>
  --anubis-error-file <unique run\error.json>
  --anubis-stop-file <unique run\stop.request>
  --anubis-control-pipe <unique local pipe name>
```

A user worker receives `--anubis-context-worker` instead and the user scratch
data leaf. No credentials/proofs are passed in arguments or host logs.

The host queries WTS user tokens, checks the actual account SID against the
machine allow-list, duplicates a primary token, calls `CreateEnvironmentBlock`
for **that token**, and invokes `CreateProcessAsUser`. It never changes
`USERPROFILE`/CWD to impersonate an identity, accepts passwords, or invents a
session when WTS fails. Only SeTcbPrivilege, SeAssignPrimaryTokenPrivilege, and
SeIncreaseQuotaPrivilege are explicitly enabled in the LocalSystem host;
`ERROR_NOT_ALL_ASSIGNED` is fatal. User profiles are assumed loaded by their
existing Windows logon; this host does not perform credentialed logon or
`LoadUserProfile`.

Processes start suspended, enter their own kill-on-close Job Object, and only
then resume. The host retains exact process/job handles and queries the created
process's actual token to verify SID/session. There is no name-based process
killing. Descendants are terminated when their job closes, including recovery,
context exit, and native-host crash. No interactive desktop is requested, and
no GUI is intentionally launched in session 0 or as SYSTEM on a user desktop.

### Ready, error, and graceful stop

After the workspace **and** control pipe are ready, open the precreated ready
file with `r+`, write/truncate/fsync/close **in place**, never rename/recreate:

```json
{"version":1,"pid":1234,"contextId":"0123456789abcdef0123456789abcdef"}
```

The 30-second ready deadline validates the actual PID and unique context ID.
Partial in-place JSON writes are retried. A startup failure should write the
precreated error file similarly:

```json
{"version":1,"pid":1234,"contextId":"0123456789abcdef0123456789abcdef","phase":"engine","code":"ENGINE_START_FAILED"}
```

`phase` must be `bootstrap`, `engine`, `control`, or `shutdown`. `code` must match
`^[A-Z][A-Z0-9_]{0,63}$`, be stable and sanitized, and contain no raw errors,
credentials, or secrets. Host error evidence includes this phase/code or the
actual exit code; invalid/partial readiness eventually yields a sanitized
timeout reason. Startup failures are also reported to the Windows Application
event log (source is the service name, event ID 1; registering a friendly source
message resource is left to the installer).

When `stop.request` appears, stop accepting new work, flush persistent state,
close listeners, terminate owned terminals, and exit within 15 seconds. The
host then closes the job; a timeout is explicitly logged before forced
termination. Context workers stop in parallel. SCM stop/shutdown updates
checkpoints until cleanup completes.

### Runtime-owned control pipe

The runtime **serves** the generated `--anubis-control-pipe` name. It must reject
remote clients and allow only SYSTEM, Administrators, its own account SID, and
its own logon SID. Do not use Node `readableAll` or `writableAll`. The host checks
the kernel-reported pipe server PID against its retained child and rejects
unrelated principals in the pipe DACL before reading private metadata.

Immediately after Node `listen` succeeds, **before** making `getEndpoint()`
ready or writing ready.json, synchronously capture this native helper call:

```text
anubis-host.exe secure-runtime-pipe --pipe <host-generated-name> --server-pid <actual runtime PID>
```

Success is `{"secured":true,"serverPid":1234}`. Nonzero exit is fatal to startup.
This operation accepts only generated local Anubis context pipe names. It checks
the exact kernel server PID and server process primary SID/session against the
helper caller, then sets/re-reads a protected DACL: **deny NETWORK logon SID
S-1-5-2 first**, then allow only SY/BA/ownSID/own-logonSID. It cannot choose a user,
elevate, modify an unrelated process's pipe, or launch code. Node's ordinary
`net` pipe API does not expose `PIPE_REJECT_REMOTE_CLIENTS`; the native NETWORK
deny blocks SMB/network-logon clients, including matching account SIDs.
The host requires this deny before all allows and rejects other deny ACEs.
Real Node/libuv tests verify the DACL persists across later pipe instances.

Host connects with **anonymous SQOS**, so a user worker cannot impersonate the
SYSTEM host. The pipe ACL itself authorizes this connection; do not require
client impersonation to service `describe`. Framing is one UTF-8 JSON object
plus LF per request/reply, under 8 KiB, with a five-second describe deadline.

```json
{"version":1,"operation":"describe"}
```

```json
{"version":1,"ok":true,"result":{"pid":1234,"contextId":"0123456789abcdef0123456789abcdef","endpoint":{"localPort":43123,"privateProof":"at-least-32-random-secret-characters"}}}
```

The endpoint is mandatory. Port must be 1..65535; proof length 32..512. Runtime
must generate cryptographically random proof and bind its authenticated
workspace endpoint to **127.0.0.1 only**. Host attests pipe/PID/token and validates
the descriptor, not the TCP listener's bind address or application protocol.
Parent integration must enforce/prove loopback binding and proof checks.
Proof never goes in ready/error files, CLI arguments, ordinary CLI output, host
identity/status output, logs, or renderer state.

## Authenticated administrative broker v1

The host serves `\\.\pipe\<serviceName>-broker-v1`. `go-winio` uses
`FILE_PIPE_REJECT_REMOTE_CLIENTS`. The protected DACL permits SYSTEM and
Administrators only; a filtered/non-elevated GUI must explicitly request
elevation, not bypass UAC. After reading the request, host impersonates the
client on a locked OS thread, captures its token, reverts immediately, and
requires SYSTEM or an unrestricted elevated effective Administrators member.
**Identification SQOS is sufficient**; no client delegation is needed.
Account-name lookup occurs after revert: LSA resolution under an
identification-level impersonation token fails on real Windows.

One UTF-8 JSON object + LF per connection, request under 8 KiB. Unknown fields,
arbitrary executable/path/argv fields, unknown operations/versions, invalid
targets, and missing/zero user session IDs are rejected. There are at most eight
concurrent broker connections and eight live user contexts. Repeated requests
for the same still-logged-on SID/session return the existing live user context.

```json
{"version":1,"operation":"identity"}
{"version":1,"operation":"list-sessions"}
{"version":1,"operation":"launch-context","target":"system"}
{"version":1,"operation":"launch-context","target":"user","sessionId":2}
```

Success: `{"version":1,"ok":true,"result":...}`.
Failure: `{"version":1,"ok":false,"error":"explicit error"}`.

`identity` result has `host` (actual host identity) and `machine` (live canonical
machine descriptor **without** endpoint/proof, or `null` during recovery).
`list-sessions` result is an array of
`{id,state,sid,account,error?}`, including active (0) and disconnected (4)
Windows sessions. Token/account lookup failures are explicit per-session errors.
`launch-context` result is exactly:

```json
{
  "contextId": "0123456789abcdef0123456789abcdef",
  "controlPipe": "\\\\.\\pipe\\AnubisHost-context-0123456789abcdef0123456789abcdef",
  "dataDir": "C:\\ProgramData\\Anubis\\Host\\AnubisHost\\system-profile",
  "identity": {
    "sid": "S-1-5-18",
    "account": "NT AUTHORITY\\SYSTEM",
    "elevated": true,
    "sessionId": 0,
    "pid": 1234
  },
  "endpoint": {
    "localPort": 43123,
    "privateProof": "at-least-32-random-secret-characters"
  }
}
```

No fallback to another user, SYSTEM, GUI, or new machine identity occurs when a
session/privilege/runtime is unavailable. Existing user contexts are not
automatically restarted under stale WTS tokens after logout. SYSTEM machine
presence remains independent of user context and GUI lifetime.

### Private Node-main bridge

Spawn the protected helper, without a shell:

```text
anubis-host.exe broker-client --name AnubisHost --stdio
```

Write exactly one v1 request + LF to stdin. Capture one full response + LF from
stdout in **Node main only**. This deliberate private bridge includes the
proof: never inherit its stdout into logs, pass it to the renderer, or include
it in diagnostics. stderr has operational errors only; nonzero exit indicates
transport/authentication/protocol/request failure. The bridge verifies pipe
server PID against the running SCM service, actual SYSTEM session-0 token, and
the protected configured host image before sending its request.

Public selector CLI (`--operation ... --target ... --session ...`, without
`--stdio`) removes `privateProof` and marks `proofRedacted`. Raw stdin JSON is
not accepted as an executable, path, arbitrary argument string, or credentials.

## Recovery, QA evidence, and remaining limits

SCM Running is reported only after the machine's file readiness, exact process
identity, pipe PID/ACL, and private endpoint handshake succeed. If the engine
exits, its entire job closes and the host retries after 1/2/4/8/16 seconds.
Five unsuccessful/unstable recoveries fail the service. Five minutes of stable
running resets that counter. During recovery, identity reports `machine: null`
and SYSTEM selection fails explicitly. SCM recovery restarts the native
service after 5/30/60 seconds (including non-crash failure), with a daily reset.
The canonical `system-profile` path survives all these launches/reboots.

Automated Windows tests use unique ephemeral QA named pipes, temporary files,
and test-only child executables, not installed SCM services or real app data.
They exercise actual token identity, environment-resistant identity reporting,
`CreateProcessAsUser`/environment creation under the test caller, readiness,
pipe server PID/ACL checks, authenticated elevated/anonymous callers, framing
limits, reparse rejection, private directory ACLs, sanitized startup errors,
graceful shutdown, and job closure killing the exact owned grandchild.
Test cleanup closes listeners/jobs/process handles and removes its own temp
directories. The test helper is compiled only into the Go test binary.

**Not covered by the Go tests:** LocalSystem SCM installation/start before
logon, WTS launch under another real user, actual terminal identity, GUI-close
continuity, reboot recovery, Electron's headless runtime, production enrollment,
or full parent installer/UAC flow. Those need the parent runtime and explicitly
approved isolated SCM QA. No service is installed/changed by build/tests.
Run artifacts are retained as diagnostics; uninstall does not remove user or
machine profiles. Log rotation, retention policy, installer signing/update
orchestration, engine session restoration, and UI integration remain parent
product responsibilities.

### Approved isolated SCM QA, 2026-10-22

An additional real-SCM run was explicitly approved for **only**
`AnubisHost-QA-7e66c0f5`, its frozen protected package at
`C:\Program Files\Anubis-QA-7e66c0f5`, and its private ProgramData data root.
`system-profile\machine-policy.json` contained `{"managedEnabled":false}`
before the first start; the user allow-list stayed empty. No real user context,
central enrollment, production profile, reboot, or logoff was used.

Real SCM installation/start reached Running as LocalSystem. Both native host
and retained Electron engine reported actual `S-1-5-18`, elevated, session 0.
Private readiness/describe passed. `/run` returned 200/ok; managed browser root
returned 200 with private transport proof and 403 with an invalid proof.
Native `/mcp` initialization, tools/list, and list-tabs returned 200; an
unauthenticated MCP request returned 403. Windows TCP ownership showed the
backend listening on **127.0.0.1 only**. A real loopback Chromium client reached
the store, connected its WebSocket, and rendered xterm without external page
requests. Closing that client did not stop the machine engine.

Stop/start changed host/engine/context identity but retained the exact
`system-profile` directory, SQLite file identity, and private MCP token bytes
(compared only in memory, never printed). Restarted `/run` succeeded and the
disabled-enrollment policy persisted. Exact owned PIDs **and creation times**
were recorded; both stop checks found zero survivors. The exact QA service was
then uninstalled. Independent CIM checks confirmed no QA service or process
from the approved package remained. Private QA data/artifacts were retained.

**Initial frozen-payload blocker, not a passing terminal test:** real browser and MCP
terminal creation failed because the frozen package lacked
`resources\app\node_modules\node-pty\build\Release\conpty\conpty.dll`
(Windows error 3). MCP PTY `whoami /user` timed out with no output; terminal
SYSTEM identity is therefore **not yet proven**. The frozen runtime also
interpreted a generated context ID as an SSH target and warned about an
already-running MCP widget during browser initialization. These observations
were handed to the parent; no shim, ACL weakening, parent-source edit, or
frozen-package modification was made.

### Refreshed-package follow-up, 2026-10-22

The parent restored the missing payload and refreshed its selector/singleton
routing. Under the same exact approved service/package/private-data scope,
authenticated native MCP PTY `whoami /user` now produced:

```text
USER INFORMATION
User Name           SID
nt authority\system S-1-5-18
```

This proves the actual terminal token identity, not merely a `systemprofile`
CWD. No new SSH tab was created from the new context ID. Limited loopback
managed-browser initialization had no duplicate-MCP error and exactly one MCP
widget. Its advertised `http://127.0.0.1:60125/mcp` URL matched the actual Windows
TCP listener owned by that SYSTEM engine. The complete thin GUI was not tested.

**Historical structured MCP result issue (superseded by parent acceptance below):** although the command completed and
printed the SYSTEM SID, `execute_electerm_command` returned `timedOut: true`,
`exitCode: null`, and a PowerShell sentinel ending `ETrue` rather than a numeric
exit code. This was reported to the parent without changing its code.

Stop/start again preserved the machine profile, private MCP identity bytes,
SQLite file identity, disabled-enrollment policy, and SYSTEM session-0 identity.
The exact QA service was stopped and uninstalled; native/Electron, OpenConsole,
and PowerShell owned process/creation-time snapshots had no survivors.
Independent checks confirmed no remaining approved-package process or service.
Pre-logon/reboot behavior and alternate-user switching remain unverified.
Complete thin GUI/installer acceptance and the structured MCP completion fix
were outside this child run; subsequent parent evidence is recorded below.

### Parent structured-PTY and thin-GUI acceptance, 2026-10-22

The parent fixed PowerShell capture to use a real numeric `LASTEXITCODE` and a
child PowerShell containing `exit`, leaving POSIX behavior unchanged. Its
`files\machine-gui-qa.json` evidence was inspected from parent session
`7e66c0f5-8548-422e-8d63-0b8191f87b2a`. The earlier `ETrue` sentinel issue is
**superseded, not outstanding**: authenticated SCM/MCP `whoami /user` reported
SYSTEM SID `S-1-5-18`, `exitCode: 0`, `timedOut: false`; a native nonzero command
returned exactly `exitCode: 37`, also without timeout.

The parent launched the real thin GUI twice as Root in session 2. Both launches
confirmed SYSTEM terminal output and passed all 14 About/settings navigation
checks. Both closed normally while preserving the same SYSTEM engine and
context. Authenticated MCP `whoami /user` still completed successfully after GUI
closure. Parent-owned PID/creation-time cleanup found no survivors, cleanup
errors, installed QA service, or remaining approved-package process.

This is attributed parent acceptance evidence, not a new child rerun. No
additional SCM operation, GUI launch, or system mutation was performed to update
these retained reports. Actual pre-logon/reboot operation, alternate-user
switching, and complete production-installer rollout remain separate scope.
