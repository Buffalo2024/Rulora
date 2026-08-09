# Rulora architecture

## Hybrid execution contract

执行契约不是 Prompt 文档，而是可运行的状态、输入、证据、预算、失败和验收规则。模型输出
始终是候选值；程序根据契约决定接受、拒绝、恢复或交付。

Rulora 把一次工作流划分为四种责任：

| 责任 | 所有者 | 说明 |
|---|---|---|
| 理解与创作 | Model Provider | 从自然语言生成候选字段、报告或图片 |
| 状态与策略 | Rulora Core | 决定是否接受、前进、重试、阻断或转人工 |
| 存储与审计 | Repository | 保存版本、证据、用量和状态变化 |
| 渠道与交付 | Channel Adapter | 连接网页、OpenClaw、客服系统或其他前端 |

模型调用不能直接写业务状态。正确调用顺序是：

```text
read state → build model task → model proposes → validate → commit transition
```

## Implemented in `0.1.0-alpha.1`

- `ScenarioDefinition`：场景、分支、字段和输出契约。
- `OrchestrationMachine`：唯一有权改变工作流状态的组件。
- `MemoryRepository`：测试和本地示例使用的进程内存储。
- `HybridPipeline`：明确步骤所有权、按顺序运行并执行可选验证门禁。
- `recoverSession`：从宿主 Repository 恢复前校验场景、分支、状态和字段证据不变量。
- 内建程序门禁：基础字段类型与容量、来源回合、Token 总量、无进展和人工接管。

## Extension boundaries, not bundled implementations

- `Repository`：宿主可以按 `create/get/save` 约定实现持久化；当前没有数据库适配器。
- Model / Image Provider：由宿主调用并向 Core 提交候选值；当前没有供应商 SDK 适配器。
- Channel Adapter：由宿主连接网页、OpenClaw 或客服渠道；当前没有渠道包。
- Quality Gate：可在 Pipeline 的 `validate` 中接入；当前没有 OCR、视觉 QA、确定性图片融合或像素差异引擎。

当前版本支持从 Repository 检查点恢复控制流程，但只内置进程内存储；数据库持久化适配器、
跨进程锁、通用重试调度和生产级可观测性仍属于后续能力，不应从本架构图中推断为已经实现。

## Deterministic invariants

- 当前分支必填字段全部存在前不得进入下一分支。
- 访问控制、订阅和付费策略属于宿主应用，不内置在 Rulora Core 中。
- 无进展计数只属于当前分支，进入下一分支后清零。
- 两次无进展进入纠偏；纠偏后再次无进展转人工。
- Token 用量由程序累计，不通过对话内容向用户暴露。
- 冻结后输入字段不可被报告阶段反向修改。
