/**
 * ui theme related
 */

const defaultUiThemeStylus = `
  --main #111A2E
  --main-dark #0B1220
  --main-light #1A2740
  --text #E2E8F0
  --text-light #F8FAFC
  --text-dark #94A3B8
  --text-disabled #64748B
  --primary #22D3EE
  --info #22D3EE
  --success #34D399
  --error #F87171
  --warn #FBBF24
`

export function getUiThemeConfig (conf = defaultUiThemeStylus) {
  const lines = conf.split('\n').filter(line => line.trim())
  return lines.reduce((p, line) => {
    const [k, v] = line.trim().replace('--', '').split(' ')
    if (k && v) {
      return {
        ...p,
        [k]: v
      }
    }
    return p
  }, {})
}

/**
 * convert themeText to themeConfig object
 * @param {string} themeTxt
 * @return {object}
 */
export const convertTheme = (themeTxt) => {
  return themeTxt.split('\n').reduce((prev, line) => {
    let [key = '', value = ''] = line.split('=')
    key = key.trim()
    value = value.trim()
    if (!key || !value) {
      return prev
    }
    if (key === 'themeName') {
      prev.name = value.slice(0, 50)
    } else {
      prev.themeConfig[key] = value
    }
    return prev
  }, {
    name: 'unnamed theme',
    themeConfig: {}
  })
}
