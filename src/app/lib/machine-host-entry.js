const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createRuntimeControl } = require('./machine-runtime-control')
const { writeReady, writeStartupFailure } = require('./machine-runtime-contract')

function failure (code) {
  return Object.assign(new Error('Machine runtime could not start'), { code })
}

function validateRuntimeIdentity (mode, identity) {
  if (!identity || !/^S-1-(?:\d+-)+\d+$/.test(identity.sid) ||
      typeof identity.account !== 'string' || !identity.account ||
      typeof identity.elevated !== 'boolean' || !Number.isInteger(identity.sessionId) ||
      !Number.isInteger(identity.pid) || identity.pid < 1) {
    throw failure('ERR_MACHINE_IDENTITY')
  }
  if (mode === 'system') {
    if (identity.sid !== 'S-1-5-18' || identity.sessionId !== 0 || !identity.elevated) {
      throw failure('ERR_MACHINE_SYSTEM_REQUIRED')
    }
  } else if (mode !== 'user-context' || identity.sessionId < 1 ||
      ['S-1-5-7', 'S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(identity.sid)) {
    throw failure('ERR_MACHINE_USER_REQUIRED')
  }
  return identity
}

function runtimePaths ({ mode, dataDir }, appData, dirName) {
  const root = mode === 'system' ? dataDir : appData
  return { appData: root, userData: path.win32.join(root, dirName) }
}

function cleanRuntimeEnvironment (env) {
  const blocked = new Set([
    'node_options', 'node_path', 'node_test', 'node_env', 'electron_run_as_node',
    'data_path', 'electermhost', 'electermport', 'tokenelecterm', 'requireauth',
    'anubis_managed_transport_secret', 'anubis_managed_admin_token', 'admin_token'
  ])
  for (const key of Object.keys(env)) {
    if (blocked.has(key.toLowerCase())) delete env[key]
  }
  env.NODE_ENV = 'production'
}

function readMachinePolicy (dir) {
  const file = path.join(dir, 'machine-policy.json')
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
    throw failure('ERR_MACHINE_POLICY')
  }
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(key => !['managedEnabled', 'managedUrl'].includes(key)) ||
      ('managedEnabled' in policy && typeof policy.managedEnabled !== 'boolean') ||
      ('managedUrl' in policy && typeof policy.managedUrl !== 'string')) {
    throw failure('ERR_MACHINE_POLICY')
  }
  if ('managedUrl' in policy) {
    const url = new URL(policy.managedUrl)
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw failure('ERR_MACHINE_POLICY')
    }
  }
  return policy
}

function nativeCommand (helper, args) {
  try {
    return JSON.parse(execFileSync(helper, args, {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe']
    }))
  } catch {
    throw failure('ERR_MACHINE_NATIVE_HELPER')
  }
}

async function waitForWorkspace (win, passwordRequired, deadline) {
  while (Date.now() < deadline) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) throw failure('ERR_MACHINE_RENDERER_EXIT')
    const ready = await win.webContents.executeJavaScript(passwordRequired
      ? 'Boolean(window.store && document.querySelector(".login-wrap"))'
      : 'Boolean(window.store && window.et?.wsOpened && window.et.commonWs && !window.et.commonWs.closed && (!window.store.config?.mcpServerEnabled || window.store.widgetInstances?.some(item => item.widgetId === "mcp-server")))')
    if (ready) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw failure('ERR_MACHINE_WORKSPACE_TIMEOUT')
}

async function startMachineHost (invocation) {
  const { app } = require('electron')
  let phase = 'bootstrap'
  let control
  let agent
  let win
  let child
  let monitor
  let startupTimer
  let stopping
  let endpointReady = false
  const globalState = require('./glob-state')
  const stop = (exitCode = 0) => {
    if (stopping) return stopping
    stopping = (async () => {
      clearInterval(monitor)
      clearTimeout(startupTimer)
      endpointReady = false
      globalState.set('machineStopping', true)
      try {
        if (control) await control.close()
        if (agent) await agent.stop()
      } catch (error) {
        exitCode = 1
        try {
          writeStartupFailure(invocation, 'shutdown', error)
        } catch {
          process.stderr.write('Machine runtime shutdown status reporting failed\n')
        }
      } finally {
        if (child && child.exitCode === null) child.kill()
        if (win && !win.isDestroyed()) win.destroy()
        app.exit(exitCode)
      }
    })()
    return stopping
  }
  const failed = error => {
    if (stopping) return stopping
    try {
      writeStartupFailure(invocation, phase, error)
    } catch {
      process.stderr.write('Machine runtime status reporting failed\n')
    }
    return stop(1)
  }
  try {
    startupTimer = setTimeout(() => {
      failed(failure('ERR_MACHINE_WORKSPACE_TIMEOUT'))
    }, 25000)
    app.disableHardwareAcceleration()
    app.setName(require('../common/brand').id)
    const installDir = path.dirname(process.execPath)
    const helper = path.join(installDir, 'anubis-host.exe')
    const validated = nativeCommand(helper, [
      'validate-install', '--install-dir', installDir,
      '--runtime-relative-path', path.basename(process.execPath)
    ])
    if (validated.valid !== true ||
        path.resolve(validated.installDir).toLowerCase() !== path.resolve(installDir).toLowerCase() ||
        validated.runtimeRelativePath.toLowerCase() !== path.basename(process.execPath).toLowerCase()) {
      throw failure('ERR_MACHINE_INSTALLATION')
    }
    const identity = validateRuntimeIdentity(invocation.mode, nativeCommand(helper, ['identity']))
    cleanRuntimeEnvironment(process.env)
    const paths = runtimePaths(invocation, app.getPath('appData'), require('../common/brand').data.dirName)
    fs.mkdirSync(paths.userData, { recursive: true })
    app.setPath('appData', paths.appData)
    app.setPath('userData', paths.userData)
    process.env.DATA_PATH = paths.userData
    process.env.ANUBIS_ADMIN_AUTOSTART = '0'
    process.env.ANUBIS_ADMIN_UPDATE_ENABLED = '0'
    const policy = invocation.mode === 'system' ? readMachinePolicy(invocation.dataDir) : { managedEnabled: false }
    if ('managedEnabled' in policy) process.env.ANUBIS_ADMIN_MANAGED_ENABLED = policy.managedEnabled ? '1' : '0'
    if (policy.managedUrl) process.env.ANUBIS_ADMIN_MANAGED_URL = policy.managedUrl
    globalState.set('machineRuntimeRole', invocation.mode)
    globalState.set('machineIdentity', { ...identity, pid: process.pid })
    globalState.set('app', app)
    globalState.set('initTime', Date.now())
    if (!app.requestSingleInstanceLock()) throw failure('ERR_MACHINE_PROFILE_IN_USE')
    await app.whenReady()
    phase = 'engine'
    const deadline = Date.now() + 20000
    const config = await require('./get-config').getDbConfig()
    win = await require('./create-window').createWindow(config, { headless: true, managed: false })
    win.webContents.on('render-process-gone', () => { failed(failure('ERR_MACHINE_RENDERER_EXIT')) })
    child = globalState.get('serverChild')
    child.once('exit', () => { failed(failure('ERR_MACHINE_BACKEND_EXIT')) })
    await waitForWorkspace(win, !!config.hashedPassword, deadline)
    phase = 'control'
    control = createRuntimeControl({
      pipe: invocation.controlPipe,
      contextId: invocation.contextId,
      getEndpoint: () => {
        if (!endpointReady) throw failure('ERR_ENGINE_NOT_READY')
        return {
          localPort: globalState.get('config').port,
          privateProof: globalState.get('managedTransportSecret')
        }
      },
      onError: () => { process.stderr.write('Machine runtime control request failed\n') },
      onFatal: error => { failed(error) }
    })
    await control.start()
    const secured = nativeCommand(helper, [
      'secure-runtime-pipe', '--pipe', invocation.controlPipe, '--server-pid', String(process.pid)
    ])
    if (secured.secured !== true || secured.serverPid !== process.pid) throw failure('ERR_MACHINE_CONTROL_SECURITY')
    endpointReady = true
    if (invocation.mode === 'system') {
      agent = require('./managed-startup').startDesktopManaged({
        app,
        child,
        port: globalState.get('config').port,
        header: globalState.get('managedTransportSecret'),
        globalState,
        log: require('../common/log')
      })
      globalState.set('managedRuntime', agent)
    } else {
      globalState.set('managedConnectivity', { status: 'disabled' })
    }
    const checkStop = () => {
      try {
        fs.lstatSync(invocation.stopFile)
        phase = 'shutdown'
        stop()
      } catch (error) {
        if (error.code !== 'ENOENT') failed(error)
      }
    }
    monitor = setInterval(checkStop, 200)
    writeReady(invocation)
    clearTimeout(startupTimer)
    checkStop()
    return { stop }
  } catch (error) {
    await failed(error)
  }
}

module.exports = { startMachineHost, validateRuntimeIdentity, runtimePaths, readMachinePolicy, cleanRuntimeEnvironment, waitForWorkspace }
