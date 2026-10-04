# 嵌入现有 Agent

保留原有模型调用与框架，只在需要的位置加入组件。Rulora Core 不依赖 LangGraph 或特定供应商。

## 最小接入顺序

1. 宿主构造角色上下文并调用模型，保留原始响应与追踪 ID。
2. OutputBoundary 解析载体、执行显式 Adapter、验证结构与业务不变量。
3. 验证失败时由宿主记录 LoopControl；预算结束则停止并返回明确状态。
4. 群体候选先各自通过业务验证，再 freezeCandidates。
5. 将允许看到的候选内容交给 Reviewer；仅向 select 传入选中的 ID。
6. 宿主保存已接受结果并交付；失败、恢复、计费与外部副作用由宿主负责。

不要把 select 的“属于池”当作语义审查。不要把 LoopControl 的 progressed 参数直接信任为模型自评。

## LangGraph / OpenClaw

常见结构验证见 [JSON Schema 接入](../examples/integrations/README.md)。把 Schema 检查接到
validateCore，把引用、权限或业务约束接到 validateAudit；两层都通过后宿主才接收结果。

在现有图节点中调用这些接口，不需要替换图引擎。
[最小 LangGraph 教学图](../examples/collective-decision/examples/langgraph-governed-minimal.js)
是独立工程示例；[群体决策](../examples/collective-decision/README.md)展示完整场景，其中高级运行时在场景内。
[最小群体程序](../examples/collective-decision/examples/controlled-collective.js)直接调用本仓库 Core。
[OpenClaw 接入说明](OPENCLAW-INTEGRATION.md)描述宿主边界，不代表外部生态认证。

## 逐步提炼，避免重写稳定场景

先冻结现有测试输入，再实现小组件；比较输出、失败状态和调用次数；
先接入最小示例，再接入完整群体场景，逐项验证输出、停止状态与调用次数。
企业经营合同、五席职责和行动编号由场景定义。

完整系统的 [调用链导航](../examples/collective-decision/docs/CODE-MAP.md) 和
[运行模式](../examples/collective-decision/docs/RUNNING-MODES.md)解释程序与宿主的实际职责。
