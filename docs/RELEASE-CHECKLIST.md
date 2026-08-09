# Release checklist

## 已完成的发布身份配置

- [x] GitHub 用户名与仓库地址：`Buffalo2024/rulora`；
- [x] 合作与安全联系邮箱：`zzjeff1993.agent@gmail.com`；
- [x] README 已使用实际微信二维码；
- [x] `package.json` 已增加 `repository`、`homepage`、`bugs` 和 `author`；
- [x] npm Organization `@rulora` 已创建，`jeffbuffalo` 为 Owner；
- [x] `@rulora/core@0.1.0-alpha.2` 已发布到公开 `alpha` 标签；
- [x] npm 账号已启用 2FA。

## 代码检查

- [x] `npm test` 全部通过；
- [x] Core 教学示例和两个 Lab 均能在没有 API Key 的情况下运行；
- [x] `npm run release:check` 通过；
- [x] `npm pack --dry-run` 只包含白名单文件；
- [x] 不包含本地绝对路径、密钥、真实用户数据和无权分发的资产；
- [x] `git diff --check` 无空白错误。

## GitHub 设置

- [x] 仓库描述、Topics 和主页已配置；
- [x] 仓库已配置品牌社交预览图；
- [x] Issues、Discussions 和安全策略已启用；
- [ ] 保护 `main` 分支，并要求 CI 通过；
- [ ] 创建与 npm 对应的 `v0.1.0-alpha.2` Pre-release。
