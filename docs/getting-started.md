# 快速开始

Core 支持 Node.js 20+；完整群体场景建议 Node.js 22/24。

## 最小控制

```bash
npm ci --ignore-scripts
npm test
npm run examples:quickstart
```

[最小控制源码](../examples/quickstart/README.md)演示输出验证、有界循环与候选冻结。
安装入口：`npm install @rulora/core@alpha`。发布版本以 npm registry 为准。

可选的结构集成：`npm run example:schema`。源码与接入方式见 [JSON Schema 示例](../examples/integrations/README.md)。

## 最小群体

```bash
node examples/collective-decision/examples/controlled-collective.js
```

直接调用 Core。未知证据拒绝、一席修订后接受、另一席达到失败预算后停止；
两份合格候选冻结，Reviewer 只能选择已有 ID。无需依赖安装或模型密钥。

## 完整系统

```bash
cd examples/collective-decision
npm ci
npm install --no-save --package-lock=false ../..
npm run example
npm run example:static
npm run web
```

虚构企业与脚本模型双次运行，验证报告一致和成功节点不重复调用。
真实模型准确性需要独立评估。
[预置输入输出](../examples/collective-decision/examples/fixtures/static/README.md)无需运行即可阅读；
[源码导航](../examples/collective-decision/docs/CODE-MAP.md)与[运行模式](../examples/collective-decision/docs/RUNNING-MODES.md)帮助深入。
[API](api.md) · [边界](guarantees.md) · [集成](integration.md)。
