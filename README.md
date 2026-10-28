# Aervox-plugins

Aervox 第一方插件与界面集合，整体作为 [Aervox-harness](https://github.com/3yearsZhuang/Aervox-harness) 的 `plugins/` Git submodule 消费。各业务插件继续位于 `<id>/`，受信根界面位于 `surfaces/<id>/`，包名、公共入口、Manifest 和默认产品装配保持原有合同。

## 目录组成

- 业务与适配器插件：`anki-sync/`、`bot-onebot/`、`bot-weixin/`、`diary-distillers/`、`focus-mode/`、`health-guard/`、`home-assistant/`、`multimodal-ocr/`、`xiaomi-health/`
- 第一方 UI 根界面表面（Surfaces，遵循 [ADR-025](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-025-ui-surface-hosts.md)）：
  - `surfaces/companion-ui`: 桌面端常驻桌宠根界面 (`@aervox/plugin-companion-ui`)
  - `surfaces/panels-ui`: 宿主设置与管理面板集合 (`@aervox/plugin-panels-ui`)
  - `surfaces/proactive-ui`: 主动式伴学交互界面 (`@aervox/plugin-proactive-ui`)
  - `surfaces/workbench-ui`: 默认工作台根界面 (`@aervox/plugin-workbench-ui`)

## 开发与验证

本仓依赖宿主的公共包、根 TypeScript/Vitest 配置和统一锁文件，安装、构建、测试及声明包导出均在主仓根执行。它是源码集合，不是可独立安装的运行时或插件商店。

```bash
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
mise tasks run install
git -C plugins switch -c feat/my-plugin-change
mise exec -- pnpm exec turbo run build typecheck test --filter='./plugins/*'
mise tasks run package-plugins
```

插件源码 PR 先在本仓审查；主仓 PR 再更新固定 gitlink，验证宿主消费者与默认产品。未合并源码可在主仓 `plugins/` 检出并暂存对应 gitlink 后运行验证，不向主仓复制实现。主仓安装始终使用根依赖和锁文件，不在本仓或单个插件内重复安装。

接口与数据责任由主仓的 [ADR-016](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-016-base-boundaries.md)、[插件规范](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/plugin-config-and-pages.md)和 [host-plugin-api](https://github.com/3yearsZhuang/Aervox-harness/tree/main/packages/host-plugin-api) 定义。学习事实、仓储、复习排期和组合根保留在主仓；`focus-mode` 继续进入默认产品，Bot 适配器仍按现有生命周期装配。`.aervox-plugin` 继续只分发声明和允许资源。

集合 CI 将本仓精确提交装入固定的公开宿主基线，冻结安装后执行宿主全量门禁；结果记录宿主和集合的精确提交，不等于发布或真实平台验收。升级宿主基线经 PR 修改 CI 中的固定 SHA；手动验证兼容分支时可通过 `host_commit` 输入完整的公开宿主提交 SHA。

## 来源与许可

插件目录及提交历史从 Aervox-harness 的 `plugins/` 提取，冻结输入为 [`119dbf2067337153724830094fc304e096bfdf28`](https://github.com/3yearsZhuang/Aervox-harness/tree/119dbf2067337153724830094fc304e096bfdf28/plugins)，保留该路径的原作者与提交记录；更早跨目录移动的历史仍可从原仓追溯。源码继续采用 [AGPL-3.0-or-later](LICENSE)，本说明采用 [CC BY-NC-SA 4.0](LICENSE.docs)。具体文件已有的许可声明继续有效。
