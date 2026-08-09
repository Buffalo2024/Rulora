<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>让模型负责理解与创造，让程序负责控制、验证与交付。</strong></p>
  <p>一套面向真实业务场景的 LLM + Program Hybrid 协同框架。</p>
  <p>
    <a href="README_EN.md">English</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#官方-agent-生态">Agent 生态</a> ·
    <a href="docs/ARCHITECTURE.md">架构</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

---

## Rulora 是什么

Rulora 是一套用于构建高约束 AI 工作流的开源基础框架。它不要求模型接管全部流程，
而是把开放性的理解与创作交给模型，把确定性的状态、规则和交付责任交给程序。

Rulora 将这种协作方式称为 **Hybrid 机制**：

- **模型负责开放任务**：理解自然语言、追问、提炼、结构化生成和视觉创作；
- **程序负责确定任务**：字段、状态、分支、预算、证据、Schema、质量门禁和保存；
- **数据契约连接两者**：模型只提交候选结果，程序验证通过后才允许流程前进。

> Hybrid 是 Rulora 对“模型能力与确定性程序协同”的项目术语，
> 不是某个模型、Agent 平台或图片服务的名称。

Rulora 主仓库提供 Core、公共约定、最小教学示例和官方 Agent 索引。解决具体任务的
Agent 作为独立开源项目发布；日报、周报、行业和交付格式属于 Agent 内部可路由的场景包，
不等同于新的 Agent。

## 为什么需要它

只依赖 Prompt 的 Agent 容易出现流程漂移、字段遗漏、无限追问、成本失控和结果不可复现；
只依赖传统程序，又难以理解真实用户的自然表达，也不擅长开放式内容与视觉创作。

Rulora 在两者之间建立一份可执行契约：

```text
用户或业务事件
      ↓
模型：理解、提取、提问、生成
      ↓  候选结构化结果
Rulora：校验、状态转换、预算与证据门禁
      ↓  已批准任务
模型 / Image：完成受约束创作
      ↓  候选交付物
Rulora：质量检查、定向重试、人工接管、保存
```

## Hybrid 机制

1. **程序拥有状态**：模型不能自行宣布字段完成、跳转分支或结束流程。
2. **模型提交候选结果**：字段、报告和图片必须通过程序契约才能进入下一阶段。
3. **结论绑定证据**：重要输出可以追溯到输入字段、用户回合或上游产物。
4. **失败是显式状态**：重试、无进展、Token 预算和人工接管由程序记录。
5. **集成留在边界之外**：模型、图片、渠道与持久化由宿主通过明确接口接入。
6. **商业策略留在宿主应用**：付费、订阅和访问次数不写死在 Rulora Core 中。

## 快速开始

要求 Node.js 20 或更高版本。npm Alpha 包发布前，可直接从源码运行：

```bash
git clone https://github.com/Buffalo2024/Rulora.git
cd Rulora
npm test
npm run example
```

这个最小示例使用虚构输入展示模型候选字段如何经过程序验证、推进分支并冻结为带证据的
结果，不需要 API Key。接入真实模型时，请通过 Provider Adapter 读取环境变量，不要把
密钥写入代码、Scenario 或 Prompt。

## 官方 Agent 生态

| Agent | 状态 | 任务 | 场景 |
|---|---|---|---|
| **Rulora Report Agent** | 设计中 · 仓库尚未发布 | 将公开来源或企业数据转换为经过验证的 PNG 长图和单页 PPTX | 跨境电商政策日报、客服运营日报、新能源汽车出海周报 |

Report Agent 将作为一个独立开源项目发布。三个场景共享采集、结构化、分析、验证、渲染
和 QA 底座，通过任务路由选择周期、数据源、模板及交付格式。项目达到可运行标准后，
这里会补充仓库链接；当前不提供空仓库或占位链接。

官方 Agent 与社区 Agent 的边界、发布条件和目录约定见
[Agent 生态与项目边界](docs/AGENT-ECOSYSTEM.md)。

## 当前实现边界

当前 `0.1.0-alpha.1` 已实现：

- `OrchestrationMachine`：字段分支、来源回合、Token 计数、无进展纠偏、人工接管和冻结；
- `MemoryRepository`：仅用于本地演示和测试的进程内存储；
- `HybridPipeline`：带 `model` / `program` 所有权和可选验证门禁的顺序流水线；
- 一个无需 API Key 的 Core 教学示例。

当前尚未内置：真实模型或图片 Provider、持久化数据库适配器、OCR、确定性图片融合、
像素差异计算、并发控制、断点恢复和生产级可观测性。相关名称在架构文档中表示扩展边界，
不表示当前包已经提供对应实现。

## Core 教学示例与实验

[状态与所有权示例](examples/state-and-ownership/README.md)用于学习字段、分支、证据、预算、
纠偏、人工接管和冻结。尚未形成真实交付能力的探索性代码放在 [`labs/`](labs/README.md)，
不会作为官方 Agent 或 Core 能力宣传。

## 安装 Core

当前 npm 包尚未发布。请先从源码运行；首个 npm 版本发布后将支持：

```bash
npm install @rulora/core
```

基础用法：

```js
const { MemoryRepository, OrchestrationMachine } = require('@rulora/core')

const machine = new OrchestrationMachine({
  repository: new MemoryRepository(),
  scenario: yourScenario,
  defaults: { tokenLimit: 12000 }
})
```

## 它如何与 OpenClaw 配合

Rulora 不是 OpenClaw 的替代品。OpenClaw 可以承担会话、工具、渠道与模型接入；
Rulora 作为确定性业务控制层，决定当前字段、状态转换、验证和交付门禁。

```text
OpenClaw / Web / 客服渠道
          ↓
    Rulora Scenario
          ↓
Model Provider ↔ Rulora Core ↔ Repository / Quality Gate
```

## 仓库结构

```text
rulora/
├─ assets/                               Logo 与联系方式占位资产
├─ docs/                                 架构、边界与发布说明
├─ examples/
│  └─ state-and-ownership/                状态、证据与程序所有权教学示例
├─ labs/                                 未进入正式能力范围的 Mock 实验
├─ src/                                  通用状态机和 Hybrid Pipeline
└─ tests/                                状态、门禁和契约测试
```

## 文档导航

- [架构与核心不变量](docs/ARCHITECTURE.md)
- [Agent 生态与项目边界](docs/AGENT-ECOSYSTEM.md)
- [OpenClaw 接入说明](docs/OPENCLAW-INTEGRATION.md)
- [发布检查清单](docs/RELEASE-CHECKLIST.md)
- [GitHub 仓库资料](docs/REPOSITORY-METADATA.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 商务与技术合作

如果你希望围绕 Rulora、场景案例或其他业务场景开展技术合作、联合开发或商务合作，请联系：

- 邮箱：`zzjeff1993.agent@gmail.com`
- 微信：扫码添加，请注明 Rulora 或合作事项

<p align="center">
  <img src="assets/contact/wechat-qr.jpg" width="220" alt="Rulora 微信联系方式">
</p>

## 许可

本仓库代码采用 [Apache-2.0](LICENSE) 许可证。Rulora 名称与 Logo 用于识别本开源项目，
其品牌使用规则独立于代码许可证，详见 [TRADEMARKS.md](TRADEMARKS.md)。
