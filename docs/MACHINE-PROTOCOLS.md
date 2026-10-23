# Windows machine GUI protocol handlers

The interactive machine client registers the existing brand protocol handlers
after Electron is ready and only in its primary GUI instance. The packaged
defaults are `anubis`, `ssh`, `telnet`, `rdp`, `vnc`, `serial`, `spice` and `ftp`.
HTTP and HTTPS are never registered; the normal default browser is unchanged.
Registration uses the existing deep-link helper without forcing development
registration or bypassing Windows association policy.

The original `deepLinkAutoRegister: false` preference is honored for the Windows
user opening the GUI. It is read from that user's existing
`%APPDATA%\anubis\users\default_user\electerm_data.db`, `data` table,
`userConfig` record. A short-lived read-only SQLite connection reads only this record;
the GUI does not initialize, migrate, create or modify workspace databases.
A missing profile or record retains the original default-on behavior. Invalid
or unreadable configuration prevents registration and records a sanitized
error rather than silently overriding an opt-out.
Opting out suppresses startup registration; it does not remove existing Windows
associations, matching the original startup preference.

Registration does not read the selected SYSTEM or other-user workspace's
settings. SYSTEM/session-zero launches are rejected before this code, and
headless machine/context runtimes and remote browsers do not register handlers.
Selecting or reconnecting a workspace does not repeat registration.

## Encrypted preference isolation

On Windows, Chromium safe-storage ciphertext also depends on the key in the
product profile's `Local State`, not just the Windows identity. The GUI keeps
its separate `anubis-client` userData and sessionData. It never redirects its
Chromium caches to a worker profile or copies keys into another profile/account.

For existing `enc:v2:safe:` records, the native startup reader reads the caller's
product `Local State` without modifying it. Windows DPAPI
`ProtectedData.Unprotect(CurrentUser)` unwraps its `DPAPI`-prefixed key using
hidden, no-profile Windows PowerShell at the actual system-directory path
returned by the installed identity helper. The constant script has no secrets
in arguments or environment variables; wrapped input and transient output use
private bounded pipes. Node's AES-256-GCM then authenticates the Chromium `v10`
record. Only the startup boolean leaves this reader, and transient key/output
buffers are cleared. No general decryption RPC is exposed.

Config and Local State inputs are bounded to 4 MiB, the wrapped key to 16 KiB,
native output to 4 KiB, and the native operation to ten seconds. Invalid framing,
authentication failure, missing keys and native failures prevent registration
with a sanitized error. A missing profile or config record still defaults on
without requiring any encryption key.

This startup fix does not add remote-browser protocol-management capabilities.
Windows remains responsible for final default-app selection. Connection URLs
still go through the machine GUI's existing explicit destination-account
confirmation before entering a selected workspace.

## Isolated regression

```powershell
node --test src\test\unit-ci\machine-client-protocols.spec.js src\test\unit-ci\machine-client-entry.spec.js
```

These tests use temporary SQLite profiles and fake Electron protocol APIs, not
the current Windows account's registry or profile. Existing candidate packages
do not acquire this fix until rebuilt from the patched source.

Real Windows crypto-context regression:

```powershell
$env:ANUBIS_PROTOCOLS_E2E='1'
node --test src\test\integration\machine-client-protocols.spec.js
```

This launches separate disposable Electron producer/client processes with
different Chromium profiles. Actual encrypted false, true and default settings
are decoded while the client's own crypto context stays unchanged. Tampered
ciphertext, wrong keys and missing Local State fail closed; missing records
still default on. Fixture DB bytes, product Local State, client Local State and
client userData/sessionData are checked for changes across the reader call.
It does not launch the installed product, register protocols or touch real user
profiles.
