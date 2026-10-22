const { execFile } = require('child_process')

module.exports = function launchWindowsInstaller (file) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:ANUBIS_INSTALLER_PATH_B64))
  $installer = Start-Process -FilePath $path -PassThru -ErrorAction Stop
  if ($null -eq $installer) { throw 'Installer process was not created' }
  [Console]::Out.WriteLine($installer.Id)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 120000,
      env: {
        ...process.env,
        ANUBIS_INSTALLER_PATH_B64: Buffer.from(file, 'utf8').toString('base64')
      }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      const pid = Number(stdout.trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error('Installer process creation was not confirmed'))
        return
      }
      resolve(pid)
    })
  })
}
