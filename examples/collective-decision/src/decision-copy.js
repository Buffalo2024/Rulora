function cleanText(value) { return String(value || '').replace(/[。；;][\s]*[；;]/g, '；').replace(/；[\s]*。/g, '。').replace(/([。；，！？])\1+/g, '$1').trim() }
function cleanItems(items) { return [...new Set((items || []).map(x => cleanText(x).replace(/[。；;\s]+$/g, '')).filter(Boolean))] }
function formatAssistance(gaps) {
  return '分析暂未通过交付审核，详细原因见运行结果。\n可补充影响判断的规则或经验，或输入“从断点继续”；无需继续时输入“关闭任务”。'

}
module.exports = { cleanText, cleanItems, formatAssistance }
