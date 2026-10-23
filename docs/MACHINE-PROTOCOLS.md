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
`userConfig` record. Existing encrypted values use the same user's safe-storage
decryption. A short-lived read-only SQLite connection reads only this record;
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
