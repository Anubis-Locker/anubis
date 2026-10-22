const { rm, echo, cd, cp, exec } = require('shelljs')
const { resolve } = require('path')
const fs = require('fs')
const pack = require('../../../package.json')
const tpack = require('../web-app/package.json')
tpack.version = pack.version

const to = resolve(__dirname, '../web-app/')
const from = resolve(__dirname, '../../../src/client')

// (re)generate src/build/web-app/README.md from the root README.md
require('./gen-web-app-readme')

echo('start build electerm-react pack and publish')
fs.writeFileSync(resolve(to, 'package.json'), JSON.stringify(tpack, null, 2))
rm('-rf', resolve(to, 'client'))
cp('-r', from, to)
cd(to)
// Publishes @ai-security-tool/electerm-react to the private registry
// (env NPM_REGISTRY_URL, auth via NPM_TOKEN in the workflow's .npmrc).
const registry = process.env.NPM_REGISTRY_URL || 'https://npm.anubis.locker/'
exec(`npm publish --access public --registry ${registry}`)
