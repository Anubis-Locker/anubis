const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateRuntimeIdentity, runtimePaths, readMachinePolicy, cleanRuntimeEnvironment } = require('../../app/lib/machine-host-entry')

const system = { sid: 'S-1-5-18', account: 'NT AUTHORITY\\SYSTEM', elevated: true, sessionId: 0, pid: 1234 }
const user = { sid: 'S-1-5-21-111-222-333-1001', account: 'MACHINE\\user', elevated: false, sessionId: 2, pid: 5678 }

test('machine host requires actual SYSTEM SID in session zero, not an account name or directory', () => {
  assert.equal(validateRuntimeIdentity('system', system), system)
  for (const identity of [
    { ...user, account: 'NT AUTHORITY\\SYSTEM' },
    { ...system, sessionId: 2 },
    { ...system, elevated: false },
    { ...system, sid: undefined },
    { ...system, pid: 0 }
  ]) {
    assert.throws(() => validateRuntimeIdentity('system', identity))
  }
})

test('logged-on context requires its real non-service account/session without SYSTEM fallback', () => {
  assert.equal(validateRuntimeIdentity('user-context', user), user)
  for (const identity of [
    system, { ...user, sessionId: 0 }, { ...user, sid: 'S-1-5-19' }, { ...user, sid: 'S-1-5-7' }
  ]) {
    assert.throws(() => validateRuntimeIdentity('user-context', identity))
  }
})

test('headless environment cannot redirect bind/auth/profile or expose controller credentials to terminals', () => {
  const env = {
    ANUBIS_MANAGED_ADMIN_TOKEN: 'controller-secret',
    admin_TOKEN: 'controller-secret',
    Anubis_Managed_Transport_Secret: 'inherited-proof',
    ANUBIS_MACHINE_CONTEXT_SERVICE: 'AnubisHost-QA-forged-parent',
    ElectermHost: '0.0.0.0',
    ELECTERMPORT: '40000',
    TokenElecterm: 'inherited-token',
    RequireAuth: 'inherited-auth',
    Node_Test: '1',
    NODE_OPTIONS: '--require untrusted.js',
    NODE_PATH: 'untrusted-modules',
    DATA_PATH: 'C:\\incorrect-profile',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'development',
    USERPROFILE: 'C:\\Users\\real-user',
    APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
    PATH: 'real-user-path'
  }
  cleanRuntimeEnvironment(env)
  assert.deepEqual(env, {
    NODE_ENV: 'production',
    USERPROFILE: 'C:\\Users\\real-user',
    APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
    PATH: 'real-user-path'
  })
})

test('SYSTEM uses persistent machine data while user context retains actual user appData and DPAPI profile', () => {
  assert.deepEqual(runtimePaths({
    mode: 'system', dataDir: 'C:\\ProgramData\\Anubis\\Host\\AnubisHost\\system-profile'
  }, 'C:\\Windows\\system32\\config\\systemprofile\\AppData\\Roaming', 'anubis'), {
    appData: 'C:\\ProgramData\\Anubis\\Host\\AnubisHost\\system-profile',
    userData: 'C:\\ProgramData\\Anubis\\Host\\AnubisHost\\system-profile\\anubis'
  })
  assert.deepEqual(runtimePaths({
    mode: 'user-context', dataDir: 'C:\\ProgramData\\Anubis\\Host\\runs\\scratch'
  }, 'C:\\Users\\example\\AppData\\Roaming', 'anubis'), {
    appData: 'C:\\Users\\example\\AppData\\Roaming',
    userData: 'C:\\Users\\example\\AppData\\Roaming\\anubis'
  })
})

test('protected machine policy permits explicit loopback QA without production enrollment', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-machine-policy-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  const file = path.join(dir, 'machine-policy.json')
  assert.deepEqual(readMachinePolicy(dir), {})
  fs.writeFileSync(file, JSON.stringify({ managedEnabled: false, managedUrl: 'http://127.0.0.1:40001' }))
  assert.deepEqual(readMachinePolicy(dir), { managedEnabled: false, managedUrl: 'http://127.0.0.1:40001' })
  for (const policy of [
    [], null, { managedEnabled: 'false' }, { executable: 'cmd.exe' },
    { managedUrl: 'http://example.com' }, { managedUrl: 'https://user:secret@example.com' },
    { managedUrl: 'https://example.com/?token=secret' }
  ]) {
    fs.writeFileSync(file, JSON.stringify(policy))
    assert.throws(() => readMachinePolicy(dir))
  }
})
