const { cp } = require('shelljs')
const { resolve, relative, sep } = require('path')
const { readFileSync, writeFileSync, existsSync } = require('fs')
const { resolveBrandResDir } = require('../../common/brand-res')

cp('-r', 'src/build/electron-builder.json', './')

// electron-builder.json refers to the brand resource package as `@brand-res`;
// substitute the folder resolved from BRAND_RES_DIR / ../resource /
// node_modules/@ai-security-tool/resource (relative to the repo root)
const resDir = resolveBrandResDir(process.cwd())
const template = readFileSync(resolve(process.cwd(), 'src/build/electron-builder.json'), 'utf8')
const resourcePaths = [...template.matchAll(/"@brand-res\/([^"]+)"/g)].map(match => match[1])
for (const resource of resourcePaths) {
  if (!existsSync(resolve(resDir, resource))) {
    throw new Error(`Brand package is missing ${resource}; update @ai-security-tool/resource or rebuild BRAND_RES_DIR`)
  }
}
const rel = relative(process.cwd(), resDir).split(sep).join('/') || '.'
const pth = resolve(process.cwd(), 'electron-builder.json')
writeFileSync(
  pth,
  readFileSync(pth, 'utf8').split('@brand-res').join(rel)
)
console.log('brand resource dir:', resDir)
