const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : typeof value === 'string' ? value : JSON.stringify(value)
  return crypto.createHash('sha256').update(input).digest('hex')
}

function safeId(value) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`unsafe id: ${normalized}`)
  return normalized
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function softmax(scores) {
  const maximum = Math.max(...scores)
  const exponents = scores.map(score => Math.exp(score - maximum))
  const total = exponents.reduce((sum, value) => sum + value, 0)
  return exponents.map(value => value / total)
}

function round(value, digits = 6) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function isCalendarDate(value) {
  const text = String(value || '')
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:'
  } catch {
    return false
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

module.exports = { canonicalJson, clamp, isCalendarDate, isHttpsUrl, nowId, readJson, round, safeId, sha256, softmax, writeJsonAtomic }
