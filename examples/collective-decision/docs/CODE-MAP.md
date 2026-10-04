# 从入口读到交付

完整场景是企业经营决策的高级示例。理解 Core 不需要先掌握行动编号。

## 阅读顺序

1. [最小群体](../examples/controlled-collective.js)：三个 Core 组件如何组合。
2. [预置输入输出](../examples/fixtures/static/README.md)：系统收到什么，交付什么。
3. [完整入口](../src/enterprise-decision.js)：`runEnterpriseDecision`，约 650 行。
4. [图拓扑](../src/cluster-graph.js)：`buildEnterpriseDecisionGraph` 与 `buildEnterpriseSeatLoopGraph`。
5. [决策合同](COLLECTIVE-CONTRACT.md)：理解业务分支后再阅读行动与对象边界。

## 主路径

```text
CLI run / 本地页面
  → runEnterpriseDecision
  → intake：问题、快照与证据门禁
  → direction：五席独立判断、交换、复核、方向冻结
  → condition：五席行动组合、交换、复核、完整候选选择
  → 必要时 supplemental_search → 证据变化后重新 intake
  → finalize：报告 Schema 与冻结交付
```

两层内部使用独立的席位循环图；不是让一个大循环处理全部失败类型。

## 职责与代码

| 职责 | 源码 | 归属 |
| --- | --- | --- |
| 字段、分支与冻结门禁 | [场景声明](../src/scenario.js)、Core OrchestrationMachine | Core + 场景合同 |
| 五席、交换与图路线 | [enterprise-decision](../src/enterprise-decision.js)、[cluster-graph](../src/cluster-graph.js) | 场景运行时 |
| JSON 载体、协议和确定性适配 | [输出协议](../src/enterprise-output-protocol.js)、[载体恢复](../src/competition-output-recovery.js) | 场景 |
| 讨论版本与冻结状态 | [deliberation](../src/enterprise-deliberation.js) | 场景 |
| 合法行动与对象边界 | [action-contract](../src/enterprise-action-contract.js) | 业务合同 |
| 受控证据和候选别名 | [reference-binding](../src/enterprise-reference-binding.js) | 场景 |
| 快照哈希与来源登记 | [evidence-registry](../src/evidence-registry.js) | 场景 |
| 验证后缓存与复用 | [checkpoint-store](../src/model-call-checkpoint-store.js) | 场景 |
| 模型路由与重连 | [model-routing](../src/enterprise-model-routing.js)、[Provider](../src/provider-loader.js) | 场景 |
| 本地交互和任务执行 | [web-server](../src/web-server.js)、[web-job-manager](../src/web-job-manager.js) | 宿主 |

`orchestrator.js` 仍被网页模块引用以使用来源准备等共享功能；完整决策的主入口是
`enterprise-decision.js`。因此不能仅按最大文件行数拆分主执行流程。
进一步提炼共享模块时，应保留现有失败与重放测试。

## 一次模型调用

场景构造角色视图 → 原始响应 → Recovery → 确定性 Adapter → Core/Audit 合同 →
写入已校验检查点。失败进入指定的修订或网络处理路径；达到预算则停止。
交换及 Reviewer 的业务含义由模型判断，程序不从自由文本推断默认答案。

检查点按匹配身份复用，并再次验证缓存输出；证据、协议或提示变化影响复用身份。
它不承诺进程崩溃期间外部请求恰好执行一次。

[运行模式](RUNNING-MODES.md) · [验证](SYSTEM-VALIDATION.md)。
