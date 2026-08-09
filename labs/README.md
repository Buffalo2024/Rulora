# Rulora Labs

这里存放尚未达到正式发布标准的探索性实现。Lab 可以用于验证 Hybrid 工作流设计，但不
代表 Rulora Core 已经提供对应能力，也不代表已经发布的业务 Agent。

当前实验：

- [原生报告生图](native-image-report/README.md)：使用 Mock 图片 URI 和 Mock OCR 演示门禁顺序；
- [稳定生图复刻](stable-image-reproduction/README.md)：执行真实字符容量检查，图片融合和像素门禁仍为 Mock。

报告实验只有在具备真实渲染、证据约束、可复现交付和机器 QA 后，才会迁入独立的
Rulora Report Agent 项目。
