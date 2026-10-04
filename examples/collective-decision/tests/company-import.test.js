const test = require('node:test')
const assert = require('node:assert/strict')
const { assignCompanyIds, normalizeImportedRecords } = require('../src/company-import')

test('company import requires the four business fields used by intake', () => {
  const complete = normalizeImportedRecords([{
    company_name: '测试企业',
    taxpayer_id: '91440000123456789X',
    industry: '电子设备制造',
    business_scope: '电子设备研发、生产与销售'
  }], { allowMissingCompanyId: true })
  assert.equal(complete[0].taxpayer_id, '91440000123456789X')
  assert.throws(() => normalizeImportedRecords([{
    company_name: '缺少经营范围企业', taxpayer_id: 'TAX-1', industry: '制造业'
  }], { allowMissingCompanyId: true }), /缺少经营范围/)
})

test('company import assigns the next free number after demo companies 1 through 25', () => {
  const records = normalizeImportedRecords([{
    company_name: '新导入企业',
    taxpayer_id: '91440000999999999X',
    industry: '软件和信息技术服务',
    business_scope: '软件开发与信息系统集成'
  }], { allowMissingCompanyId: true })
  const existing = Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(3, '0'))
  assert.equal(assignCompanyIds(records, existing)[0].company_id, '026')
})
