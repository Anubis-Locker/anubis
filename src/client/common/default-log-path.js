import { brand } from './constants'
import { osResolve } from './resolve'

export default function () {
  return window.et.sessionLogPath || osResolve(window.store.appPath, brand.data.dirName, 'session_logs')
}
