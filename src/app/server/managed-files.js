const fs = require('fs')
const os = require('os')
const path = require('path')
const { pipeline } = require('stream')

function createManagedFiles () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-managed-upload-'))
  const upload = require('multer')({
    dest: directory,
    limits: { fileSize: 256 * 1024 * 1024, files: 1, fields: 1 }
  }).single('file')
  const fail = (res, error) => {
    require('../common/log').warn('Managed file operation failed:', error.message)
    if (!res.headersSent) res.status(400).json({ error: error.message })
    else res.destroy(error)
  }
  return {
    download: async (req, res) => {
      try {
        if (typeof req.query.path !== 'string' || !path.isAbsolute(req.query.path)) {
          throw new Error('An absolute file path is required')
        }
        const target = req.query.path
        const stat = await fs.promises.stat(target)
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('Path is not a regular file or directory')
        const name = path.basename(target) + (stat.isDirectory() ? '.tar.gz' : '')
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        res.type(stat.isDirectory() ? 'application/gzip' : 'application/octet-stream')
        const stream = stat.isDirectory()
          ? require('tar').create({ gzip: true, cwd: path.dirname(target) }, [path.basename(target)])
          : fs.createReadStream(target)
        pipeline(stream, res, error => {
          if (error) fail(res, error)
        })
      } catch (error) {
        fail(res, error)
      }
    },
    upload: (req, res) => {
      upload(req, res, async error => {
        try {
          if (error) throw error
          if (typeof req.body.path !== 'string' || !path.isAbsolute(req.body.path) || !req.file) {
            throw new Error('An absolute destination directory and file are required')
          }
          const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
          if (name !== path.basename(name) || name.includes('/') || name.includes('\\') || ['.', '..'].includes(name)) {
            throw new Error('Invalid upload filename')
          }
          const destination = path.join(req.body.path, name)
          await fs.promises.copyFile(req.file.path, destination)
          res.json({ success: true, path: destination })
        } catch (error) {
          fail(res, error)
        } finally {
          if (req.file?.path) {
            fs.promises.unlink(req.file.path).catch(error => require('../common/log').warn('Managed upload cleanup failed:', error.message))
          }
        }
      })
    },
    close: () => fs.rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = { createManagedFiles }
