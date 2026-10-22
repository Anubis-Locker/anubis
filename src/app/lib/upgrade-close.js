function closeForUpgrade (message, isWin, globalState) {
  if (!isWin || message?.upgradeInstallerLaunched !== true) {
    return
  }
  const win = globalState.get('win')
  if (!win || win.isDestroyed()) {
    return
  }
  // Use the normal close path, including the user's exit confirmation.
  globalState.set('closeAction', 'closeApp')
  win.close()
}

module.exports = closeForUpgrade
