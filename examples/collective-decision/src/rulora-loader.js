const path = require('node:path')

const LOCAL_RULORA_PATH = process.env.RULORA_LOCAL_PATH || path.resolve(__dirname, '..', '..', '..')

function loadRulora() {
  const candidates = [
    process.env.RULORA_CORE_PATH,
    '@rulora/core',
    LOCAL_RULORA_PATH
  ].filter(Boolean)
  const errors = []
  for (const candidate of candidates) {
    try {
      return { core: require(candidate), source: candidate }
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`)
    }
  }
  throw new Error(`Unable to load Rulora Core. Install @rulora/core or set RULORA_CORE_PATH. ${errors.join(' | ')}`)
}

function projectRoot() {
  return path.resolve(__dirname, '..')
}

module.exports = { LOCAL_RULORA_PATH, loadRulora, projectRoot }
