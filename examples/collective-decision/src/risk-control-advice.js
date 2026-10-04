const decisionConfig = require('../config/decision.json')

const RISK_CONTROL_ADVICE_DEFINITION_VERSION = 'competition-risk-control-advice-1.0.0'

// These descriptions are a display-only transcription of the competition
// explainer. The decision code remains the sole business and submission value.
const DESCRIPTION_BY_CODE = Object.freeze({
  '1': '提高融资利率或费率，通过价格机制补偿风险溢价',
  '2': '根据风险信号及时下调客户信用等级，触发相应风险应对机制',
  '3': '提升企业在我行销售回款比例，加强监控现金流并锁定还款来源',
  '4': '停止新增融资，暂停可用额度或降低经营上限，控制风险敞口规模',
  '5': '要求补充抵押品或置换更优质担保物，提升担保覆盖率',
  '6': '追加实控人、股东自然人连带担保或引入第三方保证人，强化还款保障',
  '7': '债务人额外移交动产或权利凭证给银行占有，作为债权的补充担保',
  '8': '压缩融资期限，加快资金回收节奏，降低时间风险',
  '9': '宣布贷款提前到期，要求借款人立即偿还全部本息'
})

const configuredTitles = decisionConfig.risk_control_advice || {}
const configuredCodes = Object.keys(configuredTitles).sort()
const describedCodes = Object.keys(DESCRIPTION_BY_CODE).sort()

if (configuredCodes.join(',') !== describedCodes.join(',')) {
  throw new Error('risk-control advice detail catalog does not exactly cover configured advice codes')
}

const RISK_CONTROL_ADVICE_CATALOG = Object.freeze(Object.fromEntries(configuredCodes.map(code => [code, Object.freeze({
  code,
  title: configuredTitles[code],
  description: DESCRIPTION_BY_CODE[code]
})])))

function describeRiskControlAdvice(codes) {
  if (!Array.isArray(codes)) throw new TypeError('risk-control advice codes must be an array')
  const seen = new Set()
  return codes.map(rawCode => {
    const code = String(rawCode).trim()
    if (!RISK_CONTROL_ADVICE_CATALOG[code]) throw new Error(`unknown risk-control advice code: ${code}`)
    if (seen.has(code)) throw new Error(`duplicate risk-control advice code: ${code}`)
    seen.add(code)
    return { ...RISK_CONTROL_ADVICE_CATALOG[code] }
  })
}

module.exports = {
  RISK_CONTROL_ADVICE_CATALOG,
  RISK_CONTROL_ADVICE_DEFINITION_VERSION,
  describeRiskControlAdvice
}
