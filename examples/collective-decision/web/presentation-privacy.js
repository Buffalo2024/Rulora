'use strict'

;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RuloraPresentationPrivacy = api
})(typeof globalThis === 'object' ? globalThis : this, function createModule() {
  const MODE_KEY = 'rulora.presentationPrivacy.enabled.v1'
  const REGISTRY_KEY = 'rulora.presentationPrivacy.aliases.v1'

  function createController({ storage = null } = {}) {
    let enabled = readBoolean(storage, MODE_KEY, true)
    let registry = readRegistry(storage)
    const companies = new Map()
    const jobs = new Map()

    function setEnabled(value) {
      enabled = value === true
      write(storage, MODE_KEY, enabled ? 'true' : 'false')
      return enabled
    }

    function registerCompanies(records = []) {
      for (const record of [...records].sort((a, b) => String(a.company_id).localeCompare(String(b.company_id)))) {
        const id = String(record.company_id || '').trim()
        if (!id) continue
        companies.set(id, collectCompanyIdentity(record))
        ensureAlias(id)
      }
      persistRegistry()
    }

    function registerJobs(records = []) {
      for (const record of records) {
        registerCompanies([record])
        if (!record?.company_id) continue
        for (const field of ['job_id', 'run_id', 'task_id']) {
          if (record[field]) jobs.set(String(record[field]), String(record.company_id))
        }
      }
    }

    function ensureAlias(companyId) {
      const id = String(companyId || '').trim()
      if (!id) return '演示企业'
      if (!registry.aliases[id]) {
        const used = new Set(Object.values(registry.aliases))
        let index = Math.max(0, Number(registry.next_index) || 0)
        let alias = aliasForIndex(index)
        while (used.has(alias)) alias = aliasForIndex(++index)
        registry.aliases[id] = alias
        registry.next_index = index + 1
      }
      return registry.aliases[id]
    }

    function companyAlias(companyId) {
      const id = String(companyId || '').trim()
      if (/^\d+$/.test(id)) return `演示企业 ${Number(id)}`
      return ensureAlias(id)
    }

    function companyLabel(record) {
      if (!enabled) return [record?.company_id, record?.company_name].filter(Boolean).join(' · ')
      return companyAlias(record?.company_id)
    }

    function sanitizeText(value) {
      const original = String(value ?? '')
      if (!enabled || !original) return original
      let output = original

      const identities = [...companies.entries()].sort((left, right) => longestToken(right[1]) - longestToken(left[1]))
      for (const [companyId, identity] of identities) {
        const alias = companyAlias(companyId)
        for (const token of identity.tokens) output = replaceLiteral(output, token, alias)
        output = output.replace(new RegExp(`${escapeRegExp(companyId)}\\s*[·|｜]\\s*${escapeRegExp(alias)}`, 'g'), alias)
        output = output.replace(new RegExp(`(company[_ -]?id|企业编号|企业代码)(\\s*[:=：]\\s*)${escapeRegExp(companyId)}\\b`, 'gi'), `$1$2${alias}`)
        output = output.replace(new RegExp(`(企业|公司)(\\s*)${escapeRegExp(companyId)}\\b`, 'g'), `$1$2${alias}`)
      }

      for (const [jobId, companyId] of jobs) output = replaceLiteral(output, jobId, `演示任务-${companyAlias(companyId).replace('演示企业 ', '')}`)

      output = output
        .replace(/((?:统一社会信用代码|社会信用代码|信用代码)\s*[:：=]?\s*)[0-9A-Z]{18}\b/gi, '$1[已隐藏]')
        .replace(/\b[0-9A-Z]{18}\b/g, '[统一社会信用代码已隐藏]')
        .replace(/((?:股票|证券|上市)代码\s*[:：=]?\s*)\d{6}\b/g, '$1[已隐藏]')
        .replace(/(?:\/Users|\/private|\/var|\/tmp)\/[^\s\]）)>,，。；;]+/g, '[本地路径已隐藏]')
        .replace(/https?:\/\/[^\s\]）)>,，。；;]+/g, url => containsCompanyIdentity(url) ? '[企业相关链接已隐藏]' : url)

      return output
    }

    function containsCompanyIdentity(value) {
      const text = decodeURIComponentSafely(String(value)).toLowerCase()
      for (const [companyId, identity] of companies) {
        if (text.includes(companyId.toLowerCase())) return true
        if (identity.tokens.some(token => text.includes(String(token).toLowerCase()))) return true
      }
      return false
    }

    function visibleSearchText(record) {
      if (!enabled) return `${record?.company_id || ''} ${record?.company_name || ''} ${record?.industry || ''}`
      return `${companyAlias(record?.company_id)} ${record?.industry || ''}`
    }

    function modeState() {
      return { enabled, label: enabled ? '演示脱敏模式' : '路演脱敏' }
    }

    function persistRegistry() { write(storage, REGISTRY_KEY, JSON.stringify(registry)) }

    return { setEnabled, registerCompanies, registerJobs, companyAlias, companyLabel, sanitizeText, visibleSearchText, modeState }
  }

  function collectCompanyIdentity(record) {
    const candidateFields = [
      'company_name', 'company_short_name', 'short_name', 'stock_code', 'securities_code',
      'ticker', 'unified_social_credit_code', 'credit_code'
    ]
    const tokens = new Set()
    for (const field of candidateFields) {
      const value = String(record?.[field] || '').trim()
      if (value) tokens.add(value)
    }
    const fullName = String(record?.company_name || '').trim()
    const shortName = fullName.replace(/股份有限公司|集团有限公司|有限责任公司|有限公司/g, '').trim()
    if (shortName.length >= 3) tokens.add(shortName)
    return { tokens: [...tokens].sort((a, b) => b.length - a.length) }
  }

  function aliasForIndex(index) {
    let value = Math.max(0, Number(index) || 0)
    let suffix = ''
    do {
      suffix = String.fromCharCode(65 + (value % 26)) + suffix
      value = Math.floor(value / 26) - 1
    } while (value >= 0)
    return `演示企业 ${suffix}`
  }

  function longestToken(identity) { return Math.max(0, ...identity.tokens.map(token => token.length)) }
  function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  function replaceLiteral(text, token, replacement) { return token ? text.replace(new RegExp(escapeRegExp(token), 'gi'), replacement) : text }
  function decodeURIComponentSafely(value) { try { return decodeURIComponent(value) } catch { return value } }
  function readBoolean(storage, key, fallback = false) {
    try {
      const value = storage?.getItem(key)
      return value === null || value === undefined ? fallback : value === 'true'
    } catch { return fallback }
  }
  function readRegistry(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(REGISTRY_KEY) || '{}')
      return { aliases: parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {}, next_index: Number(parsed.next_index) || 0 }
    } catch { return { aliases: {}, next_index: 0 } }
  }
  function write(storage, key, value) { try { storage?.setItem(key, value) } catch {} }

  return { MODE_KEY, REGISTRY_KEY, aliasForIndex, createController }
})
