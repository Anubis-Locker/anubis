import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { canonicalPath, loadDependency, parseArguments, repositoryRoot, sha256, siteOrigin, sourceBase, sourceRef } from './build.mjs'

async function inventory (directory, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Symlink in output: ${entry.name}`)
    const relative = prefix + entry.name
    if (entry.isDirectory()) result.push(...await inventory(path.join(directory, entry.name), relative + '/'))
    else {
      assert(entry.isFile(), `Not a regular output file: ${relative}`)
      result.push(relative)
    }
  }
  return result.sort()
}

async function inspectHtml (page) {
  const result = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')]
    const attributes = (selector, name) => [...document.querySelectorAll(selector)].map(node => node.getAttribute(name))
    return {
      links: attributes('a[href]', 'href'),
      assets: [
        ...attributes('[src]', 'src'),
        ...attributes('[poster]', 'poster'),
        ...attributes('[srcset]', 'srcset'),
        ...attributes('link[rel="stylesheet"]', 'href')
      ],
      ids: attributes('[id]', 'id'),
      headings: attributes('h1,h2,h3,h4,h5,h6', 'id'),
      canonicals: attributes('link[rel="canonical"]', 'href'),
      scripts: document.querySelectorAll('script').length,
      stylesheets: attributes('link[rel="stylesheet"]', 'href'),
      unexpectedLinks: document.querySelectorAll('link:not([rel="canonical"]):not([rel="stylesheet"])').length,
      inlineHandlers: all.some(node => [...node.attributes].some(attribute => attribute.name.startsWith('on'))),
      baseOrInlineStyle: document.querySelectorAll('base,style').length,
      navigation: Boolean(document.querySelector('nav[aria-label]')),
      language: document.documentElement.lang,
      charset: document.characterSet.toLowerCase() === 'utf-8',
      viewportFits: document.documentElement.scrollWidth <= window.innerWidth
    }
  })
  assert.equal(new Set(result.ids).size, result.ids.length, 'Duplicate HTML ids')
  assert(!result.inlineHandlers && !result.baseOrInlineStyle && !result.unexpectedLinks, 'Unexpected active or embedded content')
  assert(result.headings.every(Boolean), 'Heading without anchor')
  result.ids = new Set(result.ids)
  return result
}

export async function verifySite ({ output, dependencyRoot = repositoryRoot, receipt }) {
  if (!output || !receipt) throw new Error('--output and a new --receipt file are required')
  const directory = path.resolve(output)
  const receiptPath = path.resolve(receipt)
  const receiptRelative = path.relative(directory, receiptPath)
  assert(receiptRelative.startsWith(`..${path.sep}`) || path.isAbsolute(receiptRelative), 'Receipt must be outside the static site')
  const receiptExists = await fs.lstat(receiptPath).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  assert(!receiptExists, 'Receipt already exists; select a new exclusive file')
  const manifestBytes = await fs.readFile(path.join(directory, 'site-manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.sourceRef, sourceRef)
  assert.equal(manifest.articleCount, 28)
  assert.equal(manifest.legacySlugs.length, 30)
  assert.equal(manifest.siteOrigin, siteOrigin)
  assert.equal(new Set(manifest.legacySlugs).size, 30)
  const expectedFiles = [...Object.keys(manifest.files), 'site-manifest.json'].sort()
  assert.deepEqual(await inventory(directory), expectedFiles, 'Unexpected or missing output files')
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert(!name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), `Unsafe manifest filename: ${name}`)
    assert.equal(sha256(await fs.readFile(path.join(directory, ...name.split('/')))), digest, `SHA-256 mismatch: ${name}`)
  }
  for (const [name, digest] of Object.entries(manifest.generatorInputs)) {
    assert(/^docs\/site\/(?:build\.mjs|verify\.mjs|wiki\.css|README\.md)$/.test(name), `Unexpected generator input: ${name}`)
    assert.equal(sha256(await fs.readFile(path.join(repositoryRoot, ...name.split('/')))), digest, `Generator input changed: ${name}`)
  }
  const { module: playwright, version: playwrightVersion } = await loadDependency('playwright', dependencyRoot)
  const chromium = playwright.chromium || playwright.default?.chromium
  assert(chromium, 'Existing Playwright Chromium API is unavailable')
  const failures = []
  let servedRequests = 0
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }
  async function respond (request, response) {
    servedRequests++
    const url = new URL(request.url, 'http://localhost')
    let decoded
    try {
      decoded = decodeURIComponent(url.pathname)
    } catch (error) {
      if (!(error instanceof URIError)) throw error
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid URL')
      return
    }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid path')
      return
    }
    let filename = path.join(directory, ...decoded.split('/').filter(Boolean))
    const relative = path.relative(directory, filename)
    assert(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'HTTP path escape')
    const stat = await fs.stat(filename).then(value => value, error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    })
    if (stat?.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(301, { Location: url.pathname + '/' + url.search }).end()
        return
      }
      filename = path.join(filename, 'index.html')
    } else if (!stat) {
      response.writeHead(404, { 'Content-Type': mime['.html'] }).end(await fs.readFile(path.join(directory, '404.html')))
      return
    }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' })
    response.end(await fs.readFile(filename))
  }
  const server = http.createServer((request, response) => {
    respond(request, response).catch(error => {
      failures.push(error.message)
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Static validation server failed')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const fetched = new Map()
  let requests = 0
  let internalLinks = 0
  let anchors = 0
  let browser
  async function fetchLocal (pathname) {
    assert(pathname.startsWith('/') && !pathname.startsWith('//'), `Nonlocal fetch: ${pathname}`)
    const url = new URL(pathname, origin)
    assert.equal(url.origin, origin, 'Network escape')
    const key = url.pathname + url.search
    if (fetched.has(key)) return fetched.get(key)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })
    requests++
    const bytes = Buffer.from(await response.arrayBuffer())
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const result = { status: response.status, type: response.headers.get('content-type'), text }
    fetched.set(key, result)
    return result
  }
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 } })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        failures.push('Chromium attempted a nonlocal request')
        return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    const html = new Map()
    for (const [route, details] of Object.entries(manifest.routes)) {
      const result = await fetchLocal(route)
      assert.equal(result.status, 200, route)
      assert.match(result.type, /^text\/html;\s*charset=utf-8$/i, route)
      assert(result.text.startsWith('<!doctype html>'), `Not HTML: ${route}`)
      assert(result.text.includes('Документация') && !result.text.includes('\uFFFD'), `UTF-8 text: ${route}`)
      assert(!/(?:C:\\Users\\|S-1-5-21-|https?:\/\/github\.com\/(?:electerm|dstotijn)\/|(?:\d{1,3}\.){3}\d{1,3})/i.test(result.text), `Private/upstream pattern: ${route}`)
      await page.goto(origin + route, { waitUntil: 'load' })
      const parsed = await inspectHtml(page)
      assert.equal(parsed.language, 'ru')
      assert(parsed.charset && parsed.navigation && parsed.headings.length > 0, `Missing structure: ${route}`)
      assert.equal(parsed.scripts, 0)
      assert.deepEqual(parsed.stylesheets, ['/assets/wiki.css'])
      assert.deepEqual(parsed.canonicals, [siteOrigin + canonicalPath(details.page)], `Canonical: ${route}`)
      assert(parsed.viewportFits, `Desktop horizontal overflow: ${route}`)
      html.set(route, parsed)
    }
    for (const slug of manifest.legacySlugs) {
      const route = canonicalPath(slug)
      assert(manifest.routes[route], `Legacy route missing: ${slug}`)
      const response = await fetch(origin + route.slice(0, -1), { redirect: 'manual', signal: AbortSignal.timeout(10000) })
      requests++
      assert.equal(response.status, 301, `Slashless legacy route: ${slug}`)
      assert.equal(response.headers.get('location'), route)
      await response.arrayBuffer()
      const target = manifest.aliases[slug]
      assert(target, `Unmapped legacy slug: ${slug}`)
      assert.deepEqual(html.get(route).headings, html.get(canonicalPath(target)).headings, `Alias content/anchors: ${slug}`)
    }
    for (const [route, parsed] of html) {
      for (const href of parsed.links) {
        if (/^https?:|^mailto:/i.test(href)) {
          if (href.includes('github.com/Anubis-Locker/anubis/blob/')) {
            assert(href.startsWith(sourceBase), `Unpinned source reference: ${href}`)
          }
          continue
        }
        assert(!href.includes('../') && !href.includes('\\'), `Relative link escape: ${href}`)
        const target = new URL(href, origin + route)
        assert.equal(target.origin, origin)
        const result = await fetchLocal(target.pathname + target.search)
        assert.equal(result.status, 200, `Broken internal link: ${href}`)
        internalLinks++
        if (target.hash) {
          const targetHtml = html.get(target.pathname)
          assert(targetHtml?.ids.has(decodeURIComponent(target.hash.slice(1))), `Missing anchor: ${href}`)
          anchors++
        }
      }
      for (const asset of parsed.assets) {
        assert(asset.startsWith('/assets/') && !asset.startsWith('//'), `Nonlocal asset: ${asset}`)
        const result = await fetchLocal(asset)
        assert.equal(result.status, 200)
        assert.match(result.type, /^text\/css;\s*charset=utf-8$/i)
        assert(!/@import|url\s*\(/i.test(result.text), 'CSS must not load external resources')
      }
    }
    const missing = await fetchLocal('/wiki/This-page-does-not-exist/')
    assert.equal(missing.status, 404)
    assert.match(missing.type, /^text\/html;\s*charset=utf-8$/i)
    assert(missing.text.includes('Страница не найдена') && missing.text.includes(canonicalPath('Home')))
    await page.goto(origin + '/wiki/This-page-does-not-exist/', { waitUntil: 'load' })
    assert.equal((await inspectHtml(page)).scripts, 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin + canonicalPath('Installation'), { waitUntil: 'load' })
    assert((await inspectHtml(page)).viewportFits, 'Mobile horizontal overflow')
    const servedManifest = await fetchLocal('/site-manifest.json')
    assert.equal(servedManifest.status, 200)
    assert.match(servedManifest.type, /^application\/json;\s*charset=utf-8$/i)
    assert.equal(sha256(Buffer.from(servedManifest.text, 'utf8')), sha256(manifestBytes))
    assert.deepEqual(failures, [], 'HTTP server failures')
    const result = {
      schemaVersion: 1,
      sourceRef,
      manifestSha256: sha256(manifestBytes),
      outputFilesVerified: expectedFiles.length,
      canonicalArticles: 28,
      legacyRoutes: 30,
      slashlessLegacyRoutes: 30,
      renderedRoutes: html.size,
      fetchRequests: requests,
      httpRequests: servedRequests,
      internalLinksVerified: internalLinks,
      fragmentAnchorsVerified: anchors,
      utf8HtmlAndCss: true,
      localAssetsOnly: true,
      scriptsOrAnalytics: false,
      missingRouteStatus: 404,
      networkScope: 'Temporary loopback HTTP and headless Chromium only; external hyperlinks not fetched',
      playwrightVersion,
      chromiumVersion: browser.version(),
      desktopAndMobileLayout: true,
      errors: []
    }
    await fs.writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' })
    return result
  } finally {
    try {
      if (browser) await browser.close()
    } finally {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2), ['--output', '--dependency-root', '--receipt'])
    console.log(JSON.stringify(await verifySite({
      output: options['--output'],
      dependencyRoot: options['--dependency-root'],
      receipt: options['--receipt']
    }), null, 2))
  } catch (error) {
    console.error(`Wiki validation failed: ${error.message}`)
    process.exitCode = 1
  }
}
