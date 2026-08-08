# OpenClaw integration

Rulora 与 OpenClaw 解决不同问题：OpenClaw 提供会话、渠道、模型和工具运行环境；Rulora
提供业务工作流的确定性状态、证据、预算和质量门禁。

## 推荐结构

```text
用户渠道
  ↓
OpenClaw session / channel
  ↓
Rulora tool adapter
  ├─ getState
  ├─ recordUserTurn
  ├─ submitFields / recordNoProgress
  ├─ recordUsage
  └─ freeze
  ↓
Repository + downstream Hybrid pipeline
```

## 接入原则

1. 用 OpenClaw 的会话标识派生 Rulora `sessionKey`，每次工具调用都验证归属。
2. 把渠道输入视为不可信内容；先记录原始回合，再允许模型提出候选字段。
3. 工具返回值是模型唯一可依赖的权威状态，不把 Repository 直接暴露为模型工具。
4. 将文本和图片模型封装为 Provider Adapter，密钥只从宿主环境读取。
5. 每次模型请求结束后用唯一 `operationId` 记录 Token，避免重试造成重复计数。
6. 付费、订阅、访问次数和客服路由由宿主应用在进入 Rulora 前处理。
7. 人工接管后禁止继续自动提交字段，直到宿主显式创建或恢复合规会话。

## 最小工具返回值

工具应只向模型返回完成当前动作需要的信息：当前分支、缺失字段、接受或拒绝结果、下一问题、
纠偏或人工接管动作。不要返回 API Key、内部阈值、完整审计日志或其他用户数据。

## 首次消息

首次询问由程序根据用户已知信息与第一分支生成基础任务，再允许 LLM 做有限润色。用户不必先
输入一句话才能启动诊断；LLM 也不能擅自改变第一分支要确认的字段。
