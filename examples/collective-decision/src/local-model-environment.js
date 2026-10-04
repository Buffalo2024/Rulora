const fs = require('node:fs')
const path = require('node:path')

const ROLE_IDS = ['CHAIN', 'MONITOR', 'FACTOR', 'REDTEAM', 'CREDIT']
const ALLOWED_KEYS = new Set([...ROLE_IDS.flatMap(role => [
  `NANSHU_${role}_MODEL`,
  `NANSHU_${role}_API_KEY`
]), 'NANSHU_COUNTERCHECK_API_KEY', 'NANSHU_COUNTERCHECK_PRIMARY_MODEL', 'NANSHU_COUNTERCHECK_SECONDARY_MODEL', 'NANSHU_COUNTERCHECK_FALLBACK_MODEL'])

function loadLocalModelEnvironment({ filePath, environment = process.env, root = path.resolve(__dirname, '..') } = {}) {
  const resolved = path.resolve(filePath || environment.NANSHU_ROLE_ENV_FILE || path.join(root, 'config', 'nanshu-roles.local.env'))
  if (!fs.existsSync(resolved)) return { available: false, path: resolved, loaded_keys: [] }
  const parsed = parseRoleEnvironment(fs.readFileSync(resolved, 'utf8'))
  const loaded = []
  for (const [key, value] of Object.entries(parsed)) {
    if (environment[key]) continue
    environment[key] = value
    loaded.push(key)
  }
  return { available: true, path: resolved, loaded_keys: loaded.sort() }
}

function parseRoleEnvironment(content) {
  const values = {}
  for (const [index, rawLine] of String(content).split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match) throw new Error(`invalid local model environment line ${index + 1}`)
    const [, key, rawValue] = match
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unsupported local model environment key ${key}`)
    if (Object.hasOwn(values, key)) throw new Error(`duplicate local model environment key ${key}`)
    values[key] = unquote(rawValue.trim())
  }
  return values
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

module.exports = { ALLOWED_KEYS, loadLocalModelEnvironment, parseRoleEnvironment }
