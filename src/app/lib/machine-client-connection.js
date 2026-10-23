const { publicContext } = require('./windows-host-client')

function sameContext (first, second) {
  return !!first && !!second &&
    first.contextId === second.contextId &&
    first.identity.sid === second.identity.sid &&
    first.identity.account === second.identity.account &&
    first.identity.elevated === second.identity.elevated &&
    first.identity.sessionId === second.identity.sessionId &&
    first.identity.pid === second.identity.pid &&
    first.endpoint.localPort === second.endpoint.localPort &&
    first.endpoint.privateProof === second.endpoint.privateProof
}

function createMachineConnection ({
  resolve, attach, clear, notify,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now,
  interval = 3000, retryTimeout = 120000
}) {
  let generation = 0
  let timer
  let context = null
  let disposed = false
  let controller = new AbortController()
  const replaced = () => ({ ok: false, code: 'ERR_HOST_CONTEXT_REPLACED' })
  const reset = () => {
    generation++
    controller.abort()
    controller = new AbortController()
    cancel(timer)
    context = null
    clear()
  }
  async function update (selection, current, deadline = 0) {
    const active = () => !disposed && current === generation
    if (!active()) return replaced()
    if (deadline && now() >= deadline) {
      const result = { ok: false, code: 'ERR_HOST_CONTEXT_UNAVAILABLE', reconnecting: false }
      notify(result)
      return result
    }
    try {
      const selected = await resolve(selection, controller.signal)
      if (!active()) return replaced()
      if (!sameContext(context, selected)) {
        context = null
        clear()
        await attach(selected)
        if (!active()) return replaced()
        context = selected
        notify({ ok: true, context: publicContext(selected) })
      }
      timer = schedule(() => update(selection, current), interval)
      return { ok: true, context: publicContext(selected) }
    } catch (error) {
      if (!active()) return replaced()
      context = null
      clear()
      const invalid = ['ERR_HOST_CONTEXT_IDENTITY', 'ERR_HOST_DESCRIPTOR'].includes(error.code)
      const until = deadline || now() + retryTimeout
      const reconnecting = !invalid && now() < until
      const result = {
        ok: false,
        code: invalid ? error.code : 'ERR_HOST_CONTEXT_UNAVAILABLE',
        reconnecting
      }
      notify(result)
      if (reconnecting) timer = schedule(() => update(selection, current, until), interval)
      return result
    }
  }
  return {
    select (selection) {
      reset()
      return disposed ? Promise.resolve(replaced()) : update(selection, generation)
    },
    dispose () {
      disposed = true
      reset()
      controller.abort()
    },
    invalidate () {
      context = null
      clear()
    },
    getContext: () => context && publicContext(context)
  }
}

module.exports = { createMachineConnection, sameContext }
