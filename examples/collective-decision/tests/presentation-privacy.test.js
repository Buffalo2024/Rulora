const assert = require('node:assert/strict')
const test = require('node:test')
const { createController } = require('../web/presentation-privacy')

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }
}

const companies = [
  { company_id: '001', company_name: '示例科技股份有限公司', short_name: '示例科技', stock_code: '600001', unified_social_credit_code: '91440000123456789X', industry: '制造业' },
  { company_id: '002', company_name: '样本制造有限公司', industry: '电子制造业' }
]

test('presentation privacy defaults on and never mutates source records', () => {
  const storage = memoryStorage()
  const controller = createController({ storage })
  const original = structuredClone(companies)
  controller.registerCompanies(companies)
  assert.equal(controller.modeState().enabled, true)
  assert.equal(controller.companyLabel(companies[0]), '演示企业 1')
  assert.deepEqual(companies, original)
})

test('presentation privacy remembers an authorized off state and can reopen without a password', () => {
  const storage = memoryStorage()
  const first = createController({ storage })
  first.setEnabled(false)
  assert.equal(createController({ storage }).modeState().enabled, false)
  first.setEnabled(true)
  assert.equal(createController({ storage }).modeState().enabled, true)
})

test('presentation privacy keeps stable aliases across refresh controllers', () => {
  const storage = memoryStorage()
  const first = createController({ storage })
  first.registerCompanies(companies)
  first.setEnabled(true)
  assert.equal(first.companyLabel(companies[0]), '演示企业 1')
  const refreshed = createController({ storage })
  refreshed.registerCompanies([...companies].reverse())
  assert.equal(refreshed.modeState().enabled, true)
  assert.equal(refreshed.companyLabel(companies[0]), '演示企业 1')
  assert.equal(refreshed.companyLabel(companies[1]), '演示企业 2')
})

test('presentation privacy sanitizes identity tokens before display', () => {
  const storage = memoryStorage()
  const controller = createController({ storage })
  controller.registerCompanies(companies)
  controller.registerJobs([{ ...companies[0], job_id: 'web-001-sensitive', run_id: 'contest-001-sensitive' }])
  controller.setEnabled(true)
  const visible = controller.sanitizeText('web-001-sensitive 示例科技股份有限公司 股票代码：600001 信用代码：91440000123456789X ' + '/' + 'Users/demo/示例科技/report.json')
  assert.doesNotMatch(visible, /示例科技|600001|91440000123456789X|\/Users/)
  assert.match(visible, /演示企业 1/)
  assert.match(visible, /演示任务-1/)
  assert.match(visible, /已隐藏/)
  assert.equal(controller.sanitizeText('contest-001-sensitive'), '演示任务-1')
})

test('privacy search surface excludes raw name and id while enabled', () => {
  const controller = createController({ storage: memoryStorage() })
  controller.registerCompanies(companies)
  controller.setEnabled(true)
  assert.equal(controller.visibleSearchText(companies[0]), '演示企业 1 制造业')
})
