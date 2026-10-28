# Home Assistant 智能家居网关

`ap-tool-home-assistant`，主分类 `tool`。版本 `1.0.0`。

CAP-034: 联动本地 Home Assistant 智能家居，感知室内温湿度、环境照度与人体移动，支持智能灯光/开关设备控制与桌宠环境主动关怀。

## 安装与配置

通过宿主插件市场或 `.aervox-plugin` 预检后安装声明资源；受信 TypeScript/Vue 实现随宿主编译，声明包不会执行源码。配置以本目录 `config.schema.json`（若存在）和宿主界面为准。旧 `home-assistant` 身份必须先停写并运行显式迁移工具，勿并行安装以猜测合并。

## 数据与隐私

配置、凭据、权限、业务数据由宿主管理；安装声明不等于外部服务已连接。外部连接仅在用户配置和授权后由对应宿主能力执行，缺包不删除数据，恢复代码不恢复已撤销授权。具体能力和已验证范围见宿主合同及测试。

## 开发与许可

在宿主根冻结安装后执行集合 `lint-plugins.mjs`、对应 workspace 的 build/typecheck/test；声明包另经资源白名单和可重现构建检查。源码沿用 AGPL-3.0-or-later，参见 LICENSE。
