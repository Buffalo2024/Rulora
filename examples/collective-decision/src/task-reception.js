const { loadProvider } = require('./provider-loader')

const RECEPTION_AGENT = { agent_id: 'task_receptionist', model_profile: 'monitor_extractor', label: '决策任务接待员' }

async function extractTask(rawTask, { providerLoader = loadProvider } = {}) {
  const task = String(rawTask || '').trim().slice(0, 4000)
  if (!task) throw Object.assign(new Error('请先输入要决策的任务。'), { statusCode: 400 })
  let extracted = null
  let extractionStatus = 'unavailable'
  try {
    const { provider } = await providerLoader()
    if (typeof provider.callForJson === 'function') {
      const value = await provider.callForJson({
        agent: RECEPTION_AGENT,
        operation: 'taskReception',
        prompt: [{ role: 'system', content: '你是决策任务接待员。只提炼任务，不回答任务，不补造时间、比较基准、规则或事实。' }, { role: 'user', content: task }],
        outputInstruction: '只返回JSON对象，字段为question。用一句清楚的话保留用户要作出的决策，不补造时间、基准、规则或事实。'
      })
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        extracted = value
        extractionStatus = 'completed'
      }
    }
  } catch { /* Missing or unavailable LLM leaves the draft editable. */ }
  const question = { question: safeText(extracted?.question) || task }
  const missing = []
  return { raw_task: task, question, missing, extraction_status: extractionStatus }
}

function safeText(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : '' }

module.exports = { extractTask }
