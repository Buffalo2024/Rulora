<p align="center"><img src="assets/brand/rulora-logo-256.png" width="128" alt="Rulora Logo"></p>

# Rulora 群体决策

**让多个模型独立判断，让程序控制讨论、冻结候选、校验并交付。**

[English](README_EN.md) · [主仓库](../../README.md) · [合同](docs/COLLECTIVE-CONTRACT.md) · [验证](docs/SYSTEM-VALIDATION.md)

这是展示复杂系统的高级示例。先看 [输入与预期报告](examples/fixtures/static/README.md)，
再按 [源码导航](docs/CODE-MAP.md)阅读主路径；[运行模式](docs/RUNNING-MODES.md)说明离线、页面、真实模型与可选队列的区别。

基于 LangGraph.js 与 Rulora，分析企业应收缩、维持还是拓展经营，再选择完整行动方案。
包含两层五席、受控披露、有界交换、受限 Reviewer、模型调用检查点和本地控制台。
开源版本为 Alpha，控制测试不证明业务建议准确；效果需要独立标注评估。

## 从最小群体到完整系统

主仓库根目录运行：

```bash
node examples/collective-decision/examples/controlled-collective.js
```

直接调用 Core：未知证据拒绝，一席修订后接受，另一席达到预算后停止；
合格候选被冻结，Reviewer 无法创造新 ID。

完整系统使用 Node.js 22/24：

```bash
cd examples/collective-decision
npm ci
npm install --no-save --package-lock=false ../..
npm run example
npm run example:static
npm test
npm run privacy:check
```

虚构企业、模拟证据和脚本模型运行两次，断言报告一致，第二次不重复调用成功节点。
产物位于 examples/output/enterprise-collective/demo-summary.json。

## 控制流程

```text
证据与快照校验 → 来源门禁
  → 第一层五席独立判断 → 有界交换（最多 6 轮）→ 方向冻结
  → 第二层五席行动方案 → 有界交换（最多 10 轮）
  → 选择已有完整候选 → 契约门禁 → 报告 / 检查点
  └─ 失败 → 有界修订、补证或等待人工
```

- LLM：理解证据、独立判断与候选选择。
- Program：状态、合同、统计、预算、候选池、门禁和最终结果。
- Recovery：修复 JSON / Markdown 载体，不补造业务答案。
- Adapter：允许的别名与确定性转换，不改变结论。
- Reviewer：只选择冻结候选，不拼装新答案。
- Loop：网络重连、约束修订与业务交换分别计数，有明确上限。
- Checkpoint：按输入及协议匹配复用成功调用，变化使旧结果失效。
- Improvement：客观反馈用于下一版本，不在运行中自改规则。

独立阶段不看同行结论，交换阶段收到受控信息，复核使用候选别名；这属于上下文控制。
最小群体调用 Core 的 OutputBoundary、LoopControl 和 CollectiveControl；
完整系统的专用合同、证据绑定、检查点与调度由场景代码实现。
默认运行无需 PostgreSQL。`pg-boss` 是可选依赖，仅在宿主主动配置 MonitorScheduler 时使用。

## 决策合同与交互

协议 5.3.0-action-object-boundaries；行动选项 3.0.0-object-boundaries。
方向 -1 / 0 / 1 表示收缩 / 维持 / 拓展；null 表示未决。
行动编号 1..13 为类别代码，不是评分；10 表示无法可靠建议，13 表示已有安排足够。
空数组不能自动转为 13。[合同细节](docs/COLLECTIVE-CONTRACT.md)。

```bash
npm run web
node src/cli.js demo --out-dir examples/output/my-demo
# 配置 Provider 后调用真实模型，可能产生费用：
node src/cli.js run --input my-enterprise-case.json --out-dir examples/output/my-case --live
```

输入包含企业、证据、日期与快照；可选 rules 与 experience 数组。未决退出码为 2。
页面面向本机使用，公网部署需配置认证、权限与持久化。

## 验证与许可

```bash
npm run example:controlled
npm run example:langgraph
npm run eval:reliability
npm run web:smoke
npm run pack:check
```

private: true 仅防止误发 npm，不影响源码公开。
[Apache-2.0](LICENSE) · [第三方许可](THIRD_PARTY.md)。
技术与商务合作：zzjeff1993.agent@gmail.com。
<p align="center"><img src="assets/contact/wechat-qr.jpg" width="200" alt="微信联系方式"></p>
