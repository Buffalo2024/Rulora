const test = require('node:test')
const assert = require('node:assert/strict')
const {
  IMMUTABLE_MARK,
  buildNativeReportPrompt
} = require('../labs/native-image-report/visual-prompt')

const report = {
  title: '把反馈变成改进依据',
  summary: '人负责判断，数字协作者负责持续追踪。',
  value: ['保留标准'],
  potential: ['沉淀方法'],
  tasks: ['汇总反馈'],
  steps: ['验证流程'],
  plan: ['第1周选样本']
}

test('native image prompt contains the immutable open-source sample mark', () => {
  const prompt = buildNativeReportPrompt({ report, visualStory: 'A' })
  assert.match(prompt, /【共生纪 开源样例】/)
  assert.match(prompt, /不得省略、改写、遮挡、裁切、弱化/)
  assert.equal(IMMUTABLE_MARK, '【共生纪 开源样例】')
})

test('native image prompt rejects incomplete report input', () => {
  assert.throws(() => buildNativeReportPrompt({ report: { title: '不完整' }, visualStory: 'A' }))
})
