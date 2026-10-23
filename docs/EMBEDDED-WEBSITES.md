# Embedded websites

HTTP(S) Quick connect in the Windows machine GUI opens an in-app Chromium website
guest, not an iframe. Sites using `X-Frame-Options: SAMEORIGIN` can therefore load
without disabling browser security.

The managed workspace remains `isWebApp: true`. Its sandboxed preload exposes
`window.anubisWebsite` with `version: 1` and `embedded: true`. Only this explicit
capability selects the native website surface. A remote browser has no such
preload, keeps its iframe, and explains that sites may refuse embedding. The
address bar's existing external-open action remains available.

## Isolation

Each native website receives a separate, nonpersistent Electron session issued
by the main process. Renderer-supplied partition names, preload scripts and
webpreferences cannot select the workspace session or relax the guest policy.
Guests have sandboxing, context isolation and web security enabled, and no Node
integration, application preload, nested webviews or machine-role IPC.

The workspace's private transport header, cookies and browser JWT are not copied
into website guests. The private transport header is also stripped from guest
requests. Website permissions are denied. Only HTTP(S) initial destinations and
subsequent navigations are accepted.

Website browsing runs in the interactive GUI, not as the selected machine
backend's Windows account. Selecting a SYSTEM workspace does not give a website
SYSTEM privileges or its credentials.

HTTP authentication uses Electron's challenge callback and the in-app
authentication dialog. Credentials are confined to that guest session, not
stored in a machine profile or uploaded to the management server. Reload and
zoom operate on the existing guest. Closing the tab, replacing the workspace or
closing the GUI destroys its guests. Cookies are not persisted across new tabs.

New-window requests remain inside the existing guest; they cannot create a
privileged application window. Sites requiring a separate popup/opener exchange
may need the explicit external-open action. TLS errors are not bypassed.

## Focused acceptance

From the app checkout, run:

```powershell
node --test src\test\unit-ci\embedded-website.spec.js src\test\unit-ci\machine-client-entry.spec.js src\test\unit-ci\machine-client-connection.spec.js
$env:ANUBIS_WEBSITE_E2E='1'
$env:ANUBIS_WEBSITE_GOOGLE='1'
node --test src\test\integration\embedded-website.spec.js
```

The integration test builds only a temporary renderer fixture, starts isolated
Electron, and exercises the actual shared website component and native guest
guard. It covers a controlled SAMEORIGIN site, guest/header/cookie/JWT isolation,
authentication, navigation, zoom, malicious webview attributes, remote fallback,
main-frame failures, blocked child frames, and guest teardown. The optional
Google check verifies a real HTTP 200 document using normal TLS without
certificate overrides. It does not start the installed application or connect
to the management controller.
