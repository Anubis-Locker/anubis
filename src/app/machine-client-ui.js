/* global document, window */
const selection = document.querySelector('#context')
const refresh = document.querySelector('#refresh')
const elevate = document.querySelector('#elevate')
const status = document.querySelector('#status')
const error = document.querySelector('#error')
const update = document.querySelector('#update')
const updateStatus = document.querySelector('#update-status')
const intent = document.querySelector('#intent')
const clearIntents = document.querySelector('#intent-clear')
const intentStatus = document.querySelector('#intent-status')
const systemPassword = document.querySelector('#system-password')
const passwordStatus = document.querySelector('#password-status')

function showIntents (value) {
  intent.hidden = !value.pending
  clearIntents.hidden = !value.pending
  intent.textContent = 'Open requested connection (' + value.pending + ')'
  intentStatus.textContent = value.code || value.intentCode || value.phase || ''
}

function showFailure (value) {
  status.textContent = value.code
  error.hidden = false
  error.textContent = value.elevationRequired
    ? 'Windows administrator approval is required to access the SYSTEM host. The application will not fall back to a different account or start a replacement agent.'
    : value.reconnecting
      ? 'Connection lost. Reconnecting to the same selected Windows account for up to two minutes. No fallback account or separate local agent will be used.'
      : 'The Windows service or selected user context is unavailable. Check the service and permitted Windows accounts, then click Refresh. No fallback account or separate local agent has been used.'
  elevate.hidden = !value.elevationRequired
}

async function connect () {
  selection.disabled = true
  error.hidden = true
  const option = selection.selectedOptions[0]
  const result = await window.anubisHost.connect(option.value === 'system'
    ? { target: 'system' }
    : { target: 'user', sessionId: Number(option.value) })
  selection.disabled = false
  if (!result.ok) showFailure(result)
}

async function load () {
  refresh.disabled = true
  const result = await window.anubisHost.list()
  refresh.disabled = false
  if (!result.ok) return showFailure(result)
  showIntents(result)
  const previous = selection.value || 'system'
  const previousSid = selection.selectedOptions[0]?.dataset.sid
  selection.replaceChildren()
  const system = document.createElement('option')
  system.value = 'system'
  system.textContent = 'SYSTEM — machine workspace'
  selection.append(system)
  for (const session of result.sessions) {
    const option = document.createElement('option')
    option.value = String(session.id)
    option.dataset.sid = session.sid
    option.textContent = session.account + ' — user workspace (session ' + session.id + ')'
    option.disabled = !!session.error
    selection.append(option)
  }
  const retained = [...selection.options].find(option => option.value === previous &&
    (previous === 'system' || option.dataset.sid === previousSid))
  if (!retained) {
    const missing = document.createElement('option')
    missing.value = previous
    missing.dataset.sid = previousSid
    missing.textContent = 'Previously selected Windows session is unavailable'
    missing.disabled = true
    selection.append(missing)
    selection.value = previous
    selection.disabled = false
    return showFailure({ code: 'ERR_HOST_CONTEXT_IDENTITY' })
  }
  selection.value = previous
  selection.disabled = false
  elevate.hidden = true
  await connect()
}

window.anubisHost.onState(value => {
  if (!value.ok) return showFailure(value)
  status.textContent = value.context.identity.account + ' | ' + value.context.identity.sid
  error.hidden = true
})
selection.addEventListener('change', connect)
refresh.addEventListener('click', load)
elevate.addEventListener('click', async () => {
  const result = await window.anubisHost.elevate()
  if (!result.ok) showFailure(result)
})
window.anubisHost.onUpdate(value => {
  updateStatus.textContent = value.phase === 'download' ? value.percent + '%' : value.phase
})
window.anubisHost.onIntent(showIntents)
intent.addEventListener('click', async () => {
  intent.disabled = true
  clearIntents.disabled = true
  try {
    const result = await window.anubisHost.openIntent()
    if (!result.ok) {
      intentStatus.textContent = result.code === 'ERR_HOST_INTENT_LOGIN'
        ? 'Unlock the selected workspace, then retry the request.'
        : result.code
    }
  } catch {
    intentStatus.textContent = 'ERR_HOST_INTENT_FAILED'
  } finally {
    intent.disabled = false
    clearIntents.disabled = false
  }
})
clearIntents.addEventListener('click', async () => {
  const result = await window.anubisHost.clearIntents()
  if (!result.ok) intentStatus.textContent = result.code
})
update.addEventListener('click', async () => {
  update.disabled = true
  try {
    const result = await window.anubisHost.update()
    updateStatus.textContent = result.ok
      ? result.phase === 'current' ? 'Up to date' : result.phase
      : result.code
    if (!result.ok && result.elevationRequired) showFailure(result)
  } catch {
    updateStatus.textContent = 'ERR_HOST_UPDATE_FAILED'
  } finally {
    update.disabled = false
  }
})
systemPassword.addEventListener('click', async () => {
  systemPassword.disabled = true
  try {
    const result = await window.anubisHost.passwordSettings()
    passwordStatus.textContent = result.ok
      ? result.committed ? 'SYSTEM password saved; sign in again.' : 'Administrator approval requested; reopen SYSTEM password after restart.'
      : result.committed ? 'Password committed; follow-up failed. Do not repeat the update. ' + result.code : result.code
    if (result.elevationRequired) showFailure(result)
  } catch {
    passwordStatus.textContent = 'Password operation outcome unknown. Do not retry automatically.'
  } finally {
    systemPassword.disabled = false
  }
})
load()
