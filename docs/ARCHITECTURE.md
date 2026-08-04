# Rulora architecture

## Hybird execution contract

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

## Core primitives

- `ScenarioDefinition`：场景、分支、字段和输出契约。
- `OrchestrationMachine`：唯一有权改变工作流状态的组件。
- `Repository`：可替换的持久化接口。
- `ModelProvider`：文本或图片服务适配器。
- `PolicyGate`：权限、预算、敏感信息和人工介入策略。
- `QualityGate`：Schema、OCR、视觉、溢出或像素范围检查。

## Deterministic invariants

- 当前分支必填字段全部存在前不得进入下一分支。
- 访问控制、订阅和付费策略属于宿主应用，不内置在 Rulora Core 中。
- 无进展计数只属于当前分支，进入下一分支后清零。
- 两次无进展进入纠偏；纠偏后再次无进展转人工。
- Token 用量由程序累计，不通过对话内容向用户暴露。
- 冻结后输入字段不可被报告阶段反向修改。
