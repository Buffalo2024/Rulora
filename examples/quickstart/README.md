# 三个最小控制示例

从主仓库根目录执行，不需要模型或 API Key：

| 命令 | 文件 | 断言 |
| --- | --- | --- |
| npm run example:output | [输出验证](output-boundary/run.js) | 缺字段、未知证据拒绝 |
| npm run example:loop | [有界循环](bounded-loop/run.js) | 无进展转人工、停止后不能继续计数 |
| npm run example:candidates | [候选选择](candidate-selection/run.js) | 输入修改不污染冻结池、拒绝新造 ID、禁止改写候选 |

模型负责产生候选，代码示例用静态合成值替代模型；程序负责验证、冻结与停止。
所有断言进入 npm test。它们是控制行为演示，不是业务效果评估。
