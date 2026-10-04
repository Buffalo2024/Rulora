<div align="center">
  <img src="assets/brand/rulora-logo-256.png" width="136" alt="Rulora logo">
  <h1>Rulora</h1>
  <p><strong>让模型负责理解与创造，让程序负责控制、验证与交付。</strong></p>
  <p>可嵌入现有 AI Agent 的开源控制组件。</p>
  <p><a href="README_EN.md">English</a> · <a href="docs/getting-started.md">快速开始</a> · <a href="docs/api.md">API</a> · <a href="docs/guarantees.md">能力边界</a></p>
</div>

Rulora 通过模型与程序的 **Hybrid 协作**，约束输出、控制循环、管理状态与群体候选选择。
按需使用一个组件，也可以在一个 Agent 或 Agent 群体中组合多个组件。
业务判断由模型承担，是否接受结果、继续执行或停止，由程序按照明确规则控制。

**让执行过程有边界，让结果在验证后交付，让失败能够被识别和处理。**
这不等于保证模型答案正确，也不意味着需要替换现有模型服务或 Agent 框架。

> 当前版本：`@rulora/core@0.1.0-alpha.4`，Alpha。
> 安装时使用 `@alpha` 标签；具体版本以 npm registry 的公开结果为准。

Core 运行时零依赖。Ajv 仅用于本仓库的 Schema 示例与测试，TypeScript 仅用于类型编译验证，
两者都是开发依赖。安装发布的 Core 不会安装它们，也不会安装完整场景的依赖。

## 快速开始

Core 要求 Node.js 20+。安装已发布版本：

```bash
npm install @rulora/core@alpha
```

一个输出验证边界：

```js
const { OutputBoundary } = require('@rulora/core')

const boundary = new OutputBoundary({
  recover: raw => JSON.parse(raw),
  adapt: value => value,
  validateCore: value =>
    value !== null &&
    typeof value.summary === 'string' &&
    value.summary.trim().length > 0
})

async function main() {
  const result = await boundary.process('{"summary":"合成经营摘要"}')
  console.log(result.value)
}
main().catch(console.error)
```

这里只检查结构，不证明摘要真实。证据绑定与业务规则需要自己的验证器。
Core 也不会自动证明 Adapter 没有修改结论。

## 三个可以立即验证的控制点

从本仓库源码根目录运行：

```bash
npm ci --ignore-scripts
npm test
npm run examples:quickstart
```

| 你需要什么 | 命令 | 能看到的行为 |
| --- | --- | --- |
| 拒绝不合格输出 | `npm run example:output` | 缺字段、未知引用被拒绝 |
| 停止无效循环 | `npm run example:loop` | 连续无进展转人工，不再继续 |
| 限制群体复核 | `npm run example:candidates` | 候选快照不可改，Reviewer 只能选已有 ID |

无需 API Key，不联网调用模型。[查看源码](examples/quickstart/README.md)。
更完整的状态、字段与证据控制见 [工作流教学示例](examples/state-and-ownership/README.md)。

需要校验 JSON Schema 时，运行 `npm run example:schema`，或直接阅读
[Ajv 接入程序](examples/integrations/README.md)。它展示结构与证据引用两层门禁，Core 不增加运行依赖。
[什么时候使用](docs/adoption.md) · [为何保持小组件](docs/decisions/0001-control-component-boundary.md)。

## 一个群体决策场景，逐级理解控制能力

先从主仓库根目录运行最小群体程序，无需模型密钥或场景依赖：

```bash
node examples/collective-decision/examples/controlled-collective.js
```

三席提交合成候选：seat-a 的未知证据先被拒绝，第二次通过；seat-b 首次通过；
seat-c 两次失败后停止并标记人工接管。程序冻结两份合格候选，Reviewer 只能选择已有 ID。
这一个程序直接组合 OutputBoundary、LoopControl 和 CollectiveControl。

| 层次 | 你会看到什么 | 入口 |
| --- | --- | --- |
| 最小控制 | 输出拒绝、有界循环、候选冻结 | [Quickstart](examples/quickstart/README.md) |
| 最小群体 | 多席提交 → 校验与修订 → 冻结 → 受限选择 | [直接使用 Core 的示例](examples/collective-decision/examples/controlled-collective.js) |
| 完整系统（高级示例） | 企业证据 → 两层五席判断 → 结构化经营决策与检查点恢复 | [输入输出](examples/collective-decision/examples/fixtures/static/README.md) · [群体决策](examples/collective-decision/README.md) · [源码导航](examples/collective-decision/docs/CODE-MAP.md) |

群体决策用于分析企业应收缩、维持还是拓展经营，以及如何选择完整行动方案。
模型独立判断，程序控制角色可见信息、交换次数、候选冻结与结果交付。
“两层”分别判断经营方向与行动方案；“五席”是每层五个独立判断角色，
可以配置不同模型，也可以使用同一模型的独立调用，不代表必须购买五种模型服务。
离线示例无需 API Key；控制测试不证明经营建议准确。

```text
Agent 提交候选 → 输出与证据校验 → 冻结候选 → 受限复核 → 交付
                    ↓ 失败
               分类的有界 Loop → 达到上限 → 停止 / 人工处理
```

网络重连、约束修订、业务交换分别计数。Core 提供计数与停止状态，宿主执行调度；
完整场景另行实现模型调用检查点、持久化和恢复。安装 Core 不会安装 LangGraph。

## Core 与场景的边界

| Core 提供 | 场景自行实现 | 宿主仍需负责 |
| --- | --- | --- |
| OutputBoundary、LoopControl、CollectiveControl | 双层五席、模型调用检查点与证据编号绑定 | 模型、数据授权、人工审核 |
| 状态机、MemoryRepository、顺序 HybridPipeline | 角色披露、候选审计、本地交互控制台 | 持久化、认证、租户隔离、费用与运维 |

Core 当前只内置内存 Repository，不包含通用文件锁、数据库、OCR 或生产级调度。
它们出现在案例中，不代表安装 Core 自动获得。
详见 [API](docs/api.md)、[保证与限制](docs/guarantees.md)、[集成方式](docs/integration.md)。

## 仓库结构

```text
Rulora/
├── src/                 小型控制组件与类型
├── tests/               Core 契约测试
├── examples/
│   ├── quickstart/      三个最小调用示例
│   └── collective-decision/  最小群体示例与完整企业经营决策
├── docs/                使用、API、边界与发布说明
├── labs/                不作为正式能力宣传的实验
└── .github/workflows/    Core 与场景分别验证
```

一个仓库维护，从小组件逐步理解复杂系统。场景高级能力按验证结果逐个提炼。
[迁移说明](docs/MONOREPO.md) · [概念](docs/concepts.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)。

## 技术与商务合作

欢迎提交复现步骤、独立评估和真实业务需求，合作完善组件与场景。
当前实现已经过自动化测试和场景验证，但仍持续演进，架构、性能、安全与兼容性问题需要真实使用和共同审查来发现与改进。

- 邮箱：`zzjeff1993.agent@gmail.com`
- 微信：扫码添加，请注明 Rulora 或合作事项。

<p align="center"><img src="assets/contact/wechat-qr.jpg" width="200" alt="Rulora 微信联系方式"></p>

## 许可

Core 与群体决策采用 [Apache-2.0](LICENSE)。第三方依赖及资产保留其原许可；品牌规则见 [TRADEMARKS.md](TRADEMARKS.md)。
