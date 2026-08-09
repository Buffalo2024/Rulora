# GitHub open-source update record

本文件记录采用“执行契约框架”定位后，GitHub 开源前必须同步的内容。它是发布记录，
不是对已经完成远程设置的声明。

## 已在本地完成

- 中英文 README 首页改为 execution-contract 定位；
- 明确概率模型与确定性程序的 Hybrid 责任边界；
- Core 增加 `recoverSession`，恢复前校验场景、分支、状态和字段证据；
- 增加“控制器中断后恢复并继续”以及损坏检查点拒绝测试；
- 修正架构、Vision、Agent 生态和 npm package 描述；
- Report Agent 明确采集器属于可替换前置，Rulora 从 Research Packet 开始承担责任。

## GitHub 远程设置

1. Description：`Open-source execution contracts for reliable AI agents through Hybrid model-program cooperation.`
2. Topics：`ai-agents`、`execution-contract`、`reliable-agents`、`llm`、`workflow`、
   `state-machine`、`structured-output`、`human-in-the-loop`、`openclaw`、`hybrid`。
3. About/Homepage、社交预览图和联系方式保持现有配置。
4. `main` 启用分支保护，并要求测试和发布安全检查通过。

## 发布顺序

1. 审查工作树，只提交本轮相关文件，不覆盖用户已有修改；
2. 运行 `npm test`、示例、Labs、`release:check`、`pack:check`；
3. 更新 Changelog 与版本号；
4. 推送主仓库并确认 GitHub Actions；
5. 发布 npm Alpha；
6. 创建同版本 GitHub Pre-release；
7. Report Agent 独立仓库通过自身全审计后发布，再回填主仓库链接。

## 不得宣传为已实现

- Rulora Core 不内置网页采集、模型供应商或图片供应商；
- Core 目前不附带持久化数据库、跨进程锁、自动重试调度和生产级可观测性；
- “可恢复”指从宿主 Repository 的合法检查点继续，不代表已经提供分布式容灾；
- “可复现”必须由具体 Agent 的输入哈希、模板版本和自动测试证明，不能仅靠 Core 口号。

## 2026-08-09 本地最终审查

- Core：13 项自动测试通过；教学示例、两个 Lab、发布安全检查、隔离缓存打包检查通过；
- Report Agent：27 项测试、契约审计、容量极限、复现和全链路模拟审计全部通过；
- `git diff --check`：两个项目均通过；
- npm 默认缓存存在本机历史权限问题，使用隔离缓存后打包成功，不属于仓库代码故障；
- 尚未执行远程 GitHub 推送、仓库设置修改、版本升级或 npm 再发布。
