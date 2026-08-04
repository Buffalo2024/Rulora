# Local release artifacts

本目录在本地保留本次最终打包产物，压缩包本身不提交到 Git：

- `rulora-core-0.1.0-alpha.1.tgz`：用于 npm 安装和包内容检查；
- `rulora-0.1.0-alpha.1-source.tar.gz`：包含代码、案例、文档和发布材料的完整源码包。

正式公开发布时，应由相同 Git tag 的 CI 重新构建产物并生成校验值。

本地 SHA-256：

```text
414fc524cea6327b4c2dea208464866fc8fae213adb41b81cc82006e42224a73  rulora-core-0.1.0-alpha.1.tgz
69ce6947c74833c20ec07241d3f71010e4776a6ee19e17f0890418ea4d52ed88  rulora-0.1.0-alpha.1-source.tar.gz
```
