# 运行模式与依赖

| 模式 | 命令 | 模型费用 | 数据库 |
| --- | --- | --- | --- |
| 最小群体 | 主仓库运行最小群体 JS | 无 | 无 |
| 合成完整系统 | `npm run example` | 无，脚本 Provider | 无 |
| 固定样例核对 | `npm run example:static` | 无，脚本 Provider | 无 |
| 本地交互页面 | `npm run web` | 页面本身无；真实任务可能收费 | 默认无 |
| 真实模型 CLI | `node src/cli.js run --input my-case.json --out-dir output/my-run --live` | 取决于 Provider | 默认无 |
| PostgreSQL 调度 | 宿主配置 MonitorScheduler | 取决于处理器 | 需要 |

## 默认安装

在群体场景目录使用 Node.js 22/24：

```bash
npm ci --omit=optional
npm install --no-save --package-lock=false --omit=optional ../..
npm run example:static
```

`pg-boss` 属于可选依赖，默认决策不调用它。不使用队列可通过 omit=optional 跳过安装。
LangGraph 负责图路线；Ajv 负责合同结构；pdfjs-dist 与 cheerio 用于来源解析，运行合成示例不会采集外部数据。
这些是高级场景依赖，不是 Core 的运行依赖。

## 本地页面

`npm run web` 默认监听 127.0.0.1:4317。打开页面不代表已经连接模型或启动后台采集。
该页面提供任务和配置交互，用户应自行提供来源、模型和证据。
详情见 [源码导航](CODE-MAP.md)。

## 配置真实模型

复制 `config/model-profiles.example.json` 为被 Git 忽略的 `config/model-profiles.local.json`，
替换模型名称和服务地址；通过各 profile 的 api_key_env 指定环境变量，密钥不写入文件。
随后执行 `npm run models:smoke -- --live`；该命令会调用配置的模型并可能产生费用。
实际调用会核对测试回执，失败时先修复配置，不绕过就绪门禁。

可设置 AGENT_MODEL_CONFIG 指定其他私有配置路径。
高级宿主也可通过 AGENT_PROVIDER_MODULE 加载自定义 Provider；需要满足 Provider 接口及企业调用接口。
CLI 的 my-case.json 是用户输入文件，应包含完整企业、证据与快照目录。
预置合成输入由 example:static 的临时目录驱动物化，不能当作已核验的真实业务材料。

本地输出使用 JSON Repository、运行事件和模型检查点。公网部署还需要宿主的认证、授权、
数据保存策略和并发处理；当前页面不是一键生产部署方案。

## 可选 PostgreSQL 调度

这是独立宿主能力，未自动接入 CLI 或页面主流程。

```bash
npm install --include=optional
```

宿主在私有环境提供 RULORA_DATABASE_URL，然后组装处理器：

```js
const { MonitorScheduler } = require('./src/monitor-scheduler')
const scheduler = new MonitorScheduler({ connectionString: process.env.RULORA_DATABASE_URL })
await scheduler.start()
await scheduler.registerHandlers({ runActiveDispatch, runPassiveCollection })
await scheduler.scheduleActiveDispatch('0 8 * * *', { timezone: 'Asia/Shanghai' })
// 宿主退出时：await scheduler.stop()
```

以上为宿主异步函数内部的组合示意，两个处理器由宿主实现，组件不会自动执行群体决策。
运行 npm test 不连接 PostgreSQL；本轮验证未包含真实数据库端到端测试。
