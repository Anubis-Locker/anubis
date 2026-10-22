/**
 * check latest release for update warn
 */

import fetch from './fetch-from-server'
import {
  baseUpdateCheckUrls, packInfo, brand
} from './constants'
import dayjs from 'dayjs'

async function fetchData (url, options) {
  const data = {
    action: 'fetch',
    options: {
      ...options,
      url,
      timeout: 15000
    },
    proxy: window.store.getProxySetting()
  }
  return fetch(data)
}

function getInfo (url) {
  const n = Date.now()
  const tail = url.includes('?') ? '&_=' + n : '?_=' + n
  return fetchData(url + tail, {
    action: 'get-update-info',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Safari/537.36'
    },
    timeout: 1000 * 60 * 5
  })
    .catch(() => {
      return null
    })
}

// only the app version is sent, no usage telemetry
export async function getLatestReleaseVersion () {
  const q = '?version=' + encodeURIComponent(packInfo.version)
  const versionFile = window.et.versionFile || brand.update.versionFile
  for (const base of baseUpdateCheckUrls) {
    const tagName = await getInfo(`${base}/${versionFile}${q}`)
    if (tagName) {
      return {
        tag_name: tagName
      }
    }
  }
}

// mirrors come from brand.update.mirrors; a template may use {url}, {tag}, {file}
export function getDownloadUrl (browserDownloadUrl, mirror) {
  if (!browserDownloadUrl) {
    return ''
  }
  const m = brand.update.mirrors.find(d => d.id === mirror)
  if (!m) {
    return browserDownloadUrl
  }
  const arr = browserDownloadUrl.split('/')
  const len = arr.length
  return m.template
    .replace('{url}', browserDownloadUrl)
    .replace('{tag}', arr[len - 2])
    .replace('{file}', arr[len - 1])
}

export async function getLatestReleaseInfo () {
  const { installSrc } = window.store
  let res
  for (const base of baseUpdateCheckUrls) {
    res = await getInfo(`${base}${brand.update.releaseJson}`)
    if (res?.release?.body) {
      break
    }
  }
  if (!res || !res.release) {
    return undefined
  }
  const asset = (res.release.assets || []).find(r => r.name.includes(installSrc))
  return {
    body: res.release.body,
    date: dayjs(res.release.published_at).format('YYYY-MM-DD'),
    browserDownloadUrl: asset ? asset.browser_download_url : ''
  }
}
