const descriptions = {
  MODEL_API_EMPTY_RESPONSE: '模型 API 未返回有效文本（空响应）',
  MODEL_API_TIMEOUT: '模型 API 请求超时',
  MODEL_API_UPSTREAM_FAILURE: '模型 API 上游服务异常',
  MODEL_API_CAPACITY_OR_RATE_LIMIT: '模型 API 容量不足或请求限流',
  MODEL_API_AUTHENTICATION_FAILED: '模型 API 认证失败，请检查密钥与权限',
  MODEL_API_ACCESS_DENIED: '模型 API 拒绝访问，请检查模型权限',
  MODEL_API_NOT_FOUND: '模型 API 路径或模型不存在',
  MODEL_API_NETWORK_FAILURE: '模型 API 网络连接失败',
  MODEL_API_REQUEST_REJECTED: '模型 API 拒绝了请求',
  MODEL_API_AUTHENTICATION: '模型 API 认证失败，请检查密钥与权限',
  MODEL_API_AUTH_FAILURE: '模型 API 认证失败，请检查密钥与权限',
  OUTPUT_AUDIT_WRITE_FAILED: '模型输出审计记录写入失败，结果未放行',
  MODEL_SCHEMA_FAILURE: '模型未返回唯一有效的JSON对象',
  ENTERPRISE_MODEL_CONTRACT_INVALID: '模型输出未通过结构与引用校验',
  ENTERPRISE_REVIEW_VERDICT_DRIFT: '格式修订改变了原复核裁决，已停止交付并保留前后输出，需重新复核'
}
function failureDetails(error) {
  return { code: error.code || 'RUN_FAILED', message: String(error.message || error).replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/g, '[已隐藏]'), agent_id: error.agent_id || null, agent_label: error.agent_label || null, model_profile: error.model_profile || null, model: error.model || null, transport_diagnostics: Array.isArray(error.transport_diagnostics) ? error.transport_diagnostics.map(({ attempt, timeout_ms, elapsed_ms, phase, headers_ms, http_status, request_id, network_cause_code }) => ({ attempt, timeout_ms, elapsed_ms, phase, headers_ms, http_status, request_id, network_cause_code })) : [], routing_attempts: Array.isArray(error.routing_attempts) ? error.routing_attempts.map(({model_profile,model,code,transport_diagnostics}) => ({model_profile,model,code,transport_diagnostics: Array.isArray(transport_diagnostics) ? transport_diagnostics.map(({attempt,timeout_ms,elapsed_ms,phase,headers_ms,http_status,request_id,network_cause_code}) => ({attempt,timeout_ms,elapsed_ms,phase,headers_ms,http_status,request_id,network_cause_code})) : []})) : [], validation_errors: Array.isArray(error.validation_errors) ? error.validation_errors.slice(0, 8) : [] }
}
function failureMessage(failure) {
  let detail = descriptions[failure.code] || (/model stream contained no text content/.test(failure.message || '') ? descriptions.MODEL_API_EMPTY_RESPONSE : failure.message || '运行异常')
  if (failure.code === 'MODEL_API_TIMEOUT' && failure.transport_diagnostics?.length) {
    const last = failure.transport_diagnostics.at(-1)
    detail += `（${last.phase === 'waiting_headers' ? '等待响应头' : '读取响应正文'}，单次上限${Math.round(last.timeout_ms / 1000)}秒，已尝试${failure.transport_diagnostics.length}次）`
  }
  if (failure.routing_attempts?.length) {
    const requests = failure.routing_attempts.reduce((n, row) => n + row.transport_diagnostics.length, 0)
    detail += `；模型路由尝试${failure.routing_attempts.length}条，累计请求${requests}次`
  }
  if (failure.code === 'ENTERPRISE_MODEL_CONTRACT_INVALID') {
    const errors = failure.validation_errors?.length ? failure.validation_errors.join('；') : String(failure.message || '').replace(/^.*program gate rejected:\s*/, '')
    if (errors) detail += `：${errors.slice(0, 500)}`
  }
  return `${failure.agent_label || failure.agent_id ? `${failure.agent_label || failure.agent_id}：` : ''}${detail}。错误码：${failure.code || 'RUN_FAILED'}${failure.model ? `；模型：${failure.model}` : ''}。`
}
module.exports = { failureDetails, failureMessage }
