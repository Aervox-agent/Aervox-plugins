# 多风格日记与认知复盘

`ap-workflow-diary-distillers`，主分类 `workflow`。版本 `1.1.0`。

CAP-008 / CAP-017: `diary_list_styles` 已接入受信宿主运行时，返回真实风格清单与应用场景；需要 `diary.read` 授权，不依赖模型或配置，不读取记忆、日记正文或模板提示词。

`diary_generate_styled` 仍只有声明，当前没有执行 handler。生成可使用宿主已有 `styleId` 入口；配置默认值不会因安装而自动接入 Worker，清单查询也不构成生成完成。

## 安装与配置

通过宿主插件市场或 `.aervox-plugin` 预检后安装声明资源；受信 TypeScript/Vue 实现随宿主编译，声明包不会执行源码。配置以本目录 `config.schema.json`（若存在）和宿主界面为准。旧 `diary-distillers` 身份必须先停写并运行显式迁移工具，勿并行安装以猜测合并。

## 数据与隐私

配置、凭据、权限、业务数据由宿主管理；安装声明不等于外部服务已连接。外部连接仅在用户配置和授权后由对应宿主能力执行，缺包不删除数据，恢复代码不恢复已撤销授权。具体能力和已验证范围见宿主合同及测试。

当前执行代码要求同版 `1.1.0` Manifest 和宿主可选 catalog 端口；旧宿主缺端口时不贡献工具，停用、换版、缺包或撤权均拒绝调用。desktop/web/cli 声明不代表 mobile 已接入。

## 开发与许可

在宿主根冻结安装后执行集合 `lint-plugins.mjs`、对应 workspace 的 build/typecheck/test；声明包另经资源白名单和可重现构建检查。源码沿用 AGPL-3.0-or-later，参见 LICENSE。
