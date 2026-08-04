# Release checklist

## 已完成的发布身份配置

- [x] GitHub 用户名与仓库地址：`Buffalo2024/rulora`；
- [x] 合作与安全联系邮箱：`zzjeff1993.agent@gmail.com`；
- [x] README 已使用实际微信二维码；
- [x] `package.json` 已增加 `repository`、`homepage`、`bugs` 和 `author`；
- [ ] 确认 npm scope `@rulora` 可用，或改成实际可发布包名。

## 代码检查

- [ ] `npm test` 全部通过；
- [ ] 三个示例均能在没有 API Key 的情况下运行；
- [ ] `npm run release:check` 通过；
- [ ] `npm pack --dry-run` 只包含白名单文件；
- [ ] 不包含本地绝对路径、密钥、真实用户数据和无权分发的资产；
- [ ] `git diff --check` 无空白错误。

## GitHub 设置

- [ ] 仓库描述、Topics 和主页按 `REPOSITORY-METADATA.md` 填写；
- [ ] 使用 `assets/brand/rulora-logo-512.png` 作为头像或社交预览元素；
- [ ] 启用 Issues、Discussions 和安全漏洞私下报告；
- [ ] 保护 `main` 分支，并要求 CI 通过；
- [ ] 创建 `v0.1.0-alpha.1` Release，而不是直接标记 Stable。
