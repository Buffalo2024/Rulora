const fs = require('node:fs')

function typeSafeApiKey({ environment = process.env, readFile = fs.readFileSync } = {}) {
  const direct = String(environment.TYPESAFE_API_KEY || '').trim()
  if (direct) return direct
  const filePath = String(environment.TYPESAFE_API_KEY_FILE || '/run/secrets/typesafe-jev.env').trim()
  if (!filePath) return ''
  try {
    const contents = readFile(filePath, 'utf8')
    const line = String(contents).split(/\r?\n/).find(item => /^TYPESAFE_API_KEY=/.test(item.trim()))
    return line ? line.trim().slice('TYPESAFE_API_KEY='.length).trim() : ''
  } catch { return '' }
}

module.exports = { typeSafeApiKey }
