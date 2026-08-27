<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>让模型负责理解与创造，让程序负责控制、验证与交付。</strong></p>
  <p>一组可嵌入现有 Agent 的开源控制组件：用 Hybrid 协作控制流程、循环、输出边界与群体决策。</p>
  <p>
    <a href="https://www.npmjs.com/package/@rulora/core"><img src="https://img.shields.io/npm/v/%40rulora%2Fcore?tag=alpha&label=npm%20alpha" alt="npm alpha version"></a>
    <a href="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml"><img src="https://github.com/Buffalo2024/Rulora/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  </p>
  <p>
    <a href="README_EN.md">English</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#场景案例">场景案例</a> ·
    <a href="docs/ARCHITECTURE.md">架构</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

---

## 作者与项目说明

Rulora 由一名没有专业编程背景的作者通过 **Vibe Coding** 创建。当前实现经过自动化测试和
场景验证，但仍可能存在架构、性能、安全或兼容性问题。欢迎开发者带着具体问题、复现步骤、
评估数据和改进方案参与讨论与优化。开源不是为了宣称项目已经完美，而是希望通过真实使用与
共同审查，得到更可靠、更有用的产品。

## Rulora 是什么

Rulora 是一组可以按需嵌入单个 Agent 或 Agent 群体的轻量控制组件，通过概率模型与确定性
程序的 **Hybrid 协作**，控制流程、循环、结构化输出和群体候选选择。

Rulora 将这种协作方式称为 **Hybrid 机制**，核心分工如下：

- **LLM** 负责理解证据、开放语义推理、独立判断和候选选择；
- **Program** 负责流程状态、字段合同、校验、统计、候选池、门禁和最终结果；
- **Recovery** 只修复 JSON 或 Markdown 载体，不推断业务答案；
- **Adapter** 只做字段别名与确定性类型转换，不增删或修改结论；
- **Reviewer** 只选择 Program 冻结的候选 ID，不重新创造答案；
- **Loop** 区分网络重连、约束修订和业务广播，全部有次数上限；
- **Checkpoint** 保证只恢复失败节点，不重复调用成功节点；
- **Improvement 席** 只利用客观反馈改进下一版本，不在运行中自改。

> Hybrid 是 Rulora 对“模型能力与确定性程序协同”的项目术语，
> 不是某个模型、Agent 平台或图片服务的名称。

你可以只使用一个组件，也可以在同一个 Agent 中嵌套多个组件。Rulora 不接管模型、工具、
会话、数据库或 UI；这些继续由宿主 Agent 负责。

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
5. **恢复必须校验检查点**：宿主重启后从 Repository 读取状态，只有通过场景不变量校验才可继续，已接受步骤不会重复执行。
6. **集成留在边界之外**：模型、图片、渠道与持久化由宿主通过明确接口接入。
7. **商业策略留在宿主应用**：付费、订阅和访问次数不写死在 Rulora Core 中。

## 快速开始

要求 Node.js 20 或更高版本。安装公开 Alpha：

```bash
npm install @rulora/core@alpha
```

也可以直接从源码运行：

```bash
git clone https://github.com/Buffalo2024/Rulora.git
cd Rulora
npm test
npm run example
```

这个最小示例使用虚构输入展示模型候选字段如何经过程序验证、推进分支并冻结为带证据的
结果，不需要 API Key。接入真实模型时，请通过 Provider Adapter 读取环境变量，不要把
密钥写入代码、Scenario 或 Prompt。

## 场景案例

| Agent | 状态 | 任务 | 场景 |
|---|---|---|---|
| **[Rulora Report Agent](https://github.com/Buffalo2024/Rulora-Report-Agent)** | Alpha · 已开源 | 将公开来源转换为经过验证的 PNG 长图 | 跨境电商政策日报、新能源汽车出海周报 |
| **[Rulora AGTI](https://github.com/Buffalo2024/Rulora-AGTI)** | Alpha · 已开源 | 确定性身份测评、受控诊断与稳定视觉交付 | 20 道题、24 型身份、A/B 报告协议 |
| **[Rulora Collective Decision](https://github.com/Buffalo2024/Rulora-Collective-Decision)** | Alpha · 已开源 | 多席独立候选、法定人数、受限复核与节点恢复 | 虚构企业信贷风险研究案例 |
| **Rulora DeepSeek Harness Adapter** | 开发中 | 将 Rulora 控制组件接入 DeepSeek Harness | 接口仍需联调，不建议生产使用 |
| **Rulora PDCA Management Agent** | 长期设计保留 | 通过 DST-PDCA 访谈、行动跟踪和复盘支持持续管理改善 | 咨询分析、问题解决、计划推进、PDCA 审查 |

Report Agent、AGTI 和 Collective Decision 均作为独立开源项目发布。Report Agent 的两个报告
场景共享数据接入、结构化、分析、验证、渲染和 QA 底座；AGTI 展示确定性计分与受控诊断；
Collective Decision 展示候选池、法定人数、受限 Reviewer 和失败节点恢复。

三个场景是独立仓库，用来证明同一组控制思想可以服务不同任务，不构成必须安装的“生态”。
PDCA Agent 的长期设计见 [PDCA Management Agent 设计备忘](docs/PDCA-MANAGEMENT-AGENT.md)。

## 当前实现边界

当前 Alpha 已实现：

- `OrchestrationMachine`：字段分支、来源回合、Token 计数、无进展纠偏、人工接管和冻结；
- `MemoryRepository`：仅用于本地演示和测试的进程内存储；
- `HybridPipeline`：带 `model` / `program` 所有权和可选验证门禁的顺序流水线；
- `LoopControl`：限制尝试次数与连续无进展次数，显式转入耗尽或人工接管；
- `OutputBoundary`：按 Recovery → Adapter → Core/Audit 双契约接受或拒绝模型输出；
- `CollectiveControl`：冻结候选池、检查法定人数，并限制 Reviewer 只能选择池内 ID；
- Repository 检查点恢复：新控制器可校验已有状态并从未完成分支继续；
- 一个无需 API Key 的 Core 教学示例。

当前尚未内置：真实模型或图片 Provider、持久化数据库适配器、OCR、确定性图片融合、
像素差异计算、自动重试调度、并发控制和生产级可观测性。相关名称在架构文档中表示扩展边界，
不表示当前包已经提供对应实现。

## Core 教学示例与实验

[状态与所有权示例](examples/state-and-ownership/README.md)用于学习字段、分支、证据、预算、
纠偏、人工接管和冻结。尚未形成真实交付能力的探索性代码放在 [`labs/`](labs/README.md)，
不会作为官方 Agent 或 Core 能力宣传。

## 安装 Core

当前版本处于 Alpha，请显式使用 `alpha` 标签安装：

```bash
npm install @rulora/core@alpha
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
