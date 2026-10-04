const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSourceRegistry, verifyEvidenceSnapshots } = require('./evidence-registry')
const { canonicalJson, isCalendarDate, isHttpsUrl, readJson, sha256, writeJsonAtomic } = require('./utils')

class ManualAssistanceService {
  constructor({
    root = path.resolve(__dirname, '..'),
    runtimeDirectory,
    snapshotDirectory,
    configPath,
    sourceConfigPath,
    notifier = defaultNotifier,
    now = () => new Date()
  } = {}) {
    this.root = path.resolve(root)
    this.runtimeDirectory = path.resolve(runtimeDirectory || path.join(this.root, '.runtime', 'manual-assistance'))
    this.requestsDirectory = path.join(this.runtimeDirectory, 'requests')
    this.templatesDirectory = path.join(this.runtimeDirectory, 'response-templates')
    this.snapshotDirectory = path.resolve(snapshotDirectory || path.join(this.root, '.runtime', 'evidence-snapshots'))
    this.configPath = path.resolve(configPath || path.join(this.root, 'config', 'manual-source-assistance.json'))
    this.sourceConfigPath = path.resolve(sourceConfigPath || path.join(this.root, 'config', 'public-sources.json'))
    this.notifier = notifier
    this.now = now
  }

  async resolveOrRequest({ collectionRequestId, company, query, asOfDate, reason = 'manual_source_access_required' }) {
    const [assistanceConfig, sourceConfig] = await Promise.all([readJson(this.configPath), readJson(this.sourceConfigPath)])
    const manualSource = (assistanceConfig.sources || []).find(item => item.source_id === query.source_id)
    if (!assistanceConfig.enabled || !manualSource) return null
    const source = buildSourceRegistry(sourceConfig).get(query.source_id)
    if (!source) throw new Error(`manual source ${query.source_id} is not registered in public-sources.json`)
    const fingerprint = sha256(canonicalJson({ collectionRequestId, company_id: company.id, query, asOfDate }))
    const assistanceId = `assist-${fingerprint.slice(0, 24)}`
    const requestPath = path.join(this.requestsDirectory, `${assistanceId}.json`)
    const responseTemplatePath = path.join(this.templatesDirectory, `${assistanceId}.response.json`)
    const existing = await readJsonIfExists(requestPath)
    if (existing) {
      if (existing.query_fingerprint !== fingerprint) throw new Error(`manual assistance fingerprint collision: ${assistanceId}`)
      if (['evidence_validated', 'analysis_resumed'].includes(existing.status) && existing.evidence) {
        const errors = await verifyEvidenceSnapshots([existing.evidence], { snapshotRoot: this.snapshotDirectory, productionMode: true })
        if (errors.length) throw new Error(`manual evidence restore rejected: ${errors.join('; ')}`)
        if (existing.status !== 'analysis_resumed') {
          existing.status = 'analysis_resumed'
          existing.events.push({ state: 'analysis_resumed', at: this.now().toISOString() })
          existing.updated_at = this.now().toISOString()
          await writeJsonAtomic(requestPath, existing)
        }
        return { status: 'ready', evidence: existing.evidence, request: existing, request_path: requestPath, response_template_path: responseTemplatePath }
      }
      return { status: 'pending', request: existing, request_path: requestPath, response_template_path: responseTemplatePath }
    }
    const timestamp = this.now().toISOString()
    const request = {
      contract_version: '1.0.0',
      assistance_id: assistanceId,
      query_fingerprint: fingerprint,
      collection_request_id: collectionRequestId,
      company: structuredClone(company),
      source_id: query.source_id,
      source_label: source.label,
      source_url: source.base_url,
      access_mode: manualSource.mode,
      data_category: manualSource.data_category,
      as_of_date: asOfDate,
      query: structuredClone(query),
      reason,
      status: 'awaiting_user_action',
      public_information_only: true,
      instructions: [
        '在自己的已登录浏览器中完成一次公开查询；若出现验证码，由用户本人输入。',
        '将公开结果页保存为 PDF/HTML/图片，或下载网站允许导出的原始文件。',
        `填写响应元数据：${responseTemplatePath}`,
        `执行：node src/cli.js assist-import --id ${assistanceId} --file 原始文件 --metadata ${responseTemplatePath}`,
        '重新执行原 collect/run 命令；系统会校验并从该断点继续。'
      ],
      allowed_assistance: assistanceConfig.allowed_assistance,
      forbidden: assistanceConfig.forbidden,
      created_at: timestamp,
      updated_at: timestamp,
      events: [{ state: 'awaiting_user_action', at: timestamp }]
    }
    const template = {
      contract_version: '1.0.0',
      assistance_id: assistanceId,
      source_id: query.source_id,
      source_url: source.base_url,
      target_entity: company.name,
      query_terms: normalizedQueryTerms(query),
      title: '',
      summary: '',
      publisher: source.label,
      published_at: '',
      statistical_period: null,
      retrieved_at: timestamp,
      immutable_publication: false,
      public: true
    }
    await Promise.all([writeJsonAtomic(requestPath, request), writeJsonAtomic(responseTemplatePath, template)])
    request.notification_delivery = await deliverNotification(this.notifier, { request, requestPath, responseTemplatePath }, this.now)
    request.events.push({ state: 'desktop_notification_delivery', at: this.now().toISOString(), ...request.notification_delivery })
    request.updated_at = this.now().toISOString()
    await writeJsonAtomic(requestPath, request)
    return { status: 'pending', request, request_path: requestPath, response_template_path: responseTemplatePath }
  }

  async list({ status } = {}) {
    await fs.mkdir(this.requestsDirectory, { recursive: true })
    const names = (await fs.readdir(this.requestsDirectory)).filter(name => name.endsWith('.json')).sort()
    const values = await Promise.all(names.map(name => readJson(path.join(this.requestsDirectory, name))))
    return status ? values.filter(item => item.status === status) : values
  }

  async get(assistanceId) {
    validateAssistanceId(assistanceId)
    const requestPath = path.join(this.requestsDirectory, `${assistanceId}.json`)
    const value = await readJsonIfExists(requestPath)
    if (!value) throw new Error(`manual assistance request not found: ${assistanceId}`)
    return { request: value, request_path: requestPath, response_template_path: path.join(this.templatesDirectory, `${assistanceId}.response.json`) }
  }

  async notify(assistanceId) {
    const { request, request_path: requestPath, response_template_path: responseTemplatePath } = await this.get(assistanceId)
    const delivery = await deliverNotification(this.notifier, { request, requestPath, responseTemplatePath }, this.now)
    request.notification_delivery = delivery
    request.events.push({ state: 'desktop_notification_delivery', at: this.now().toISOString(), ...delivery })
    request.updated_at = this.now().toISOString()
    await writeJsonAtomic(requestPath, request)
    return { assistance_id: assistanceId, notification_delivery: delivery, request_path: requestPath }
  }

  async importEvidence({ assistanceId, filePath, metadataPath }) {
    const { request, request_path: requestPath } = await this.get(assistanceId)
    const [metadata, sourceConfig] = await Promise.all([readJson(path.resolve(metadataPath)), readJson(this.sourceConfigPath)])
    const source = buildSourceRegistry(sourceConfig).get(request.source_id)
    validateManualMetadata({ metadata, request, source })
    const resolvedFile = path.resolve(filePath)
    const stat = await fs.stat(resolvedFile)
    if (!stat.isFile() || stat.size <= 0) throw new Error('manual evidence file must be a non-empty regular file')
    if (stat.size > 25 * 1024 * 1024) throw new Error('manual evidence file exceeds the 25 MiB MVP limit')
    const bytes = await fs.readFile(resolvedFile)
    const digest = sha256(bytes)
    await fs.mkdir(this.snapshotDirectory, { recursive: true })
    const snapshotRef = `${digest}.bin`
    const snapshotPath = path.join(this.snapshotDirectory, snapshotRef)
    try {
      const existing = await fs.readFile(snapshotPath)
      if (sha256(existing) !== digest) throw new Error('content-addressed snapshot collision')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const temporary = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, bytes)
      await fs.rename(temporary, snapshotPath)
    }
    const evidence = {
      id: `manual-${request.source_id}-${digest.slice(0, 16)}`,
      source_id: request.source_id,
      source_type: source.source_type,
      publisher: String(metadata.publisher).trim(),
      source_url: metadata.source_url,
      title: String(metadata.title).trim(),
      summary: String(metadata.summary).trim(),
      published_at: metadata.published_at,
      retrieved_at: metadata.retrieved_at,
      evidence_grade: source.default_grade,
      content_sha256: digest,
      snapshot_ref: snapshotRef,
      immutable_publication: metadata.immutable_publication === true,
      publication_time_basis: metadata.publication_time_basis || null,
      immutable_proof_url: metadata.immutable_proof_url || null,
      immutable_proof_snapshot_ref: metadata.immutable_proof_snapshot_ref || null,
      public: true,
      ingestion_mode: 'validated_manual_import',
      target_entity: String(metadata.target_entity).trim(),
      query_terms: metadata.query_terms.map(value => String(value).trim()).filter(Boolean),
      statistical_period: metadata.statistical_period || null,
      manual_assistance_id: assistanceId,
      original_filename: path.basename(resolvedFile)
    }
    const snapshotErrors = await verifyEvidenceSnapshots([evidence], { snapshotRoot: this.snapshotDirectory, productionMode: true })
    if (snapshotErrors.length) throw new Error(`manual evidence snapshot rejected: ${snapshotErrors.join('; ')}`)
    const timestamp = this.now().toISOString()
    request.status = 'evidence_validated'
    request.evidence = evidence
    request.import = { metadata_path: path.resolve(metadataPath), original_file: resolvedFile, imported_at: timestamp }
    request.events.push({ state: 'result_saved_or_exported', at: timestamp }, { state: 'snapshot_hashed', at: timestamp, content_sha256: digest }, { state: 'evidence_validated', at: timestamp })
    request.updated_at = timestamp
    await writeJsonAtomic(requestPath, request)
    return { assistance_id: assistanceId, status: request.status, evidence, snapshot_path: snapshotPath, request_path: requestPath }
  }
}

function validateManualMetadata({ metadata, request, source }) {
  if (!source || source.manual_import_enabled !== true) throw new Error(`manual source ${request.source_id} is not enabled for validated manual ingestion`)
  if (metadata.contract_version !== '1.0.0') throw new Error('manual response contract_version must be 1.0.0')
  if (metadata.assistance_id !== request.assistance_id || metadata.source_id !== request.source_id) throw new Error('manual response does not match assistance request')
  if (metadata.public !== true) throw new Error('manual evidence must be explicitly marked public')
  if (!isHttpsUrl(metadata.source_url)) throw new Error('manual evidence source_url must use HTTPS')
  const hostname = new URL(metadata.source_url).hostname.toLowerCase()
  const allowedHosts = new Set(source.allowed_hosts || [])
  if (allowedHosts.size && ![...allowedHosts].some(host => hostname === host || hostname.endsWith(`.${host}`))) throw new Error('manual evidence URL host is outside source registry')
  if (!isCalendarDate(metadata.published_at)) throw new Error('manual evidence published_at must be a real YYYY-MM-DD date')
  if (metadata.published_at > request.as_of_date) throw new Error('manual evidence is future information after as_of_date')
  if (!/^\d{4}-\d{2}-\d{2}T/.test(metadata.retrieved_at || '') || Number.isNaN(Date.parse(metadata.retrieved_at))) throw new Error('manual evidence retrieved_at must be an ISO timestamp')
  for (const key of ['target_entity', 'title', 'summary', 'publisher']) if (!String(metadata[key] || '').trim()) throw new Error(`manual response ${key} is required`)
  if (!Array.isArray(metadata.query_terms) || metadata.query_terms.length === 0) throw new Error('manual response query_terms must be a non-empty array')
}

function normalizedQueryTerms(query) {
  const values = [query.keyword, query.query, ...(query.keywords || [])].flat().filter(Boolean)
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
}

async function readJsonIfExists(filePath) {
  try { return await readJson(filePath) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function validateAssistanceId(value) {
  if (!/^assist-[a-f0-9]{24}$/.test(String(value || ''))) throw new Error('invalid manual assistance id')
}

function defaultNotifier({ request, requestPath }) {
  if (process.platform !== 'darwin') return { attempted: false, delivered: false, reason: 'desktop_notification_only_supported_on_macos' }
  if (process.env.RULORA_DISABLE_DESKTOP_NOTIFICATION === '1') return { attempted: false, delivered: false, reason: 'desktop_notification_disabled_by_environment' }
  const message = escapeAppleScript(`需要人工公开数据协助：${request.source_label} / ${request.company.name}。待办：${requestPath}`)
  const title = escapeAppleScript('Rulora 公开数据待办')
  const result = spawnSync('/usr/bin/osascript', ['-e', `display notification "${message}" with title "${title}"`], { timeout: 5000, encoding: 'utf8' })
  return {
    attempted: true,
    delivered: result.status === 0 && !result.error,
    ...(result.status === 0 && !result.error ? {} : { reason: result.error?.code || `osascript_exit_${result.status}` })
  }
}

async function deliverNotification(notifier, payload, now) {
  try {
    const result = await Promise.resolve(notifier(payload))
    return result && typeof result === 'object'
      ? { attempted: result.attempted === true, delivered: result.delivered === true, reason: result.reason || null }
      : { attempted: true, delivered: true, reason: null }
  } catch (error) {
    return { attempted: true, delivered: false, reason: String(error.code || error.message || 'notification_failed').slice(0, 200) }
  }
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

module.exports = { ManualAssistanceService, defaultNotifier, validateManualMetadata }
