/**
 * database default should init
 */

function parsor (themeTxt) {
  return themeTxt.split('\n').reduce((prev, line) => {
    let [key = '', value = ''] = line.split('=')
    key = key.trim()
    value = value.trim()
    if (!key || !value) {
      return prev
    }
    prev[key] = value
    return prev
  }, {})
}

const defaultThemeDark = () => {
  return parsor(`
main-dark=#101113
main-light=#25272C
text=#E4E7EC
text-light=#F8FAFC
text-dark=#98A2B3
text-disabled=#667085
primary=#22D3EE
info=#22D3EE
success=#34D399
error=#F87171
warn=#FBBF24
main=#18191C
  `)
}
const defaultThemeLightFunc = () => {
  return parsor(`
      main=#ededed
      main-dark=#cccccc
      main-light=#fefefe
      text=#555
      text-light=#777
      text-dark=#444
      text-disabled=#888
      primary=#08c
      info=#FFD166
      success=#06D6A0
      error=#EF476F
      warn=#E55934
    `)
}

const defaultThemeLightTerminal = () => {
  return parsor(`
background=#121214
foreground=#af9a91
cursor=#af9a91
selectionBackground=#575256
cursorAccent=#121214
black=#572100
red=#ba3934
green=#91773f
yellow=#b55600
blue=#5f63b4
magenta=#a17c7b
cyan=#8faea9
white=#af9a91
brightBlack=#4e4b61
brightRed=#d9443f
brightGreen=#d6b04e
brightYellow=#f66813
brightBlue=#8086ef
brightMagenta=#e2c2bb
brightCyan=#a4dce7
brightWhite=#d2c7a9
    `
  )
}

const defaultThemeDarkTerminal = () => {
  return {
    foreground: '#E4E7EC',
    background: '#101113',
    cursor: '#22D3EE',
    cursorAccent: '#101113',
    selectionBackground: 'rgba(34, 211, 238, 0.3)',
    black: '#1E293B',
    red: '#F87171',
    green: '#34D399',
    yellow: '#FBBF24',
    blue: '#60A5FA',
    magenta: '#C084FC',
    cyan: '#22D3EE',
    white: '#CBD5E1',
    brightBlack: '#475569',
    brightRed: '#FCA5A5',
    brightGreen: '#6EE7B7',
    brightYellow: '#FDE68A',
    brightBlue: '#93C5FD',
    brightMagenta: '#D8B4FE',
    brightCyan: '#67E8F9',
    brightWhite: '#F8FAFC'
  }
}
// id stays 'default' so existing user settings keep resolving; it is the built-in "anubis-dark" theme
export const defaultThemeId = 'default'
export const defaultThemeLightId = 'defaultLight'

export function defaultTheme () {
  return {
    id: defaultThemeId,
    name: 'anubis-dark',
    themeConfig: defaultThemeDarkTerminal(),
    uiThemeConfig: defaultThemeDark()
  }
}

export function defaultThemeLight () {
  return {
    id: defaultThemeLightId,
    name: 'default light',
    themeConfig: defaultThemeLightTerminal(),
    uiThemeConfig: defaultThemeLightFunc()
  }
}
