# Surfaces：第一方界面包的端归属

这里的界面包是工作区依赖（`@aervox/plugin-*`），不是 `plugins/` 下的清单插件；端归属以本表为准，
与 [`SPECIFICATION.md` §2.5](../SPECIFICATION.md) 的 `metadata.targets` 语义一致（`desktop` 桌面壳 ·
`mobile` Android APK · `web` 浏览器工作台 · `cli` 命令行宿主）。

| 包 | 端 | 说明 |
|---|---|---|
| `workbench-ui` | `desktop` `web` | 工作台（对话、学习、设置面板的宿主容器） |
| `panels-ui` | `desktop` `web` | 工作台设置/管理面板（MCP 预设、模型配置等） |
| `proactive-ui` | `mobile` `desktop` | 陪伴对话面：手机主界面与桌面陪伴共用同一表面 |
| `companion-ui` | `desktop` | 桌面桌宠/角色舞台（Live2D 等表现层） |

规则：

1. 某端"可用"仍以该端真实装配与验收为准；表中未列的端不保证渲染。
2. 新增界面包必须在本表登记端归属；端变化按 §2.5 的 SemVer 口径处理。
3. 手机设置面板（`apps/web` 的 NativeRuntimePanel）是宿主内建，不在此列。
