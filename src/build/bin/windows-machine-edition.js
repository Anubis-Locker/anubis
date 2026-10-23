const fs = require('node:fs')
const path = require('node:path')

const production = Object.freeze({
  version: 1,
  edition: 'production',
  serviceName: 'AnubisHost',
  installLeaf: 'Anubis-Security-Tool',
  disableManaged: false
})
const installerQa = Object.freeze({
  version: 1,
  edition: 'installer-qa-7e66c0f5',
  serviceName: 'AnubisHost-QA-installer-7e66c0f5',
  installLeaf: 'Anubis-Security-Tool-QA-installer-7e66c0f5',
  disableManaged: true
})
const migrationQa = Object.freeze({
  version: 1,
  edition: 'migration-qa-7e66c0f5',
  serviceName: 'AnubisHost-QA-migration-7e66c0f5',
  installLeaf: 'Anubis-Security-Tool-QA-migration-7e66c0f5',
  disableManaged: true
})
const qaAppId = 'locker.anubis.securitytool.qa.installer7e66c0f5'
const qaGuid = 'c7b2045c-6a39-4b54-9f09-b9adc9917e66'
const migrationAppId = 'locker.anubis.securitytool.qa.migration7e66c0f5'
const migrationGuid = 'f71e08f8-f8b5-4b34-ade6-7e66c0f5a002'

function validateEdition (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installer edition')
  const expected = [production, installerQa, migrationQa].find(edition => edition.edition === value.edition)
  if (!expected) throw new Error('Unknown installer edition')
  const keys = Object.keys(expected)
  if (Object.keys(value).length !== keys.length ||
      keys.some(key => value[key] !== expected[key])) {
    throw new Error('Installer edition must match an exact compile-time definition')
  }
  return expected
}

function generateEditionInclude (value, destination) {
  const edition = validateEdition(value)
  const source = path.resolve(__dirname, '../windows-machine-install.ps1')
  const script = path.join(destination, 'windows-machine-install.ps1')
  if (path.resolve(script) === source) throw new Error('Do not overwrite the production installer source')
  fs.mkdirSync(destination, { recursive: true })
  const token = `$CompiledEditionJson = '${JSON.stringify(production)}'`
  const input = fs.readFileSync(source, 'utf8')
  if (input.split(token).length !== 2) throw new Error('Missing unique compiled installer edition')
  fs.writeFileSync(script, input.replace(token, `$CompiledEditionJson = '${JSON.stringify(edition)}'`))
  for (const file of ['windows-user-migration.ps1', 'windows-user-migration.cs']) {
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(destination, file))
  }
  const include = path.join(destination, 'windows-installer-edition.nsh')
  const parent = path.resolve(__dirname, '../windows-installer.nsh')
  fs.writeFileSync(include, [
    `!define ANUBIS_MACHINE_LEAF "${edition.installLeaf}"`,
    `!define ANUBIS_MACHINE_SCRIPT "${script}"`,
    ...(edition.disableManaged
      ? [
          '!define /redef isKeepShortcuts "1 == 1"',
          '!define /redef isForceRun "0 == 1"',
          `!define /redef APP_INSTALLER_STORE_FILE "anubis-qa-${edition === migrationQa ? 'migration' : 'installer'}-7e66c0f5-updater\\installer.exe"`
        ]
      : []),
    `!include "${parent}"`,
    ''
  ].join('\n'))
  return include
}

function configureInstallerQa (base, destination, edition = installerQa) {
  if (![installerQa, migrationQa].includes(validateEdition(edition))) throw new Error('Expected a QA edition')
  edition = validateEdition(edition)
  const config = structuredClone(base)
  config.extends = null
  config.appId = edition === migrationQa ? migrationAppId : qaAppId
  config.protocols = []
  config.fileAssociations = []
  config.nsis = {
    ...config.nsis,
    guid: edition === migrationQa ? migrationGuid : qaGuid,
    include: generateEditionInclude(edition, destination),
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
    runAfterFinish: false,
    artifactName: base.artifactName.replace(/\$\{os\}/g, edition === migrationQa ? 'qa-migration-7e66c0f5' : 'qa-installer-7e66c0f5')
  }
  config.win.publish = null
  return config
}

module.exports = { production, installerQa, migrationQa, qaAppId, qaGuid, migrationAppId, migrationGuid, validateEdition, generateEditionInclude, configureInstallerQa }
