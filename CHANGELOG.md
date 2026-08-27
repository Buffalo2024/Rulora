# Changelog

本项目遵循语义化版本。当前处于 Alpha，`0.x` 版本可能调整接口。

## Unreleased

- 将项目收束为可嵌入现有 Agent 的流程、循环、输出边界与群体候选控制组件；
- 新增 `LoopControl`、`OutputBoundary` 和 `CollectiveControl`；
- 增加作者 Vibe Coding、项目成熟度与欢迎共同优化的公开说明；
- 新增 `recoverSession`，恢复宿主 Repository 检查点前验证场景、状态、分支、字段和证据不变量；
- 拒绝跨分支重复字段 ID，避免恢复时发生字段语义重解释；
- 增加控制器重启后继续执行、损坏检查点拒绝和跳过必填工作拒绝测试；
- 明确 Report Agent 的采集器可替换边界，并记录 GitHub 开源同步计划。

## 0.1.0-alpha.2 - 2026-08-09

- 发布 `@rulora/core` 到 npm 的公开 `alpha` 标签；
- 更新中英文安装说明，要求显式使用 `@rulora/core@alpha`；
- 将主页教学内容收束为一个 Core 示例，并将报告 Mock 迁入 `labs/`；
- 增加官方 Agent 生态和 Rulora Report Agent 预留位置。

- 统一更正 Hybrid 的历史错误拼写，公开类名改为 `HybridPipeline`；
- 增加 CommonJS 包的类型声明入口；
- 明确 Alpha 版本的已实现能力、扩展边界和图片 Mock 示例限制；
- 将主页收束为 Core 快速开始与官方 Agent 生态入口；
- 将受控诊断改为中性的“状态与所有权”Core 教学示例；
- 将两个报告 Mock 从正式示例迁入 `labs/`，等待未来进入 Rulora Report Agent；
- 在发布检查中阻止错误拼写和类型入口缺失再次进入发布包。

## 0.1.0-alpha.1 - 2026-08-04

- 建立 Rulora Core 和 Hybrid Pipeline；
- 提供受控诊断、原生报告生图和稳定生图复刻三个案例；
- 增加字段分支、无进展纠偏、Token 门禁、证据冻结和程序质量门禁；
- 增加带不可删除 `【共生纪 开源样例】` 标记的完整原生报告视觉 Prompt；
- 增加中英文 README、品牌资产和 GitHub 发布文件。
