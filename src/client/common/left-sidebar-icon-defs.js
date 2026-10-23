/**
 * customizable icons for the far-left sidebar.
 *
 * `text` is a locale key passed to window.translate. The "about",
 * "hide sidebar" and "file transfer" icons are intentionally excluded —
 * they are always visible / conditionally rendered and not part of the
 * customizable set.
 *
 * order of `leftSidebarIconOptions` is the default order shown in the sidebar.
 */
export const leftSidebarIconOptions = [
  { id: 'newBookmark', text: 'newBookmark' },
  { id: 'quickConnect', text: 'quickConnect' },
  { id: 'bookmarks', text: 'bookmarks' },
  { id: 'terminalThemes', text: 'terminalThemes' },
  { id: 'setting', text: 'setting' },
  { id: 'settingSync', text: 'settingSync' },
  { id: 'widgets', text: 'widgets' }
]

// default ordered list of icon ids — mirrors the order above
export const defaultLeftSideBarIcons = leftSidebarIconOptions.map(o => o.id)

// valid ids, for sanitizing persisted/synced config
export const leftSidebarIconIds = new Set(leftSidebarIconOptions.map(o => o.id))

// Legacy selections stay in saved config, but are accessed through the app menu.
export const groupedSidebarIconOptions = [
  'bookmarks', 'quickConnect', 'settingSync', 'widgets', 'setting'
].map(id => leftSidebarIconOptions.find(option => option.id === id))

export function groupedSidebarIconIds (value) {
  const ids = groupedSidebarIconOptions.map(option => option.id)
  return Array.isArray(value)
    ? [...new Set(value.filter(id => ids.includes(id)))]
    : ids
}

/**
 * returns a clean, ordered list of icon ids from a possibly-untrusted value:
 * unknown ids dropped, missing default ids left to the user's choice.
 */
export function normalizeLeftSideBarIcons (value) {
  if (!Array.isArray(value)) {
    return [...defaultLeftSideBarIcons]
  }
  return value.filter(id => leftSidebarIconIds.has(id))
}
