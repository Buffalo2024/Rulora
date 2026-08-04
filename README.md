<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="148" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>让模型理解与创造，让程序控制、验证并交付。</strong></p>
  <p>一套面向真实业务场景的 LLM + Program Hybird 协同框架。</p>
  <p>
    <a href="README_EN.md">English</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#场景案例">场景案例</a> ·
    <a href="docs/ARCHITECTURE.md">架构</a> ·
    <a href="CONTRIBUTING.md">参与贡献</a>
  </p>
</div>

---

## Rulora 是什么

Rulora 是一套用于构建高约束 AI 工作流的开源基础框架。它不要求模型接管全部流程，
而是把开放性的理解与创作交给模型，把确定性的状态、规则和交付责任交给程序。

Rulora 将这种协作方式称为 **Hybird 机制**：

- **模型负责开放任务**：理解自然语言、追问、提炼、结构化生成和视觉创作；
- **程序负责确定任务**：字段、状态、分支、预算、证据、Schema、质量门禁和保存；
- **数据契约连接两者**：模型只提交候选结果，程序验证通过后才允许流程前进。

> Hybird 是 Rulora 对“模型能力与确定性程序协同”的项目术语，
> 不是某个模型、Agent 平台或图片服务的名称。

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

## Hybird 机制

1. **程序拥有状态**：模型不能自行宣布字段完成、跳转分支或结束流程。
2. **模型提交候选结果**：字段、报告和图片必须通过程序契约才能进入下一阶段。
3. **结论绑定证据**：重要输出可以追溯到输入字段、用户回合或上游产物。
4. **失败是显式状态**：重试、无进展、Token 预算和人工接管由程序记录。
5. **供应商可以替换**：文本模型、图片模型、渠道与存储通过适配器接入。
6. **商业策略留在宿主应用**：付费、订阅和访问次数不写死在 Rulora Core 中。

## 场景案例

| 案例 | 状态 | 模型负责 | 程序负责 |
|---|---|---|---|
| [01 · 受控诊断 Agent](examples/01-guided-diagnosis/README.md) | Alpha | 理解回答、提问、提炼候选字段 | 字段、分支 Loop、无进展纠偏、Token 门禁、证据与冻结 |
| [02 · 原生报告生图](examples/02-native-image-report/README.md) | Alpha | 生成报告内容与完整带字图片 | Schema、视觉叙事选择、OCR/视觉 QA、定向重试 |
| [03 · 稳定生图复刻](examples/03-stable-image-reproduction/README.md) | Alpha | 首次图文协同设计、按槽位压缩文案 | 槽位注册、确定性融合、溢出与像素范围检查 |

案例二追求每次报告的原生视觉协同；案例三追求一个优秀设计被稳定、批量地复刻。

案例二的[完整视觉 Prompt](examples/02-native-image-report/visual-prompt.js)可作为真实接入参考。
由于样例有商业化用途，打上了【共生纪 开源样例】的水印，程序还会通过 OCR 质量门禁检查该标记。

这些案例不仅说明 Hybird 机制，也提供可运行程序和一个完整的原生报告视觉 Prompt 示例。
作者另有基于以上三类场景构建的商业化应用；这些应用本身不属于本仓库的开源内容。

## 快速开始

要求 Node.js 20 或更高版本。

```bash
git clone https://github.com/Buffalo2024/rulora.git
cd rulora
npm test
```

运行三个本地示例：

```bash
npm run example:diagnosis
npm run example:native-image
npm run example:stable-image
```

示例默认使用 Mock Provider，不需要 API Key。接入真实模型时，请通过 Provider Adapter
读取环境变量，不要把密钥写入代码、Scenario 或 Prompt。

## 安装 Core

首个 npm 版本发布后：

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
│  ├─ 01-guided-diagnosis/               受控诊断 Agent
│  ├─ 02-native-image-report/             原生报告生图
│  └─ 03-stable-image-reproduction/       稳定生图复刻
├─ src/                                  通用状态机和 Hybird Pipeline
└─ tests/                                状态、门禁和契约测试
```

## 文档导航

- [架构与核心不变量](docs/ARCHITECTURE.md)
- [OpenClaw 接入说明](docs/OPENCLAW-INTEGRATION.md)
- [开源与商业边界](docs/OPEN-SOURCE-BOUNDARY.md)
- [发布检查清单](docs/RELEASE-CHECKLIST.md)
- [GitHub 仓库资料](docs/REPOSITORY-METADATA.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 商务与技术合作

如果你希望基于以上三个场景案例，或其他业务场景开展技术合作、联合开发或商务合作，
请联系：

- 邮箱：`zzjeff1993.agent@gmail.com`
- 微信：扫码添加，请注明 Rulora 或合作事项

<p align="center">
  <img src="assets/contact/wechat-qr.jpg" width="220" alt="Rulora 微信联系方式">
</p>

## 开源边界与许可

本仓库公开其中实际提交的框架代码、协议、文档、测试与三个场景案例。作者另有基于这些机制
开发的商业化应用；商业应用的产品实现、业务配置、运营数据和交付内容不随本仓库开放。

本仓库代码采用 [Apache-2.0](LICENSE) 许可证。Rulora 名称与 Logo 用于识别本开源项目，
其品牌使用规则独立于代码许可证，详见 [TRADEMARKS.md](TRADEMARKS.md)。
