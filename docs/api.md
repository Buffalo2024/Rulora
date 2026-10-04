# Core API

导出入口：`require('@rulora/core')`；源码使用 `require('./src')`。
完整签名：[index.d.ts](../src/index.d.ts)。版本 0.1.0-alpha.4，安装以 npm registry 为准。

## OutputBoundary

`new OutputBoundary({recover, adapt, validateCore, validateAudit})`；
`await boundary.process(raw, context)` 返回 `{value, accepted: true}`。

依次执行 recover → adapt → validateCore → validateAudit；两个验证器都必须返回严格的 true。
Core/Audit 拒绝抛 OutputBoundaryError（stage、details）；解析器和用户回调异常原样传播。
recover/adapt 默认恒等函数；validateCore 必填；validateAudit 默认 true。
当前 Core 的 Audit 也是硬门禁，不是场景里某些“仅警告”的 Audit 策略。
Core 不检查回调是否擅自改变结论，宿主须实现语义不变量。

接入已有 Schema 验证器：

```js
const boundary = new OutputBoundary({
  recover: raw => JSON.parse(raw),
  validateCore: value => validateSchema(value) === true
    ? true : { errors: structuredClone(validateSchema.errors) },
  validateAudit: (value, context) =>
    value.evidence_ids.every(id => context.allowedEvidence.has(id))
})
const result = await boundary.process(rawModelResponse, {
  allowedEvidence: new Set(['E1', 'E2'])
})
```

`validateSchema` 是宿主预先编译的验证函数；完整可运行版本见 [Ajv 示例](../examples/integrations/README.md)。
Core 接受的是 primitive `true`。`1`、字符串、对象、`undefined` 均不通过；
不要返回诊断对象后仍继续交付。JSON 解析失败由解析器抛出，不包装成 Audit 拒绝。

## TypeScript

```ts
type Proposal = { id: string; evidence: string[] }
type Context = { allowed: Set<string> }
const boundary = new OutputBoundary<Proposal, Context, string, unknown>({
  recover: raw => JSON.parse(raw) as unknown,
  adapt: value => value as Proposal,
  validateCore: value => typeof value.id === 'string',
  validateAudit: (value, context) => value.evidence.every(id => context.allowed.has(id))
})
```

四个泛型依次表示输出、上下文、原始载体、Recovery 输出。
类型断言不会验证运行时数据，仍需真实 Schema 或业务验证器。
`ValidationResult` 支持 boolean、字符串、字符串数组、诊断对象或 null；只有 true 接受。
类型声明现在能拒绝遗漏返回值和数字返回值，但运行时也会拒绝所有非 true 值。
这是 Alpha 类型约束收紧；旧回调若返回其他诊断类型，应转换成支持的诊断对象。

`LoopSnapshot` 使用精确的 LoopKind / LoopStatus；候选返回值为递归只读。
运行 `npm run test:types` 检查类型正例和预期编译错误，`npm test` 验证运行行为。
类型不能证明对象无环、候选属于控制器或证据真实，这些由运行检查或宿主负责。

## LoopControl

`new LoopControl({kind, maxAttempts, maxNoProgress})`；默认 constraint_revision / 3 / 2。
kind 为 network_reconnect、constraint_revision 或 business_broadcast。
每次实际尝试后调用 `record({progressed: boolean})`；读取 `snapshot()`。
状态：active、exhausted、human_handoff。关闭后 record 抛 LOOP_CLOSED。
该组件仅计数，不自动调模型、延时、取消请求或持久化。宿主必须遵守停止状态。

## CollectiveControl

`new CollectiveControl({quorum})`，默认 quorum=2。
`freezeCandidates(submissions)` 创建独立、递归冻结的候选池。
只接受有限数值、普通对象、稠密数组组成的无环 JSON 数据；最大嵌套深度 100。
拒绝 Date、Map、Set、BigInt、函数、undefined、符号、访问器和隐式 toJSON 转换。
顶层候选必须为对象。省略 id 时生成 candidate-N；显式 id 须为非空字符串，不能重复。

`select(pool, selectedId)` 只接受同一控制器创建的原始池，返回递归只读候选。
复制池、另一个实例的池、从 JSON 反序列化的池都需重新验证并 freezeCandidates。
错误码：INVALID_CANDIDATE、DUPLICATE_CANDIDATE、QUORUM_NOT_MET、INVALID_POOL、UNKNOWN_CANDIDATE。
人数检查不证明候选来源独立；该组件不决定多数规则或业务最优方案。

## OrchestrationMachine / MemoryRepository

`new OrchestrationMachine({repository, scenario, defaults})`。
公开操作：createSession、getState、recoverSession、recordUserTurn、recordUsage、
submitFields、recordNoProgress、freeze、reportContract。
参数及返回类型以类型声明为准；[完整例子](../examples/state-and-ownership/run.js)。

Repository 使用 create/get/save 接口。MemoryRepository 仅驻留进程内存，
不是持久化数据库、并发事务或多租户权限层。恢复工作流状态不等于模型调用结果缓存。

## HybridPipeline

`new HybridPipeline({id, steps})`；每步包含 id、owner（model/program）、run 和可选 validate。
`run(input, context)` 返回 pipelineId、output、events。按顺序执行并验证。
owner 是职责标签，不是沙箱权限限制；没有通用并行调度或自动补偿。

## alpha.4 迁移注意

候选浅冻结改为 JSON 快照与递归冻结；select 不再接受任意数组。
依赖 Date/Map/访问器等输入，或跨实例选择池的旧调用必须显式转换并重新冻结。
这是 Alpha 的行为收紧，不以兼容旧不安全行为为目标。
