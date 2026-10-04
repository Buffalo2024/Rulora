const { canonicalJson } = require('./utils')
const MODE = 'enterprise_decision_v2'
const FIXED_TASK = '企业产业链风险及决策分析'
// Shared business definitions are interpreted by models, never by a prose gate.
const DIRECTION_POLICY = Object.freeze({
  boundary: '以当前可核验经营状态为基准，判断未来12个月企业整体拟采取的方向。拓展=主动增加经营规模或市场覆盖；维持=保持整体规模与风险承诺，可优化结构及进行局部增量；收缩=主动减少整体投入或风险暴露。说明变化对象、整体或局部范围及主要边界；局部机会不自动等于整体拓展，分阶段或有前提也不自动等于维持。',
  evidence: '区分已发生的经营改善、未来机会和待验证条件。未知内部数据可以限制判断信心或执行范围，不能单独推出维持或收缩；不因谨慎措辞、机会数量或缺口数量偏好某方向。条件成立后才扩大承诺时，明确现在建议启动的动作与以后触发的动作。',
  comparison: '在自己的reason或seat_summary中说明关键取舍；收到异议时在review_summary回应对方实际限定的方案，不将审慎拓展替换成无约束扩张再反驳。比较行动风险与不行动的机会成本，有数据才量化，无数据用标明假设的情景和触发条件，不编造概率、金额或内部阈值。'
})
const ACTION_OPTIONS_VERSION = '3.0.0-object-boundaries'
const NO_ADVICE_CODE = 10
const NO_NEW_MEASURES_CODE = 13
const ACTIONS = Object.freeze([
  [1, '调整定价与交易条件', '改变报价、折扣、合同条款、结算方式及交易信用条件；存量催收归3，独立周期改变归8。'],
  [2, '调整既有任务优先级与资源配置', '对已承接订单、已批准项目及既有经营任务排序，调整人员、产线和交付能力；改变先做什么、资源给谁。战略重定位归11，投入速度与强度归12，新增投资承诺归4。'],
  [3, '强化回款与现金管理', '管理存量应收回收、争议款、现金预算和付款统筹；融资负债结构归7，交易规则归1。'],
  [4, '调整新增投资承诺与准入条件', '对尚未形成承诺的新项目、并购、新产能及重大投资，决定是否承诺、承诺多少及放行条件，可增加、限制或暂缓。按承诺是否形成区分，不按是否开工区分；已承诺项目的投入节奏归12。'],
  [5, '优化经营资产配置', '调配、共享、出租、出售或盘活既有经营资产；业务或项目终止归9，融资目的安排归7。'],
  [6, '引入合作与风险分担', '通过合作、外包、联合开发或保险改变履约方式或风险承担主体，明确责任；普通采购和另一措施的执行步骤不自动独立列项。'],
  [7, '调整融资与负债结构', '改变融资来源、债务期限、融资成本、偿债安排及杠杆结构；不替代存量回款和日常付款管理，不断言未知融资能力。'],
  [8, '调整经营与承诺周期', '改变合同锁定期、采购、交付或库存持有周期，合理时可缩短或延长；不替代投入分期、存量催收或债务期限安排，不机械压缩必要备料。'],
  [9, '终止或退出相关业务、项目', '结束明确范围的业务、项目或市场，或实施具有退出性质的剥离；暂缓或降速不是退出，相关存量节奏归12、新增承诺归4。'],
  [10, '无建议', '重大冲突或关键判断无法成立，当前无法形成可靠行动建议；独占，说明阻断缺口，不表示无需行动。'],
  [11, '调整战略重点与业务组合', '改变未来重点市场、产品定位、业务组合和拟进入领域；日常既有任务排序归2，具体退出执行归9。'],
  [12, '调整存量项目推进节奏与经营投入', '改变已启动或已承诺项目的里程碑、推进速度、分期支出及日常经营投入强度；新增承诺归4，单纯任务排序归2，终止归9。'],
  [13, '无需新增措施', '已有可核验安排足以支持冻结经营方向，无需新增措施；三种方向均可，独占，须提供已有安排和证据并通过专项复核；不是空输出或无法判断。']
].map(([id, label, meaning]) => Object.freeze({ id, label, meaning })))
const ACTUAL_ACTION_CODES = Object.freeze(ACTIONS.map(a=>a.id).filter(id=>![NO_ADVICE_CODE,NO_NEW_MEASURES_CODE].includes(id)))
const isActualAction = id => ACTUAL_ACTION_CODES.includes(id)
const isNoNewMeasures = codes => Array.isArray(codes) && codes.length===1 && codes[0]===NO_NEW_MEASURES_CODE
const OBJECT_BOUNDARIES = Object.freeze({
  2: {decision_object:'existing_tasks',commitment_status:'existing'},
  4: {decision_object:'new_investment',commitment_status:'uncommitted'},
  11: {decision_object:'strategy',commitment_status:'not_applicable'},
  12: {decision_object:'ongoing_investment',commitment_status:'existing'}
})
const ACTION_RELATION_POLICY = Object.freeze({
  classification:'先提出必要具体动作，再按实际改变的主要决策归一个代码，不遍历选项、不把旧2/4机械拆成四项。2=既有任务排序；4=未形成承诺的投资；11=未来战略；12=存量项目和经营支出节奏。decision_object和commitment_status由模型明确判断，不由程序从文字推断。',
  boundaries:'重点核对2/11、2/12、4/12、4/5、5/9、9/11、1/3、1/8、3/7、4/8、8/12及合作与其他动作的关系。同一实际动作归主要代码；只有两个独立操作才分列。对同一对象说明执行A后B仍须完成什么，反向亦然。概念、代码不同或覆盖更广均不证明独立。',
  conflicts:'检查同对象、同期间终止与继续投入、资源重复承诺和互相排斥的执行要求；退出必需支出或不同阶段须说明。程序不按代码配对判冲突，由模型声明单项及整体组合是否相容。',
  direction:'拓展、维持、收缩均可包含任何实际代码。局部退出可服务总体拓展，核心必要投入可服务总体收缩；须明确范围和抵消安排。不仅逐项检查，还检查整个组合是否违背冻结总体方向，不能每项写局部就绕过整体判断。',
  no_new_measures:'recommendations禁止空数组；[13]表示已有安排足够，须有no_action_basis:{existing_arrangements:[{arrangement,evidence_refs}],why_sufficient,direction_relation}，gaps为空；[10]表示无法可靠建议。13与10均独占，不生成actions或label_assessments。不以资料查不到支持13，也不要求为避免13而编造行动。'
})
const ACTION_FIELD_ENUMS = Object.freeze({
  scope:['overall','partial'],effect:['increase','maintain','decrease','pause','exit','reallocate','protect'],
  readiness:['ready','conditional'],decision_object:['existing_tasks','new_investment','strategy','ongoing_investment','other'],
  commitment_status:['existing','uncommitted','not_applicable']
})
const ACTION_LABELS = Object.fromEntries(ACTIONS.map(x => [x.id, x.label]))
const LABELS = { direction: { 1: '拓展', 0: '维持', '-1': '收缩' } }
function fixedQuestion(subject) {
  return { question: FIXED_TASK, subject, matter: '目标企业自身的产业链风险与经营决策', time_range: '未来12个月', baseline: '截至证据日期可核验的当前经营状态', scope: '目标企业整体经营' }
}
function candidateKey(stage) { return stage === 'direction' ? 'direction' : 'recommendations' }
function candidateSignature(value, stage) {
  if (stage === 'direction') return String(value.direction)
  // A set of codes alone must not collapse opposing plans into agreement.
  return canonicalJson({ no_action_basis: value.no_action_basis ?? null, recommendations: [...(value.recommendations || [])].sort((a,b) => a-b), actions: (value.actions || []).map(a => ({ id: a.id, target: a.target, scope: a.scope, time_range: a.time_range, effect: a.effect, readiness: a.readiness })).sort((a,b) => a.id-b.id) })
}
function validateActions(value, evidenceIds, prior) {
  const errors = []
  const codes = value.recommendations
  if (!Array.isArray(codes) || !codes.length || codes.some(x => !Number.isInteger(x) || !ACTIONS.some(a=>a.id===x))) return ['recommendations必须是1至13的非空整数数组；无需新增措施用[13]，不得以空数组或缺失字段替代判断']
  if (new Set(codes).size !== codes.length) errors.push('建议编号不能重复')
  if (codes.includes(10) && codes.length !== 1) errors.push('无建议必须独占')
  if (codes.includes(NO_NEW_MEASURES_CODE) && !isNoNewMeasures(codes)) errors.push('无需新增措施必须独占')
  if (isNoNewMeasures(codes)) errors.push(...validateNoActionBasis(value, evidenceIds, prior))
  else if (value.no_action_basis != null) errors.push('仅[13]允许no_action_basis')
  if (!Array.isArray(value.actions)) return [...errors, 'actions必须是结构化数组']
  const actual = codes.filter(isActualAction)
  if(!actual.length && value.label_assessments!==undefined && (!Array.isArray(value.label_assessments) || value.label_assessments.length))errors.push('10和13不得生成实际行动逐项论证')
  if (value.actions.length !== actual.length || new Set(value.actions.map(x => x?.id)).size !== actual.length || value.actions.some(x => !actual.includes(x?.id))) errors.push('每个实际建议必须且只能对应一条完整行动')
  if (codes.includes(10) && !value.gaps?.length) errors.push('无建议必须说明阻断缺口')
  const textFields = ['target', 'action', 'time_range', 'direction_relation']
  const fields = new Set(['id', ...textFields, 'scope', 'effect', 'readiness', 'prerequisites', 'evidence_refs', 'decision_object', 'commitment_status'])
  for (const action of value.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) { errors.push('行动必须是对象'); continue }
    if (Object.keys(action).some(k => !fields.has(k))) errors.push('行动包含未授权字段')
    const boundary = OBJECT_BOUNDARIES[action.id]
    if (boundary && (action.decision_object!==boundary.decision_object || action.commitment_status!==boundary.commitment_status)) errors.push(`行动${action.id}须声明decision_object=${boundary.decision_object}及commitment_status=${boundary.commitment_status}；请核对所选编号与执行对象，不匹配应由原席修改分类，不得程序猜测`)
    if (action.decision_object!==undefined && !ACTION_FIELD_ENUMS.decision_object.includes(action.decision_object)) errors.push(`行动${action.id}.decision_object无效；允许existing_tasks/new_investment/strategy/ongoing_investment/other；非2/4/11/12可省略，不得使用scope值或自创枚举`)
    if (action.commitment_status!==undefined && !ACTION_FIELD_ENUMS.commitment_status.includes(action.commitment_status)) errors.push(`行动${action.id}.commitment_status无效；允许existing/uncommitted/not_applicable；非2/4/11/12可省略`)
    for (const field of textFields) if (typeof action[field] !== 'string' || !action[field].trim()) errors.push(`行动缺少${field}`)
    if (!ACTION_FIELD_ENUMS.scope.includes(action.scope)) errors.push('行动scope必须是overall或partial')
    if (!ACTION_FIELD_ENUMS.effect.includes(action.effect)) errors.push('行动effect无效')
    if (!ACTION_FIELD_ENUMS.readiness.includes(action.readiness)) errors.push('行动readiness必须是ready或conditional')
    if (!Array.isArray(action.prerequisites) || action.prerequisites.some(x => typeof x !== 'string' || !x.trim())) errors.push('行动前提必须是字符串数组')
    if (action.readiness === 'conditional' && !action.prerequisites?.length) errors.push('条件性建议必须列明执行前提')
    if (!Array.isArray(action.evidence_refs) || !action.evidence_refs.length || action.evidence_refs.some(id => !evidenceIds.has(id) || !(Array.isArray(value.evidence_refs) && value.evidence_refs.includes(id)))) errors.push('行动必须引用候选内已登记的相关证据')

  }
  for (let i = 0; i < value.actions.length; i++) for (let j = i + 1; j < value.actions.length; j++) {
    const a = value.actions[i], b = value.actions[j]
    if (!a || !b) continue
    if (typeof a.action === 'string' && typeof b.action === 'string' && a.action.trim() && a.action.trim() === b.action.trim()) errors.push('同一实际动作不能重复列项')

  }
  return [...new Set(errors)]
}
function validateNoActionBasis(value,evidenceIds,prior) {
  const errors=[],basis=value.no_action_basis,object=x=>x&&typeof x==='object'&&!Array.isArray(x),text=x=>typeof x==='string'&&Boolean(x.trim())
  if(!prior || ![-1,0,1].includes(prior.code) || !text(prior.version) || value.direction_version!==prior.version) errors.push('无需新增措施须绑定已确定的第一层方向版本')
  if(!Array.isArray(value.gaps) || value.gaps.length)errors.push('无需新增措施不得包含阻断缺口；无法判断用[10]')
  if(!object(basis) || Object.keys(basis).some(k=>!['existing_arrangements','why_sufficient','direction_relation'].includes(k)) || !text(basis.why_sufficient) || !text(basis.direction_relation) || !Array.isArray(basis.existing_arrangements) || !basis.existing_arrangements.length)return [...errors,'无需新增措施须说明已有安排、充分性及方向关系']
  for(const row of basis.existing_arrangements)if(!object(row) || Object.keys(row).some(k=>!['arrangement','evidence_refs'].includes(k)) || !text(row.arrangement) || !Array.isArray(row.evidence_refs) || !row.evidence_refs.length || row.evidence_refs.some(id=>!evidenceIds.has(id) || !(Array.isArray(value.evidence_refs) && value.evidence_refs.includes(id))))errors.push('已有安排须关联候选内已登记的相关证据')
  return [...new Set(errors)]
}
function stageInstruction(stage) {
  const common = '你为目标企业自身提出经营决策，不能站在银行或外部合作方视角评价目标企业。任务固定为企业产业链风险及决策分析。统一公司整体、未来12个月、当前可核验经营状态；局部和其他时间范围必须明确。用户经验不是事实，未填规则和经验时采用明确标注的通用行业推断，不中断。不编造内部资源或执行能力。只引用已筛选证据，从allowed_evidence_ids选择整数序号，原始编号由程序绑定。reason为简短结论，不重复逐项论据；evidence_refs/gaps/assumptions/factors为数组。factors每项包含name,mechanism,effect(positive/neutral/negative/mixed/unknown),evidence_refs,counter_evidence_refs。顶层evidence_refs可省略，程序汇总各项证据引用；各项独立选择其实际依据，不用evidence或conclusions替代规定字段。'
  if (stage === 'direction') return common + '只输出JSON字段direction,reason,evidence_refs,gaps,assumptions,factors,seat_summary。direction必须是数字1(拓展)、0(维持)、-1(收缩)或null(无法判断且必须说明缺口)。按输入direction_policy判断方向并说明边界，不能把缺信息默认维持。'
  return common + `仅针对本席位视角内的问题，基于证据提出必要行动，说明依据和执行前提；与冻结方向一致，彼此相容，不重复。只输出JSON字段recommendations,actions,reason,evidence_refs,gaps,assumptions,factors,direction_version,seat_summary,label_assessments,combination_reason,no_action_basis。recommendations为不重复的整数编号数组，actions为对象数组；10代表无法可靠建议，独占且gaps说明阻断原因；无需新增措施用[13]，独占且按action_relation_policy提供no_action_basis；禁止空建议数组。选项：${JSON.stringify(ACTIONS)}。direction_version由程序绑定，不需输出。actions逐一对应所选实际编号，字段为id,target,scope(overall/partial),time_range,action,effect(increase/maintain/decrease/pause/exit/reallocate/protect),readiness(ready/conditional),prerequisites(字符串数组),evidence_refs,direction_relation。对象、动作与前提须明确，时间与冻结方向一致；未知执行前提标为conditional，不编造执行能力。effect表示对象的变化，不等于公司规模变化；整体退出仅对应收缩，局部或条件性安排须解释与总体方向的关系。10和13不生成actions或label_assessments。2/4/11/12的actions增加decision_object和commitment_status，按输入object_boundaries声明。同一动作不得重复，检查同范围同期冲突。`

}
module.exports = { MODE, FIXED_TASK, DIRECTION_POLICY, ACTIONS, ACTION_LABELS, ACTION_OPTIONS_VERSION, NO_ADVICE_CODE, NO_NEW_MEASURES_CODE, ACTUAL_ACTION_CODES, isActualAction, isNoNewMeasures, OBJECT_BOUNDARIES, ACTION_FIELD_ENUMS, ACTION_RELATION_POLICY, LABELS, fixedQuestion, candidateKey, candidateSignature, validateActions, stageInstruction }
