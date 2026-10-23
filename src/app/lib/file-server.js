const express = require('express')
const path = require('path')

module.exports = (app, assetsPath = path.resolve(__dirname, '../assets')) => {
  app.use((req, res, next) => {
    // Entry filenames can survive a same-version reinstall, but their lazy
    // imports cannot: never persist an older local renderer in HTTP cache.
    res.setHeader('Cache-Control', 'no-store')
    if (req.url.startsWith('/css/_temp_') && req.url.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css')
      res.send('')
      return
    }
    next()
  })

  app.use(express.static(assetsPath, {
    cacheControl: false,
    etag: false,
    lastModified: false
  }))
}
