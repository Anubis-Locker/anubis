/**
 * upgrade through ws
 */

import generate from './uid'
import initWs from './ws'

const keys = window.pre.transferKeys

class Upgrade {
  async init ({
    onData,
    onEnd,
    onError,
    ...rest
  }) {
    const id = generate()
    this.id = id
    const ws = await initWs('upgrade', id)
    this.ws = ws
    keys.forEach(func => {
      this[func] = (...args) => {
        if (this.closed) {
          return
        }
        ws.s({
          action: 'upgrade-func',
          id,
          func,
          args
        })
        if (func === 'destroy') {
          this.onDestroy()
        }
      }
    })

    this.onData = (evt) => {
      if (this.closed) {
        return
      }
      const arg = JSON.parse(evt.data)
      if ('upgrade:data:' + id === arg.id) {
        onData(arg.data)
      } else if ('upgrade:end:' + id === arg.id) {
        this.onDestroy()
        onEnd(arg)
      } else if ('upgrade:err:' + id === arg.id) {
        this.onDestroy()
        onError(new Error(arg.error.message))
      }
    }
    ws.addEventListener('message', this.onData)
    ws.onclose = () => {
      if (!this.closed) {
        this.onDestroy()
        onError(new Error('Update connection closed before completion'))
      }
    }
    ws.s({
      ...rest,
      action: 'upgrade-new',
      id
    })
  }

  onDestroy () {
    if (this.closed) {
      return
    }
    this.closed = true
    this.ws.removeEventListener('message', this.onData)
    this.ws.close()
  }
}

export default async (props) => {
  const upgrade = new Upgrade()
  await upgrade.init(props)
  return upgrade
}
