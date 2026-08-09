# 状态机接口约定

模型不保存权威状态。宿主每回合按照以下顺序调用：

```text
getState
→ recordUserTurn
→ 模型提出候选字段
→ submitFields（有候选字段）或 recordNoProgress（无候选字段）
→ recordUsage
→ 根据程序动作继续、纠偏、转人工或冻结
```

状态机的关键结果：

- `accepted`：本回合被接受的字段；
- `rejected`：字段及程序拒绝原因；
- `missing`：当前分支仍缺失的字段；
- `nextQuestion`：进入下一分支时的起始问题；
- `action: correct`：本分支两次无进展，需要纠偏；
- `action: human_handoff`：纠偏后仍无进展，停止自动诊断；
- `readyForOutput`：全部分支完成，可以冻结。
