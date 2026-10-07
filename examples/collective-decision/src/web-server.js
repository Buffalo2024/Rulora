#!/usr/bin/env node
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { companyTemplateCsv, MAXIMUM_IMPORT_BYTES } = require('./company-import')
const { loadLocalModelEnvironment } = require('./local-model-environment')
const { verifySmokeReceipt } = require('./model-readiness')
const { ProviderHealthMonitor } = require('./provider-health-monitor')
const { mergeProfile } = require('./providers/multi-model-provider')
const { projectRoot } = require('./rulora-loader')
const { readJson } = require('./utils')
const { WebJobManager } = require('./web-job-manager')

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
})

async function createWebServer({ root = projectRoot(), manager = null, privacyPassword = process.env.RULORA_PRIVACY_PASSWORD } = {}) {
  const resolvedRoot = path.resolve(root)
  const jobManager = manager || new WebJobManager({ root: resolvedRoot })
  await jobManager.initialize()
  const staticRoot = path.join(resolvedRoot, 'web')
  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response)
    try {
      const url = new URL(request.url, 'http://localhost')
      if (url.pathname.startsWith('/api/')) {
        await handleApi({ request, response, url, manager: jobManager, root: resolvedRoot, privacyPassword })
        return
      }
      await serveStatic({ response, pathname: url.pathname, staticRoot })
    } catch (error) {
      if (response.headersSent) return response.end()
      const storageFull = ['ENOSPC', 'EDQUOT'].includes(error.code)
      sendJson(response, storageFull ? 507 : error.statusCode || 500, {
        error: storageFull ? '服务器存储空间不足，任务或记录未能保存。请恢复可用空间后重试。' : error.statusCode ? error.message : '本地服务发生错误。',
        code: error.code || 'WEB_SERVER_ERROR'
      })
      if (!error.statusCode) console.error(error.stack || error.message)
    }
  })
  return { server, manager: jobManager }
}

async function handleApi({ request, response, url, manager, root, privacyPassword }) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method === 'POST' && url.pathname === '/api/privacy/unlock') {
    if (!privacyPassword) {
      sendJson(response, 503, { error: '未配置 RULORA_PRIVACY_PASSWORD，展示脱敏保持开启。' })
      return
    }
    const body = await readJsonBody(request, 1024)
    const supplied = crypto.createHash('sha256').update(String(body.password || '')).digest()
    const expected = crypto.createHash('sha256').update(privacyPassword).digest()
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      const error = new Error('密码错误，脱敏模式保持开启。')
      error.statusCode = 401
      throw error
    }
    sendJson(response, 200, { unlocked: true })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/companies') {
    sendJson(response, 200, { companies: manager.listCompanies() })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/companies/template') {
    const bytes = Buffer.from(companyTemplateCsv())
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': bytes.length,
      'Content-Disposition': 'attachment; filename="company-import-template.csv"'
    })
    response.end(bytes)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/companies/import') {
    const body = await readJsonBody(request, Math.ceil(MAXIMUM_IMPORT_BYTES * 1.5))
    sendJson(response, 200, { result: await manager.importCompanies(body) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/agents') {
    sendJson(response, 200, { agents: manager.listAgents() })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/sources') {
    sendJson(response, 200, { sources: manager.sourceSettings() })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/sources') {
    const body = await readJsonBody(request, 65536)
    sendJson(response, 200, { sources: await manager.updateSourceSettings(body) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(response, 200, { jobs: manager.listJobs() })
    return
  }
  if (url.pathname.startsWith('/api/reception/')) { sendJson(response, 410, { error: '接待入口已移除，请勾选企业后启动固定任务。' }); return }
  const commandMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/command$/)
  if (request.method === 'POST' && commandMatch) {
    sendJson(response, 200, await manager.runtimeCommand(commandMatch[1], await readJsonBody(request)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    const error = new Error('旧版单任务入口已存档。请从企业选择区的批量进件接口启动固定分析任务。')
    error.statusCode = 410
    throw error
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs/batch') {
    const body = await readJsonBody(request)
    sendJson(response, 202, { batch: await manager.createBatch(body) })
    return
  }
  const actionResolutionMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/action-resolution$/)
  if (request.method === 'POST' && actionResolutionMatch) {
    const body = await readJsonBody(request)
    sendJson(response, 202, { job: await manager.resolveActionDisagreement(actionResolutionMatch[1], body) })
    return
  }
  const supplementMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/supplement$/)
  if (request.method === 'POST' && supplementMatch) {
    const body = await readJsonBody(request)
    sendJson(response, 202, { job: await manager.supplementEnterpriseJob(supplementMatch[1], body) })
    return
  }
  const enterpriseFeedbackMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/feedback$/)
  if (request.method === 'POST' && enterpriseFeedbackMatch) {
    const body = await readJsonBody(request)
    sendJson(response, 200, { job: await manager.recordEnterpriseFeedback(enterpriseFeedbackMatch[1], body) })
    return
  }
  const closeEnterpriseMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/close$/)
  if (request.method === 'POST' && closeEnterpriseMatch) {
    const body = await readJsonBody(request)
    sendJson(response, 200, { job: await manager.closeEnterpriseJob(closeEnterpriseMatch[1], body) })
    return
  }
  const approvalMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/approval$/)
  if (request.method === 'POST' && approvalMatch) {
    const body = await readJsonBody(request)
    sendJson(response, 200, { job: await manager.decideEnterpriseApproval(approvalMatch[1], body) })
    return
  }
  const resumeMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/resume$/)
  if (request.method === 'POST' && resumeMatch) {
    sendJson(response, 202, { job: await manager.resumeJob(resumeMatch[1]) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/system') {
    sendJson(response, 200, { system: manager.systemSnapshot(), providers: await providerSnapshot(root) })
    return
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)$/)
  if (request.method === 'GET' && jobMatch) {
    sendJson(response, 200, { job: await manager.getJob(jobMatch[1]) })
    return
  }
  const logMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/logs$/)
  if (request.method === 'GET' && logMatch) {
    sendJson(response, 200, await manager.getLogs(logMatch[1]))
    return
  }
  const artifactMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)\/artifacts\/(run|report|markdown|submission|manifest)$/)
  if (request.method === 'GET' && artifactMatch) {
    await serveArtifact(response, await manager.getArtifact(artifactMatch[1], artifactMatch[2]))
    return
  }
  const error = new Error('接口不存在。')
  error.statusCode = 404
  throw error
}

async function providerSnapshot(root) {
  try {
    loadLocalModelEnvironment({ root })
    const [execution, modelConfig] = await Promise.all([
      readJson(path.join(root, 'config', 'execution.json')),
      readJson(path.resolve(process.env.AGENT_MODEL_CONFIG || path.join(root, 'config', 'model-profiles.local.json')))
    ])
    const monitor = new ProviderHealthMonitor({ root, config: execution.provider_connectivity })
    const healthStates = await monitor.status()
    const healthByProfile = new Map(healthStates.map(profile => [profile.profile_id, profile]))
    const profiles = Object.entries(modelConfig.profiles || {}).filter(([,configured]) => require('./enterprise-model-routing').profileActive(configured, process.env)).map(([profileId, configured]) => {
      const profile = mergeProfile(modelConfig.defaults, configured)
      const model = (profile.model_env && process.env[profile.model_env]) || profile.model || null
      const baseUrl = (profile.base_url_env && process.env[profile.base_url_env]) || profile.base_url || null
      const keyReady = profile.api_key_optional === true || Boolean(profile.api_key_env && process.env[profile.api_key_env])
      const health = healthByProfile.get(profileId)
      return {
        profile_id: profileId,
        model,
        configured: Boolean(model && baseUrl && keyReady),
        status: health?.status || 'unknown',
        consecutive_failed_calls: health?.consecutive_failed_calls || 0,
        last_failure_category: health?.last_failure_category || null,
        last_failure_at: health?.last_failure_at || null,
        last_success_at: health?.last_success_at || null,
        alert_active: health?.alert_active === true
      }
    })
    const configurationReady = profiles.length > 0 && profiles.every(profile => profile.configured)
    const transportHealthy = profiles.every(profile => profile.alert_active !== true && profile.status !== 'alert')
    const readiness = verifySmokeReceipt({
      root,
      config: modelConfig,
      maxAgeHours: execution.model_smoke_max_age_hours || 24
    })
    return {
      healthy: configurationReady && transportHealthy,
      configuration_ready: configurationReady,
      live_ready: readiness.live_ready === true,
      readiness_reason: readiness.reason || null,
      checked_at: readiness.checked_at || null,
      expires_at: readiness.expires_at || null,
      profiles
    }
  } catch (error) {
    return { healthy: false, configuration_ready: false, live_ready: false, profiles: [], error: error.message }
  }
}

async function serveStatic({ response, pathname, staticRoot }) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const allowedFiles = ['index.html', 'app.js', 'presentation-privacy.js', 'styles.css']
  if (!allowedFiles.includes(relative)) {
    response.statusCode = 404
    response.end('Not found')
    return
  }
  const filePath = path.join(staticRoot, relative)
  const bytes = await fs.readFile(filePath)
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-cache'
  })
  response.end(bytes)
}

async function serveArtifact(response, filePath) {
  const bytes = await fs.readFile(filePath)
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Disposition': `inline; filename="${path.basename(filePath).replaceAll('"', '')}"`
  })
  response.end(bytes)
}

async function readJsonBody(request, maximumBytes = 32768) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) {
      const error = new Error(`请求内容不能超过${Math.ceil(maximumBytes / 1024)}KB。`)
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    const error = new Error('请求必须是有效JSON。')
    error.statusCode = 400
    throw error
  }
}

function sendJson(response, statusCode, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length })
  response.end(bytes)
}

function setSecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
}

async function main() {
  await require('./search-bridge').startSearchBridge(process.env.RULORA_SEARCH_PROXY_UPSTREAM)
  const host = process.env.RISK_AGENTS_WEB_HOST || '127.0.0.1'
  const port = Number(process.env.RISK_AGENTS_WEB_PORT || 4317)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('RISK_AGENTS_WEB_PORT must be a valid port')
  const { server } = await createWebServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}`
  console.log(`Rulora多Agent本地控制台已启动：${url}`)
  console.log('仅监听本机；按 Ctrl-C 停止服务。')
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})

module.exports = { createWebServer, providerSnapshot, readJsonBody }
