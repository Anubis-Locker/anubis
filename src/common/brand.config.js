/**
 * Central brand configuration (single source of truth).
 *
 * CommonJS on purpose, so it can be required by:
 *  - the electron main process (src/app, via src/app/common/brand.js)
 *  - build scripts (src/build/bin/pug.js, src/build/vite/dev-server.js)
 * The renderer receives a copy as `window.et.brand` (injected into index.html
 * by pug.js / dev-server.js) and reads it through `brand` in
 * src/client/common/constants.js.
 *
 * Do not put secrets here: the whole object is shipped to the renderer.
 */

const domain = 'anubis.locker'
const org = 'ai-security-tool' // internal npm scope / publisher id, unrelated to the GitHub account below
const githubOwner = 'Anubis-Locker' // real GitHub account that hosts the public repos
const id = 'anubis'
const name = 'Anubis-Security-Tool'

const site = `https://${domain}`
const subdomain = (s) => `https://${s}.${domain}`
const repoUrl = `https://github.com/${githubOwner}/${id}`
const wikiBase = `${subdomain('docs')}/wiki`

const wikiPages = {
  sshTunnel: 'How-to-use-ssh-tunnel',
  proxyFormat: 'proxy-format',
  keywordsRegex: 'Terminal-keywords-highlight-regular-expression-exmaples',
  connectionHopping: 'Connection-Hopping-Behavior-Change',
  aiConfig: 'AI-model-config-guide',
  installCommand: 'Install-command',
  sshKeyContentOrPath: 'SSH-Key-Content-vs-Key-Path',
  mouseEventsAlt: 'Mouse-events-require-alt',
  sftpFollowSshPath: 'Warning-about-sftp-follow-ssh-path-function',
  githubToken: 'Create-personal-access-token',
  customSync: 'Custom-sync-server',
  webdavSync: 'WebDAV-sync',
  giteeSyncWarning: 'gitee-data-sync-warning',
  x11: 'Use-X11',
  privacy: 'privacy-notice',
  knownIssues: 'Know-issues',
  batchOp: 'Batch-operation',
  sshAgent: 'SSH-agent',
  rdp: 'RDP',
  profile: 'Profile',
  quickCommands: 'Quick-commands',
  quickConnect: 'Quick-connect',
  startSession: 'Start-session',
  dataImport: 'Data-import',
  layout: 'Layout',
  terminalConfig: 'Terminal-config',
  widgets: 'Widgets',
  aiBookmark: 'AI-bookmark',
  themeAi: 'Theme-AI-editor',
  commonSetting: 'Common-settings'
}

const brand = {
  // identity
  name,
  id,
  productName: id,
  description: 'Terminal/ssh/sftp/telnet/serialport/RDP/VNC/Spice/ftp client for Linux, macOS and Windows.',
  appId: 'locker.anubis.securitytool',
  cliName: id,
  legacyCliNames: ['electerm'],
  npmPackage: id,

  // protocols (custom deep link scheme + standard ones)
  protocol: {
    custom: id,
    legacyCustom: ['electerm'],
    extra: ['ssh', 'telnet', 'vnc', 'rdp', 'spice', 'serial', 'ftp']
  },

  // local data. dirName is used for the data dir and (via package.json name)
  // electron userData; keep them equal.
  data: {
    dirName: id,
    // legacy data folders (under the OS appData dir) copied once on first start when the new one is empty; [] disables
    legacyDataDirs: ['electerm'],
    tmpPrefix: `${id}-`
  },

  // domains / urls
  domains: {
    site,
    cloud: subdomain('cloud'),
    update: subdomain('update'),
    download: subdomain('download'),
    sync: subdomain('sync'),
    ai: subdomain('ai'),
    api: subdomain('api'),
    theme: subdomain('theme'),
    docs: subdomain('docs'),
    demo: subdomain('demo')
  },

  update: {
    enabled: true,
    // checked in order; first one that answers wins
    baseUrls: [subdomain('update')],
    versionFile: 'version.html',
    releaseJson: `/data/${id}-github-release.json`,
    // update check only sends the app version (no usage telemetry)
    sendTelemetry: false,
    // download mirrors. Placeholders: {url} full asset url, {tag} release tag, {file} file name
    mirrors: [
      { id: 'direct', name: 'direct', template: '{url}' },
      { id: 'download', name: 'download', template: `${subdomain('download')}/{tag}/{file}` }
    ],
    manualLinks: [
      { name: 'homepage', url: site },
      { name: 'download', url: subdomain('download') }
    ]
  },

  repo: {
    owner: githubOwner,
    name: id,
    url: repoUrl,
    issues: `${repoUrl}/issues`,
    newIssue: `${repoUrl}/issues/new`,
    releases: `${repoUrl}/releases`,
    discussions: `${repoUrl}/discussions`,
    homepage: site,
    localesEdit: `https://github.com/${githubOwner}/${id}-locales/edit/master/locales`
  },

  docs: {
    wikiBase,
    pages: wikiPages,
    privacy: `${wikiBase}/${wikiPages.privacy}`,
    knownIssues: `${wikiBase}/${wikiPages.knownIssues}`
  },

  sync: {
    cloudSite: subdomain('sync'),
    cloudApi: `${subdomain('sync')}/api/sync`
  },

  ai: {
    baseURL: `${subdomain('ai')}/api/ai`,
    siteUrl: subdomain('ai'),
    id: `ai.${domain}`,
    name: `ai.${domain}`
  },

  theme: {
    site: subdomain('theme'),
    itermSchemesRepo: 'https://github.com/mbadolato/iTerm2-Color-Schemes'
  },

  author: {
    name: org,
    email: `support@${domain}`,
    url: `https://github.com/${githubOwner}`
  },
  copyright: `Copyright (c) ${org}; portions Copyright (c) 2017~ ZHAO Xudong (MIT)`,

  sponsor: {
    // empty hides the Sponsor row in the info modal
    link: '',
    wechatGroupQr: null
  },

  appx: {
    identityName: `${org}.${id}`,
    publisher: 'CN=REPLACE-WITH-YOUR-PARTNER-CENTER-ID',
    publisherDisplayName: org
  }
}

module.exports = brand
