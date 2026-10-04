const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
function browserFixture(job) {
  const nodes = new Map()
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: '', innerHTML: '', textContent: '', scrollHeight: 0 }); return nodes.get(selector) }
  const calls = []
  const context = {
    window: { RuloraPresentationPrivacy: { createController: () => ({ maskText: x => String(x), enabled: false }) }, localStorage: { setItem() {} } },
    document: { addEventListener() {}, querySelector: node },
    console
  }
  vm.runInNewContext(`${source}\nglobalThis.testState = state; globalThis.send = submitWorkspaceCommand; globalThis.result = job => renderResultContent(job, document.querySelector('#result-content')); displayText = x => String(x ?? ''); displayHtml = x => escapeHtml(String(x ?? '')); api = async (url, body) => { globalThis.calls.push({url, body}); return {job: {runtime_messages: []}} }; selectJob = async () => {};`, context)
  context.calls = calls
  context.testState.selectedJob = job
  return { context, node, calls }
}

test('dialogue cannot create or confirm a task before a runtime job is selected', async () => {
  const { context, node, calls } = browserFixture(null)
  node('#workspace-command').value = '确认，开始分析'
  await context.send({ preventDefault() {} })
  assert.equal(calls.length, 0)
  assert.ok(context.testState.conversationRecords.at(-1).message.includes('企业选择区'))
})

test('runtime dialogue sends only the selected job command endpoint', async () => {
  const { context, node, calls } = browserFixture({ job_id: 'job-1', decision_mode: 'enterprise_decision_v2' })
  node('#workspace-command').value = '当前状态'
  await context.send({ preventDefault() {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/jobs/job-1/command')
  assert.equal(JSON.parse(calls[0].body.body).message, '当前状态')
})

test('v1 historical report keeps its original meaning while v2 renders action details safely', () => {
  const { context, node } = browserFixture(null)
  context.result({ decision_mode: 'enterprise_decision_v1', status: 'approved', result: { report: { 方向: 1, 行动条件: -1, 理由: '历史' } } })
  assert.match(node('#result-content').innerHTML, /积极/)
  assert.match(node('#result-content').innerHTML, /不满足/)
  context.result({ decision_mode: 'enterprise_decision_v2', status: 'approved', result: { report: { 方向: 1, 决策建议: [{ 编号: 3, 建议: '强化回款与现金管理', action: '<script>alert(1)</script>', target: '甲公司', time_range: '未来12个月', scope: 'overall', readiness: 'conditional', prerequisites: ['核实账龄'], direction_relation: '支持拓展', evidence_refs: ['E1'] }], 理由: '依据' } } })
  const html = node('#result-content').innerHTML
  assert.match(html, /拓展/)
  assert.match(html, /核实账龄/)
  assert.ok(!html.includes('<script>'))
})

test('historical empty API response displays its actual cause in dialogue', () => {
  const { context } = browserFixture(null)
  const text = vm.runInNewContext(`friendlyFailureMessage({code:'RUN_FAILED',message:'model stream contained no text content'})`, context)
  assert.match(text, /空响应/)
  assert.match(text, /RUN_FAILED/)
})

test('assistance dialogue links to results without repeating detailed gaps', () => {
  const {context}=browserFixture(null)
  const html=vm.runInNewContext(`renderMessageBody({kind:'assistance',gaps:['缺口一。；','<script>x</script>','三','四','五','六']})`,context)
  assert.match(html,/href="#result-content"/)
  assert.ok(!html.includes('缺口一'))
  assert.ok(!html.includes('<script>'))
  assert.match(html,/从断点继续/)
})

test('new action result distinguishes explicit13, unresolved10, malformed empty and historical empty',()=>{
 const metadata={action_options_version:'3.0.0-object-boundaries'}
 const show=(actions,meta=metadata)=>{
  const {context,node}=browserFixture(null)
  context.result({job_id:'test',decision_mode:'enterprise_decision_v2',status:'approved',result:{report:{方向:1,理由:'核验记录',决策建议:actions},metadata:meta}})
  return node('#result-content').innerHTML
 }
 const none=show([{编号:13,建议:'无需新增措施',无需新增原因:'已有安排足够',已有安排:[{arrangement:'继续已批准项目',evidence_refs:['E1']}],方向关系:'支持拓展'}])
 assert(none.includes('13 · 无需新增措施'));assert(none.includes('继续已批准项目'));assert(none.includes('E1'));assert(!none.includes('需先核实条件'))
 const unable=show([{编号:10,建议:'无建议',无法建议原因:'重大冲突'}])
 assert(unable.includes('无法提出可靠建议'));assert(!unable.includes('已有安排经复核'))
 assert(show([]).includes('不能视为无需新增措施'))
 assert(show([],{}).includes('历史版本记录'))
 const split=show([{编号:11,建议:'调整战略重点与业务组合',action:'重新定位市场',prerequisites:[],scope:'partial',readiness:'ready',evidence_refs:['E1'],direction_relation:'支持拓展'}])
 assert(split.includes('11 · 调整战略重点与业务组合'));assert(split.includes('重新定位市场'))
})
