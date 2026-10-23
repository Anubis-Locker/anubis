import AddressBar from './address-bar'
import WebAuthModal from './web-auth-modal'
import React, { useState, useRef, useEffect, useCallback } from 'react'

export default function WebSession ({ tab, reloadTab }) {
  const { url = '' } = tab
  const native = window.anubisWebsite?.version === 1 && window.anubisWebsite.embedded === true
  const [partition, setPartition] = useState(null)
  const [zoom, setZoom] = useState(1.0)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [loadError, setLoadError] = useState('')
  const [authRequest, setAuthRequest] = useState(null)
  const webviewRef = useRef(null)
  let valid = false
  try {
    valid = ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    valid = false
  }
  const embedded = native || !window.et.isWebApp
  const addrProps = {
    url: currentUrl,
    title: tab.title,
    description: tab.description,
    zoom,
    onZoom: handleZoom,
    onOpen: handleOpen,
    onReload: () => {
      if (embedded && webviewRef.current?.reload) {
        setLoadError('')
        webviewRef.current.reload()
      } else reloadTab(tab)
    }
  }

  function handleOpen () {
    window.openLink(currentUrl)
  }

  function handleZoom (value) {
    setZoom(value)
    const el = webviewRef.current
    if (el?.setZoomFactor) el.setZoomFactor(value)
    else if (el) el.style.zoom = value
  }

  useEffect(() => { setCurrentUrl(url); setLoadError('') }, [url])

  useEffect(() => {
    if (!native || !valid) return
    let active = true
    let allocated
    const release = value => window.anubisWebsite.release(value).catch(error => {
      console.error('Embedded website cleanup failed:', error.message)
    })
    window.anubisWebsite.allocate().then(value => {
      allocated = value
      if (active) setPartition(value)
      else release(value)
    }).catch(error => {
      if (active) setLoadError(error.message)
    })
    return () => {
      active = false
      if (allocated) release(allocated)
    }
  }, [native, valid])

  useEffect(() => {
    if (native) {
      const removeAuth = window.anubisWebsite.onAuth(data => {
        if (data.partition !== partition) return
        if (data.cancelled) setAuthRequest(current => current?.id === data.id ? null : current)
        else setAuthRequest(data)
      })
      const removeError = window.anubisWebsite.onError(data => {
        if (data.partition === partition) setLoadError(data.code)
      })
      return () => { removeAuth(); removeError() }
    }
    return window.api?.onWebviewAuthRequest?.(setAuthRequest)
  }, [native, partition])

  useEffect(() => {
    const el = webviewRef.current
    if (!el || !embedded) return
    const ready = () => el.setZoomFactor(zoom)
    const starting = event => {
      if (event.isMainFrame !== false) setLoadError('')
    }
    const failed = event => {
      if (event.isMainFrame !== false && event.errorCode !== -3) {
        setLoadError(event.errorDescription || 'Website could not be loaded')
      }
    }
    const navigated = event => {
      if (/^https?:\/\//i.test(event.url)) setCurrentUrl(event.url)
    }
    const stopped = () => setLoadError('Website renderer stopped. Reload to try again.')
    el.addEventListener('dom-ready', ready)
    el.addEventListener('did-start-navigation', starting)
    el.addEventListener('did-fail-load', failed)
    el.addEventListener('did-navigate', navigated)
    el.addEventListener('did-navigate-in-page', navigated)
    el.addEventListener('render-process-gone', stopped)
    return () => {
      el.removeEventListener('dom-ready', ready)
      el.removeEventListener('did-start-navigation', starting)
      el.removeEventListener('did-fail-load', failed)
      el.removeEventListener('did-navigate', navigated)
      el.removeEventListener('did-navigate-in-page', navigated)
      el.removeEventListener('render-process-gone', stopped)
    }
  }, [embedded, partition, zoom, url])

  const respond = useCallback((username, password) => {
    if (!authRequest) return
    const value = { id: authRequest.id, username, password }
    if (native) {
      window.anubisWebsite.authenticate(value).catch(error => setLoadError(error.message))
    } else {
      window.api.sendWebviewAuthResponse(value)
    }
    setAuthRequest(null)
  }, [native, authRequest])
  const cancelAuth = useCallback(() => respond('', ''), [respond])

  function renderView () {
    if (!valid) return <div>URL: <b>{url}</b> not valid (HTTP or HTTPS required)</div>
    if (!embedded) {
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div role='note' className='pd1'>
            Some websites block embedding in a remote browser.
            {' '}If this page is blank or refused,{' '}
            <button type='button' onClick={handleOpen}>{window.translate('openInDefaultBrowser')}</button>.
          </div>
          <iframe src={url} title={tab.title || 'Website'} style={{ width: '100%', flex: 1, minHeight: 0, border: 'none' }} ref={webviewRef} />
        </div>
      )
    }
    if (native && !partition) return loadError ? null : <div className='pd1'>Opening isolated website...</div>
    return (
      <webview
        key={partition || 'legacy'}
        ref={webviewRef}
        src={url}
        partition={native ? partition : undefined}
        style={{ width: '100%', height: '100%', background: '#fff', display: loadError ? 'none' : undefined }}
        allowpopups='true'
        useragent={tab.useragent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
      />
    )
  }

  return (
    <div className='web-session-wrap'>
      {!tab.hideAddressBar && <AddressBar {...addrProps} />}
      {loadError && <div role='alert' className='pd1'>Website could not be loaded: {loadError}</div>}
      <div className='web-session-content'>{renderView()}</div>
      <WebAuthModal authRequest={authRequest} onAuthSubmit={respond} onAuthCancel={cancelAuth} />
    </div>
  )
}
