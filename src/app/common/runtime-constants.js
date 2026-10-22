/**
 * run time contants
 */

const os = require('os')
const { resolve } = require('path')

const platform = os.platform()
const arch = os.arch()
const isWin = platform === 'win32'
const isMac = platform === 'darwin'
const isLinux = platform === 'linux'
const isArm = arch.includes('arm')

const { NODE_ENV, NODE_TEST } = process.env
const isDev = NODE_ENV === 'development'
// dev: brand resource folder (BRAND_RES_DIR | ../resource | node_modules/@ai-security-tool/resource)
// packaged: copied to assets/images by src/build/bin/copy.js
const devResDir = isDev
  ? require('../../common/brand-res').resolveBrandResDir(resolve(__dirname, '../../..'))
  : ''
const iconPath = resolve(
  __dirname,
  (
    isDev
      ? resolve(devResDir, 'res/imgs/electerm-round-128x128.png')
      : '../assets/images/electerm-round-128x128.png'
  )
)
const trayIconPath = resolve(
  __dirname,
  (
    isDev
      ? resolve(devResDir, 'res/imgs/electerm-round-128x128.png')
      : '../assets/images/electerm-round-128x128.png'
  )
)
const extIconPath = isDev
  ? '/node_modules/@ai-security-tool/icons/icons/'
  : 'icons/'

const defaultUserName = require('./default-user-name')

module.exports = {
  isTest: !!NODE_TEST,
  isDev,
  isWin,
  isMac,
  isArm,
  isLinux,
  iconPath,
  trayIconPath,
  extIconPath,
  defaultUserName,
  minWindowWidth: 320,
  minWindowHeight: 400,
  defaultLang: 'en_us',
  tempDir: require('os').tmpdir(),
  homeOrTmp: os.homedir() || os.tmpdir(),
  packInfo: require(isDev ? '../../../package.json' : '../package.json')
}
