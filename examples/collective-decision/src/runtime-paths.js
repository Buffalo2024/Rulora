const path = require('node:path')
const { projectRoot } = require('./rulora-loader')

// Defaults retain compatibility. Relative configuration is anchored to code,
// never to the shell's working directory. Explicit absolute paths remain valid.
function resolveDataRoot(root = projectRoot(), configured = process.env.RULORA_DATA_ROOT) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  return path.resolve(root, value || '.runtime')
}
function dataPath(root, ...segments) { return path.join(resolveDataRoot(root), ...segments) }
function resolveRuntimePath(root, value) {
  if (path.isAbsolute(value)) return path.normalize(value)
  const normalized = String(value).replace(/\\/g, '/')
  if (normalized === '.runtime') return resolveDataRoot(root)
  if (normalized.startsWith('.runtime/')) return path.resolve(resolveDataRoot(root), normalized.slice(9))
  return path.resolve(root, value)
}
module.exports = { resolveDataRoot, dataPath, resolveRuntimePath }
