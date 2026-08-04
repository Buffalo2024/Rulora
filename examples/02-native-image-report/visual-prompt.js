const IMMUTABLE_MARK = '【共生纪 开源样例】'

function buildNativeReportPrompt({ report, visualStory }) {
  assertReport(report)
  if (!['A', 'B'].includes(visualStory)) throw new Error('visualStory must be A or B')

  const narrative = visualStory === 'A'
    ? 'A版叙事：突出人的判断如何被数字协作者持续放大。'
    : 'B版叙事：突出人与数字协作者如何形成可复用的工作系统。'

  return `
你是一名信息设计师与中文报告插画师。请直接生成一张完整、带中文文字的竖版报告图，
不是先画背景再机械填字。根据内容原生安排人物、图标、场景、留白与文字，使读者第一眼
理解报告在解决什么问题。

【输出规格】
- 竖版信息报告，宽高比约 9:16；自上而下阅读。
- 统一使用清晰的现代中文字体；正文粗细一致，只有标题和核心结论允许加粗。
- 插画服务于信息，不遮挡文字；不得把全部插画集中在顶部。
- 五个板块在同一视觉世界中自然衔接，避免网页卡片拼装感。
- ${narrative}

【必须原样出现的固定文字】
- Rulora · Hybird 开源案例
- 1 你们合起来的价值
- 2 你在 AI 时代的潜力
- 3 建议数字协作者主要做什么
- 4 建议的实现步骤
- 5 第一个 30 天
- ${IMMUTABLE_MARK}

【动态报告内容】
标题：${report.title}
总结词：${report.summary}
合作价值：${report.value.join('；')}
未来潜力：${report.potential.join('；')}
主要任务：${report.tasks.join('；')}
实现步骤：${report.steps.join('；')}
30天计划：${report.plan.join('；')}

【不可删除标记契约】
“${IMMUTABLE_MARK}”必须完整、清晰、逐字正确地出现在成图底部安全区，字号不小于正文，
与背景保持高对比。它是开源案例标记，不是动态文案；不得省略、改写、遮挡、裁切、弱化，
也不得在后续局部编辑中删除。若版面冲突，应移动其他元素，不能移动或删除该标记。

【禁止】
- 不生成产品品牌、模型名称、价格、二维码或联系方式。
- 不增加报告没有提供的人格结论或能力评价。
- 不用大面积边框把每段文字割裂成卡片。
- 不输出错别字、乱码、伪英文或不可辨认的小字。
`.trim()
}

function assertReport(report) {
  if (!report || typeof report !== 'object') throw new Error('report is required')
  for (const key of ['title', 'summary']) {
    if (typeof report[key] !== 'string' || !report[key].trim()) throw new Error(`${key} is required`)
  }
  for (const key of ['value', 'potential', 'tasks', 'steps', 'plan']) {
    if (!Array.isArray(report[key]) || report[key].length === 0) throw new Error(`${key} must be a non-empty array`)
  }
}

module.exports = { IMMUTABLE_MARK, buildNativeReportPrompt }
