# Anki 闪卡与外部题库同步器

`ap-tool-anki-sync`，主分类 `tool`。版本 `1.1.0`。

CAP-023: `anki_list_providers` 已接入受信宿主运行时，返回真实题库解析格式与扩展名；需要 `learning.read` 授权，不依赖 Anki endpoint、模型或配置。它不会导入卡片、安排复习或执行同步。

`anki_import_deck` 仍只有声明，当前没有执行 handler。CSV/TSV/JSON 文件导入可使用宿主已有题库入口；Anki MCP、OAuth、增量同步与冲突处理须分别配置和验收。

## 安装与配置

通过宿主插件市场或 `.aervox-plugin` 预检后安装声明资源；受信 TypeScript/Vue 实现随宿主编译，声明包不会执行源码。配置以本目录 `config.schema.json`（若存在）和宿主界面为准。旧 `anki-sync` 身份必须先停写并运行显式迁移工具，勿并行安装以猜测合并。

## 数据与隐私

配置、凭据、权限、业务数据由宿主管理；安装声明不等于外部服务已连接。外部连接仅在用户配置和授权后由对应宿主能力执行，缺包不删除数据，恢复代码不恢复已撤销授权。具体能力和已验证范围见宿主合同及测试。

当前执行代码要求同版 `1.1.0` Manifest 和宿主可选 catalog 端口；旧宿主缺端口时不贡献工具，停用、换版、缺包或撤权均拒绝调用。desktop/web/cli 声明不代表 mobile 已接入。

## 开发与许可

在宿主根冻结安装后执行集合 `lint-plugins.mjs`、对应 workspace 的 build/typecheck/test；声明包另经资源白名单和可重现构建检查。源码沿用 AGPL-3.0-or-later，参见 LICENSE。
