class SourceFetchError extends Error {
  constructor(message, { code = 'SOURCE_FETCH_FAILED', status = null, retriable = false, url = null } = {}) {
    super(message)
    this.name = 'SourceFetchError'
    this.code = code
    this.status = status
    this.retriable = retriable
    this.url = url
  }
}

class PublicHttpClient {
  constructor({
    fetchImpl = globalThis.fetch,
    userAgent = 'RuloraPublicEvidenceMonitor/0.1 (+public-information-only)',
    timeoutMs = 30000,
    maxBytes = 25 * 1024 * 1024,
    minimumIntervalMs = 350
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable; Node.js 20+ is required')
    this.fetch = fetchImpl
    this.userAgent = userAgent
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.minimumIntervalMs = minimumIntervalMs
    this.lastRequestAt = new Map()
  }

  async json(url, options = {}) {
    const response = await this.request(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.headers || {}) }
    })
    const text = await response.text()
    if (looksLikeSiteControl(text, response.headers.get('content-type'))) {
      throw new SourceFetchError('site returned a WAF, CAPTCHA, or human-verification page', {
        code: 'SITE_CONTROL_BLOCKED',
        status: response.status,
        retriable: false,
        url: response.url
      })
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new SourceFetchError(`source did not return JSON: ${error.message}`, {
        code: 'INVALID_SOURCE_RESPONSE',
        status: response.status,
        url: response.url
      })
    }
  }

  async text(url, options = {}) {
    const response = await this.request(url, options)
    const text = await response.text()
    if (looksLikeSiteControl(text, response.headers.get('content-type'))) {
      throw new SourceFetchError('site returned a WAF, CAPTCHA, or human-verification page', {
        code: 'SITE_CONTROL_BLOCKED',
        status: response.status,
        retriable: false,
        url: response.url
      })
    }
    return { text, response }
  }

  async bytes(url, options = {}) {
    const response = await this.request(url, options)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > (options.maxBytes || this.maxBytes)) {
      throw new SourceFetchError(`source content length ${length} exceeds limit`, {
        code: 'SOURCE_TOO_LARGE',
        status: response.status,
        url: response.url
      })
    }
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > (options.maxBytes || this.maxBytes)) {
      throw new SourceFetchError(`source content ${arrayBuffer.byteLength} exceeds limit`, {
        code: 'SOURCE_TOO_LARGE',
        status: response.status,
        url: response.url
      })
    }
    return { bytes: new Uint8Array(arrayBuffer), response }
  }

  async request(url, options = {}) {
    let parsed = validatePublicUrl(url, options.allowLocalhost === true, options.allowedHosts, options.httpAllowedHosts)
    const timeoutMs = Number(options.timeoutMs || this.timeoutMs)
    const maxRetries = Number(options.maxRetries ?? 2)
    const {
      allowLocalhost,
      maxBytes,
      maxRetries: ignoredMaxRetries,
      minimumIntervalMs,
      timeoutMs: ignoredTimeoutMs,
      allowedHosts,
      httpAllowedHosts,
      maximumRedirects = 5,
      ...fetchOptions
    } = options
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        let response
        let requestUrl = parsed
        for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
          await validateResolvedPublicUrl(requestUrl, allowLocalhost === true)
          await this.rateLimit(requestUrl.host, Number(minimumIntervalMs ?? this.minimumIntervalMs))
          this.lastRequestAt.set(requestUrl.host, Date.now())
          response = await this.fetch(requestUrl, {
            ...fetchOptions,
            redirect: 'manual',
            headers: { 'user-agent': this.userAgent, ...(fetchOptions.headers || {}) },
            signal: controller.signal
          })
          if (![301, 302, 303, 307, 308].includes(response.status)) break
          if (redirectCount === maximumRedirects) throw new SourceFetchError('public source exceeded redirect limit', { code: 'UNSAFE_REDIRECT', url: requestUrl.href })
          const location = response.headers.get('location')
          if (!location) throw new SourceFetchError('public source redirect lacks Location', { code: 'UNSAFE_REDIRECT', url: requestUrl.href })
          requestUrl = validatePublicUrl(new URL(location, requestUrl), allowLocalhost === true, allowedHosts, httpAllowedHosts)
        }
        if (response.ok) return response
        const body = await response.text()
        const retriable = [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)
        const error = new SourceFetchError(`source HTTP ${response.status}: ${body.slice(0, 500)}`, {
          code: response.status === 429 ? 'RATE_LIMITED' : 'SOURCE_HTTP_ERROR',
          status: response.status,
          retriable,
          url: parsed.href
        })
        if (!retriable || attempt === maxRetries) throw error
        lastError = error
        const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000
        await delay(Math.max(retryAfter, Math.min(1000 * (2 ** attempt), 10000)))
      } catch (error) {
        lastError = error
        if (error instanceof SourceFetchError) {
          if (!error.retriable || attempt === maxRetries) throw error
        } else if (attempt === maxRetries || (error.name !== 'AbortError' && !isTransientNetworkError(error))) {
          throw new SourceFetchError(error.message, {
            code: error.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR',
            retriable: error.name === 'AbortError' || isTransientNetworkError(error),
            url: parsed.href
          })
        }
        await delay(Math.min(1000 * (2 ** attempt), 10000))
      } finally {
        clearTimeout(timeout)
      }
    }
    throw lastError
  }

  async rateLimit(host, intervalMs) {
    const elapsed = Date.now() - (this.lastRequestAt.get(host) || 0)
    if (elapsed < intervalMs) await delay(intervalMs - elapsed)
  }
}

function validatePublicUrl(value, allowLocalhost = false, allowedHosts = null, httpAllowedHosts = []) {
  const url = new URL(value)
  if (url.username || url.password) throw new SourceFetchError('source URLs with embedded credentials are not allowed', { code: 'UNSAFE_SOURCE_URL', url: url.href })
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowLocalhost || httpAllowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))))) {
    throw new SourceFetchError('public sources require HTTPS unless HTTP is explicitly enabled for this host', { code: 'UNSAFE_SOURCE_URL', url: url.href })
  }
  if (!allowLocalhost && (url.hostname.toLowerCase() === 'localhost' || isPrivateAddress(url.hostname))) {
    throw new SourceFetchError('local/private source URLs are not public evidence', { code: 'UNSAFE_SOURCE_URL', url: url.href })
  }
  if (allowedHosts?.length && !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new SourceFetchError('source URL host is outside the adapter allowlist', { code: 'UNSAFE_SOURCE_URL', url: url.href })
  }
  return url
}

async function validateResolvedPublicUrl(url, allowLocalhost = false) {
  if (allowLocalhost) return true
  if (net.isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new SourceFetchError('source IP is private or reserved', { code: 'UNSAFE_SOURCE_URL', url: url.href })
    return true
  }
  let addresses
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }) } catch (error) {
    throw new SourceFetchError(`source DNS resolution failed: ${error.message}`, { code: 'SOURCE_DNS_FAILED', retriable: true, url: url.href })
  }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new SourceFetchError('source DNS resolved to a private or reserved address', { code: 'UNSAFE_SOURCE_URL', url: url.href })
  }
  return true
}

function isPrivateAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (net.isIPv4(normalized)) {
    const [a, b, c] = normalized.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113)
  }
  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateAddress(mapped[1]) : false
  }
  return false
}

function looksLikeSiteControl(text, contentType = '') {
  if (!/html/i.test(contentType || '') && !/^\s*<!doctype html/i.test(text)) return false
  return /WEB 应用防火墙|人机识别|滑动填充拼图|captcha|访问请求进行人机/i.test(text)
}

function isTransientNetworkError(error) {
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message || ''))
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

module.exports = { PublicHttpClient, SourceFetchError, isPrivateAddress, looksLikeSiteControl, validatePublicUrl, validateResolvedPublicUrl }
const dns = require('node:dns/promises')
const net = require('node:net')
