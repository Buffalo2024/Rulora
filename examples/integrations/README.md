# JSON Schema 接入

从主仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run example:schema
```

[完整程序](json-schema.js)编译 Ajv Schema 一次，将结构检查接入 `validateCore`，
将“证据编号属于本次输入”接入 `validateAudit`。两层都返回严格的 `true` 才接受。
程序验证正例、类型错误和未知引用三种结果。

`coerceTypes`、`useDefaults`、`removeAdditional` 全部关闭，验证器不改写候选。
错误对象使用独立快照，后续验证不会覆盖先前诊断。
JSON Schema 检查结构，不证明摘要与证据语义一致，业务验证由宿主追加。

Ajv 是本仓库的开发依赖，不是 Core 的运行依赖。接入自己的项目时：

```bash
npm install @rulora/core@alpha ajv
```

把程序中 `require('../../src')` 替换成 `require('@rulora/core')`，使用自己的 Schema、
原始模型响应和证据集合即可。不要把本演示的合成摘要当作真实分析结果。
