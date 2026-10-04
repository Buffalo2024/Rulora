# 什么时候使用 Rulora

如果已有 Agent 需要接受或拒绝候选输出、限制失败后的继续尝试，或者阻止复核环节改写候选，
可以在这些位置加入组件，无需搭建完整群体场景。

| 需求 | 组件 | 宿主仍要提供 |
| --- | --- | --- |
| JSON 结构与证据引用校验 | OutputBoundary | 解析器、Schema 与业务验证器 |
| 修订、网络重连或业务交换次数上限 | LoopControl | 调用、调度、取消与持久化 |
| 冻结候选，限制 Reviewer 选择范围 | CollectiveControl | 独立判断、候选质量校验、选择策略 |
| 字段、分支与证据回合的状态约束 | OrchestrationMachine | 业务合同、Repository 与访问策略 |

如果只需要一次返回文本，宿主自己的条件判断可能已足够。
如果需要图执行、数据库事务或任务队列，应使用对应工具，再在节点中加入 Rulora 的门禁。
Core 不代替这些基础设施。

企业经营行动编号、岗位和两层五席属于高级场景，不是使用 Core 的前置知识。
先看 [最小示例](../examples/quickstart/README.md)，需要结构验证时看 [JSON Schema 接入](../examples/integrations/README.md)。
