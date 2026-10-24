import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const sourceRef = 'ac1d0faaab2ae1fa1ed085d9ff462d2b6dea0b11'
export const sourceBase = `https://github.com/Anubis-Locker/anubis/blob/${sourceRef}/`
export const siteOrigin = 'https://docs.anubis.locker'
export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const siteDirectory = fileURLToPath(new URL('.', import.meta.url))

export function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function parseArguments (argv, allowed) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) {
      throw new Error(`Invalid or repeated option: ${key}`)
    }
    options[key] = argv[i + 1]
  }
  return options
}

export async function loadDependency (name, dependencyRoot) {
  const require = createRequire(path.join(path.resolve(dependencyRoot), 'package.json'))
  const entry = require.resolve(name)
  let directory = path.dirname(entry)
  while (true) {
    const candidate = path.join(directory, 'package.json')
    const exists = await fs.stat(candidate).then(() => true, error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) {
      const metadata = JSON.parse(await fs.readFile(candidate, 'utf8'))
      const packageName = name === 'react-dom/server' ? 'react-dom' : name
      if (metadata.name === packageName) {
        return { module: await import(pathToFileURL(entry).href), version: metadata.version }
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Package metadata not found for ${name}`)
    directory = parent
  }
}

function git (...args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { windowsHide: true })
}

export function canonicalPath (page) {
  return `/wiki/${encodeURIComponent(page)}/`
}

function sourceUrl (relativePath) {
  return sourceBase + relativePath.split('/').map(encodeURIComponent).join('/')
}

function readRouteMap (markdown, pages, brandSource) {
  const routes = {}
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line.split('|')
    const target = cells[2]?.match(/\]\(\.\.\/wiki\/([^)]+)\.md\)/)?.[1]
    if (!target || !pages.has(target)) throw new Error(`Invalid route mapping: ${line}`)
    for (const [, slug] of cells[1].matchAll(/`([^`]+)`/g)) {
      if (!/^[A-Za-z0-9_-]+$/.test(slug) || routes[slug]) throw new Error(`Invalid duplicate route: ${slug}`)
      routes[slug] = target
    }
  }
  const brandPages = brandSource.match(/const wikiPages = \{([\s\S]*?)\n\}/)?.[1]
  if (!brandPages) throw new Error('brand.docs.pages source was not found')
  const legacySlugs = [...brandPages.matchAll(/\w+: '([^']+)'/g)].map(match => match[1])
  if (legacySlugs.length !== 30) throw new Error('Expected exactly 30 pinned brand.docs.pages routes')
  for (const slug of legacySlugs) {
    if (!routes[slug]) throw new Error(`Missing legacy route: ${slug}`)
  }
  return { aliases: routes, legacySlugs }
}

function rewriteLink (href, pages) {
  if (href.startsWith('#')) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    const url = new URL(href)
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error(`Unsupported link scheme: ${href}`)
    if (/^https?:\/\/github\.com\/(?:electerm|dstotijn)\//i.test(href)) throw new Error(`Unexpected upstream URL: ${href}`)
    return href
  }
  if (href.startsWith('/') || href.startsWith('\\') || href.includes('\\')) {
    throw new Error(`Unexpected absolute or backslash link: ${href}`)
  }
  const separator = href.search(/[?#]/)
  const pathname = separator === -1 ? href : href.slice(0, separator)
  const suffix = separator === -1 ? '' : href.slice(separator)
  const resolved = path.posix.normalize(path.posix.join('docs/wiki', decodeURIComponent(pathname)))
  if (resolved.startsWith('../') || resolved.startsWith('/')) throw new Error(`Link escapes repository: ${href}`)
  if (resolved.startsWith('docs/wiki/')) {
    const page = path.posix.basename(resolved, '.md')
    if (resolved !== `docs/wiki/${page}.md` || !pages.has(page)) throw new Error(`Missing article: ${href}`)
    return canonicalPath(page) + suffix
  }
  git('cat-file', '-e', `${sourceRef}:${resolved}`)
  return sourceUrl(resolved) + suffix
}

function textContent (node) {
  return node.value || (node.children || []).map(textContent).join('')
}

export async function buildSite ({ output, dependencyRoot = repositoryRoot }) {
  if (!output) throw new Error('An exclusive --output directory is required')
  const destination = path.resolve(output)
  const relativeDestination = path.relative(repositoryRoot, destination)
  if (!relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination)) {
    throw new Error('Output must be outside the source checkout')
  }
  const alreadyExists = await fs.lstat(destination).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (alreadyExists) throw new Error('Output already exists; select a new exclusive directory')
  const parent = await fs.stat(path.dirname(destination))
  if (!parent.isDirectory()) throw new Error('Output parent must already exist')
  const disk = await fs.statfs(path.dirname(destination))
  if (disk.bavail * disk.bsize < 512 * 1024 * 1024 + 32 * 1024 * 1024) {
    throw new Error('Insufficient disk space to preserve the 512 MiB floor')
  }

  const dependencyNames = ['react', 'react-dom/server', 'react-markdown', 'remark-gfm']
  const dependencies = await Promise.all(dependencyNames.map(name => loadDependency(name, dependencyRoot)))
  const React = dependencies[0].module.default
  const { renderToStaticMarkup } = dependencies[1].module
  const Markdown = dependencies[2].module.default
  const remarkGfm = dependencies[3].module.default
  const h = React.createElement
  const inputs = {}
  async function pinnedInput (relativePath) {
    const expected = git('show', `${sourceRef}:${relativePath}`)
    const local = await fs.readFile(path.join(repositoryRoot, ...relativePath.split('/')))
    const normalized = local.toString('utf8').replace(/\r\n/g, '\n')
    if (normalized !== expected.toString('utf8').replace(/\r\n/g, '\n')) {
      throw new Error(`Input differs from public source ${sourceRef}: ${relativePath}`)
    }
    inputs[relativePath] = { gitBytesSha256: sha256(expected), workingBytesSha256: sha256(local) }
    return normalized
  }
  const pinnedNames = git('ls-tree', '-r', '--name-only', sourceRef, '--', 'docs/wiki').toString('utf8').trim().split('\n')
  const pages = new Map()
  let sidebar
  for (const name of pinnedNames) {
    if (!/^docs\/wiki\/[A-Za-z0-9_-]+\.md$/.test(name)) throw new Error(`Unexpected Wiki input: ${name}`)
    const text = await pinnedInput(name)
    if (name.endsWith('/_Sidebar.md')) sidebar = text
    else pages.set(path.posix.basename(name, '.md'), text)
  }
  if (pages.size !== 28 || !sidebar) throw new Error('Expected 28 public articles and _Sidebar')
  const publication = await pinnedInput('docs/community/PUBLICATION.md')
  const brandBytes = git('show', `${sourceRef}:src/common/brand.config.js`)
  inputs['src/common/brand.config.js'] = { gitBytesSha256: sha256(brandBytes) }
  const { aliases, legacySlugs } = readRouteMap(publication, pages, brandBytes.toString('utf8'))
  const css = await fs.readFile(path.join(siteDirectory, 'wiki.css'))
  const outputs = new Map([['assets/wiki.css', css]])
  const routes = new Map()

  function markdown (text, currentPage, navigation = false) {
    const ids = new Map()
    const components = {
      a: ({ node, href, children, ...props }) => h('a', {
        ...props,
        href,
        ...(navigation && href === canonicalPath(currentPage) ? { 'aria-current': 'page' } : {})
      }, children),
      img: () => { throw new Error('Images need an explicitly packaged local asset; remote images are not allowed') }
    }
    for (let level = 1; level <= 6; level++) {
      components[`h${level}`] = ({ node, children }) => {
        const stem = textContent(node).toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section'
        const prefix = navigation ? 'nav-' : ''
        const base = prefix + stem
        const count = ids.get(base) || 0
        ids.set(base, count + 1)
        return h(`h${level}`, { id: count ? `${base}-${count}` : base }, children)
      }
    }
    return renderToStaticMarkup(h(Markdown, {
      remarkPlugins: [remarkGfm],
      skipHtml: true,
      components,
      urlTransform: (url, key) => {
        if (key !== 'href') throw new Error('Only explicitly packaged assets may be embedded')
        return rewriteLink(url, pages)
      }
    }, text))
  }

  function document (page, requestedSlug = page, notFound = false) {
    const text = notFound
      ? '# Страница не найдена\n\nПроверьте адрес или выберите нужную тему в навигации. [Открыть руководство](Home.md).\n'
      : pages.get(page)
    const title = text.match(/^#\s+(.+)$/m)?.[1]
    if (!title) throw new Error(`Article has no title: ${page}`)
    const content = markdown(text, page)
    const navigation = markdown(sidebar, page, true)
    const canonical = siteOrigin + canonicalPath(page)
    return '<!doctype html>\n' + renderToStaticMarkup(h('html', { lang: 'ru' },
      h('head', null,
        h('meta', { charSet: 'utf-8' }),
        h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        h('meta', { name: 'color-scheme', content: 'dark light' }),
        h('title', null, `${title} — Anubis Wiki`),
        !notFound && h('link', { rel: 'canonical', href: canonical }),
        notFound && h('meta', { name: 'robots', content: 'noindex' }),
        h('link', { rel: 'stylesheet', href: '/assets/wiki.css' })
      ),
      h('body', null,
        h('a', { className: 'skip-link', href: '#content' }, 'К содержанию'),
        h('header', { className: 'site-header' },
          h('a', { className: 'brand', href: canonicalPath('Home') }, 'Anubis-Security-Tool'),
          h('span', null, 'Документация'),
          h('a', { href: 'https://github.com/Anubis-Locker/anubis' }, 'GitHub')
        ),
        h('div', { className: 'layout' },
          h('nav', { className: 'sidebar', 'aria-label': 'Разделы руководства', dangerouslySetInnerHTML: { __html: navigation } }),
          h('main', { id: 'content', tabIndex: -1 },
            !notFound && requestedSlug !== page && h('p', { className: 'route-note' },
              'Совместимая ссылка. Основная страница: ',
              h('a', { href: canonicalPath(page) }, title), '.'
            ),
            h('article', { dangerouslySetInnerHTML: { __html: content } }),
            h('footer', null,
              h('p', null, 'Документация не подтверждает установку или живую приёмку нового runtime.'),
              h('a', { href: sourceUrl(`docs/wiki/${notFound ? 'Home' : page}.md`) }, 'Исходник страницы'),
              ' · ',
              h('a', { href: `https://github.com/Anubis-Locker/anubis/tree/${sourceRef}` }, `Публичный срез ${sourceRef.slice(0, 7)}`)
            )
          )
        )
      )
    )) + '\n'
  }

  for (const [page] of pages) {
    const url = canonicalPath(page)
    routes.set(url, { page, kind: 'article' })
    outputs.set(`wiki/${page}/index.html`, document(page))
  }
  for (const [slug, page] of Object.entries(aliases)) {
    if (pages.has(slug) && slug !== page) throw new Error(`Alias shadows another article: ${slug}`)
    if (pages.has(slug)) continue
    routes.set(canonicalPath(slug), { page, kind: 'alias' })
    outputs.set(`wiki/${slug}/index.html`, document(page, slug))
  }
  for (const [filename, url] of [['index.html', '/'], ['wiki/index.html', '/wiki/']]) {
    outputs.set(filename, document('Home'))
    routes.set(url, { page: 'Home', kind: 'index' })
  }
  outputs.set('404.html', document('Home', '404', true))
  const fileHashes = {}
  let bytes = 0
  for (const [name, value] of [...outputs].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    outputs.set(name, buffer)
    fileHashes[name] = sha256(buffer)
    bytes += buffer.length
  }
  if (bytes > 16 * 1024 * 1024) throw new Error('Generated site exceeds its 16 MiB budget')
  const generatorInputs = {}
  for (const name of ['build.mjs', 'verify.mjs', 'wiki.css', 'README.md']) {
    generatorInputs[`docs/site/${name}`] = sha256(await fs.readFile(path.join(siteDirectory, name)))
  }
  const manifest = {
    schemaVersion: 1,
    sourceRef,
    sourceRepository: 'https://github.com/Anubis-Locker/anubis',
    siteOrigin,
    articleCount: pages.size,
    legacySlugs,
    aliases,
    routes: Object.fromEntries([...routes].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    inputs,
    generatorInputs,
    dependencies: Object.fromEntries(dependencyNames.map((name, i) => [name, dependencies[i].version])),
    files: fileHashes,
    bytes,
    manifestHashNote: 'files hashes cover all generated files except this manifest itself'
  }
  outputs.set('site-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
  await fs.mkdir(destination)
  for (const [name, buffer] of outputs) {
    const filename = path.join(destination, ...name.split('/'))
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, buffer, { flag: 'wx' })
  }
  return { articleCount: pages.size, legacyRoutes: legacySlugs.length, generatedFiles: outputs.size, bytes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2), ['--output', '--dependency-root'])
    console.log(JSON.stringify(await buildSite({
      output: options['--output'],
      dependencyRoot: options['--dependency-root']
    }), null, 2))
  } catch (error) {
    console.error(`Wiki build failed: ${error.message}`)
    process.exitCode = 1
  }
}
