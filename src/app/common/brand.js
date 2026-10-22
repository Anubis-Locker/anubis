/**
 * main-process access to the brand config.
 * In the source tree the config lives in src/common; prepare.js copies it to
 * work/app/common/brand.config.js, which is the fallback used when packaged.
 */
let brand
try {
  brand = require('../../common/brand.config')
} catch (e) {
  brand = require('./brand.config')
}

module.exports = brand
