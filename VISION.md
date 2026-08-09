# Rulora Vision

Rulora 是一个面向可靠 AI Agent 的开源执行契约框架。它希望让 AI 应用从“依赖 Prompt
运气”走向可验证、可恢复、可复现的复杂任务执行。

它不以替代 OpenClaw、LangGraph、Mastra 或模型 SDK 为目标。流程图和工具编排回答“任务
如何连接”，Rulora 的执行契约回答“候选结果何时可接受、失败如何恢复、交付如何验证与复现”。

长期方向：

- 更完整的 ScenarioDefinition 与 JSON Schema 支持；
- 可替换的持久化、模型、渠道和质量门禁适配器；
- 工作流事件与审计日志；
- OpenClaw 集成示例；
- 由独立 Agent 项目实现真实任务，由 Rulora 主仓库维护公共契约和项目索引；
- 一个 Agent 可以通过任务路由承载多个共享底座的周期、行业和交付场景；
- 更多由社区验证、可运行且可交付的 Hybrid Agent。
