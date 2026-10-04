# 发布检查

1. 安装依赖后运行 npm run verify:local。
2. 核对 Core 文件白名单、群体隐私检查、素材许可和候选冻结行为收紧。
3. 提交推送后等待 Node.js 矩阵 CI，核对 GitHub 展示与 Topics。
4. npm 发布前重新查询版本，alpha.4 被占用时换新版本。
5. 发布 alpha 后从空目录安装验证，不自动移动 latest。

群体 private 示例包防止误发 npm，源码仍可公开运行。
本地准备不表示已推送或发布。[记录](RELEASE-PREPARATION.md)。
