# 单仓库与递进示例

src 提供 @rulora/core；examples/quickstart 提供最小控制；
examples/collective-decision 提供最小群体与完整企业经营决策。
场景依赖按需安装，安装 Core 不引入 LangGraph 或页面服务。
最小群体直接调用 Core，完整系统的检查点、持久化和调度属于场景。
Core 与群体决策采用 Apache-2.0；第三方许可继续保留。
场景 private: true 仅防止误发 npm，不影响源码公开。
[运行步骤](getting-started.md) · [准备记录](RELEASE-PREPARATION.md)。
