# Aervox-plugins 构成与开发规范

规范标识：`AVX-PLUG-002`。适用于 [Aervox-plugins](https://github.com/Aervox-agent/Aervox-plugins) 集合仓。

本文说明已交付的源码组织、声明资源和宿主内开发方式。运行时字段以宿主的 [Zod 契约](https://github.com/3yearsZhuang/Aervox-harness/blob/main/packages/contracts/src/plugin-config-schemas.ts)与[共享作者校验器](https://github.com/3yearsZhuang/Aervox-harness/blob/main/packages/contracts/src/plugin-validation.ts)为准，接口、安全和数据责任以 [AVX-PLUG-001](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/plugin-config-and-pages.md)、[ADR-025](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-025-ui-surface-hosts.md)及 [ADR-031](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-031-first-party-plugin-repositories.md)为准。本文不另建 Schema、安装或构建权威。

下文区分**机器强制**、**作者规则**和**未交付**；文档、测试或仓库分离本身不代表产品或发布验收完成。

## 1. 集合仓与持久身份

集合仓整体作为宿主 `plugins/` 的必需 Git 子模块，由主仓 gitlink 固定确定提交。仓根结构如下：

```text
Aervox-plugins/
├── .github/workflows/ci.yml
├── README.md
├── SPECIFICATION.md
├── LICENSE
├── LICENSE.docs
├── scripts/                       # 集合覆盖与文档检查
├── vitest.shared.ts               # 转发宿主共享测试配置
├── anki-sync/
├── bot-onebot/
├── bot-weixin/
├── diary-distillers/
├── focus-mode/
├── health-guard/
├── home-assistant/
├── multimodal-ocr/
├── xiaomi-health/
└── surfaces/
    ├── companion-ui/
    ├── panels-ui/
    ├── proactive-ui/
    └── workbench-ui/
```

**作者规则**：业务插件继续位于集合仓 `<id>/`，宿主路径为 `plugins/<id>/`；受信界面位于集合仓 `surfaces/<id>/`，宿主路径为 `plugins/surfaces/<id>/`。仓根的治理文件不属于某个插件。当前没有集合仓独立的安装锁文件或构建工作区。

保留 `focus-mode`、`bot-weixin` 等现有插件 ID、包名、公共入口和默认产品组成，不为分类或版本发布批量重命名。Plugin ID 是配置、凭据、授权和资源关联的持久身份；版本变化不改变 ID。改用新 ID 会被识别为另一个插件，宿主不会自动迁移原身份的数据与授权。

**机器强制**：Manifest 的 ID 长度为 1–128；共享作者校验要求安全的小写标识，可含数字、点、下划线和短横线，并拒绝保留键。没有统一 `ap-` 前缀要求，也没有强制的七分类字段。新插件的 ID 应唯一、稳定；名称与文件规则详见运行时事实源。

## 2. 接入形态与责任边界

| 形态 | 当前载体 | 执行与分发边界 |
|---|---|---|
| 声明式插件 | Manifest、Config、Skill、Page、工具元数据及主动规则 | `.aervox-plugin` 安装登记声明与允许资源，不加载任意服务端源码 |
| 第一方业务或 Bot 扩展 | `<id>/src/` 与对应 workspace 包 | 宿主组合根显式装配的受信代码，随宿主编译 |
| 第一方界面扩展 | 插件 Vue 组件与公共 UI 接口 | 随宿主编译，不等于第三方 Page 沙箱 |
| 根界面与设置面板 | `surfaces/<id>/` 与 `@aervox/plugin-*-ui` 包 | 使用受信 `UISurfaceManifest`，不生成声明式分发包或通过市场开关裁掉默认产品 |

学习事实、仓储、复习排期、模型调用、执行账本、授权、取消、幂等、凭据和数据权利继续由宿主负责。插件通过公共接口贡献能力，不直接依赖数据库或宿主私有实现，不复制 DTO 或另建业务数据真源。

Manifest 只登记工具描述与参数模式；实际调用需要受信宿主显式登记 handler，并验证执行权限和审批链。工具 ID 自动加 `<pluginId>.` 前缀，工具 `name` 不自动改名，作者仍须保证名称唯一。Manifest 的安全等级也不等于完整的会话执行等级映射。MCP 使用独立的连接、凭据和授权流程，引用 MCP 或编写 Skill 不会自动取得这些权限。

## 3. 源码工程与声明包

源码插件按其接入形态维护声明、配置、技能、源码及必要测试。声明式插件使用 `plugin.manifest.json`；受信 surfaces 使用自己的界面清单，不要求伪造同名声明包 Manifest。`package.json`、`src/`、`test/` 是构建载体，不能因迁仓解释为可动态安装执行的代码。

**机器强制**：声明包是标准 ZIP，文件直接位于归档根，不再包一层插件目录。当前允许的资源仅为：

- 根文件：`plugin.manifest.json` 或兼容的 `manifest.json`，二者不能同时出现；另有 `config.schema.json`、`SKILL.md`、`skill.md`。
- 目录资源：`skills/` 与 `pages/`；所有声明入口必须存在并通过路径及资源校验，Page 资源须对应已声明的 Page。

`src/`、`dist/`、`node_modules/`、`test/` 等已登记本地载体不进入分发包。其他文件按宿主[实际分类清单](https://github.com/3yearsZhuang/Aervox-harness/blob/main/scripts/export-plugins.mjs)处理；未知条目拒绝打包，不是自动忽略。

集合仓根已有源码许可证和文档许可证。单插件新增 `LICENSE`、`NOTICE`、`CHANGELOG.md` 或根图标时，当前分类器不会自动允许或排除它们；必须先审阅相应分发责任、合同和回归，不能为通过打包删除必需许可材料。不得假定 `icon.svg`、`icon.png` 已列入根资源允许清单，也不强制每个现有插件增加尚未分类的文件。

**作者规则**：禁止路径逃逸、符号链接、硬链接、凭据或未知工程文件进入声明资源。源码采集、归档预检和 BundleStore 文件访问各有具体检查边界，不能将其中一路检查泛化为全部路径均有相同保障。具体文件防护及尚未闭合的并发边界见宿主开发规范。

归档处理器限制压缩包 20 MiB、展开总量 50 MiB、单条目 5 MiB、最多 2048 条目，并拒绝不安全和重复路径。HTTP JSON 请求体另有 20 MiB 上限，包含 Base64 开销；它不代表 20 MiB 原始 ZIP 均可上传。

## 4. 可验证的最小声明示例

下面两份文件共同组成一个仅演示配置的 Bundle。`example-tool` 是示例身份，不要求重命名任何现有插件；此例没有工具执行、Skill 或 Page 贡献。完整字段、数量和入口约束以宿主契约与作者校验器为准。

<!-- aervox-bundle-file: plugin.manifest.json -->

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
  "requires": {
    "hostApiVersion": {
      "min": "1.0.0",
      "maxExclusive": "2.0.0"
    }
  },
  "metadata": {
    "id": "example-tool",
    "displayName": "配置示例",
    "publisher": "example-author",
    "version": "1.0.0",
    "description": "演示普通配置与凭据字段声明"
  },
  "spec": {
    "config": {
      "schemaVersion": 1,
      "entry": "config.schema.json"
    }
  }
}
```

<!-- aervox-bundle-file: config.schema.json -->

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [
    {
      "key": "message",
      "type": "string",
      "label": "提示",
      "default": "你好"
    },
    {
      "key": "apiKey",
      "type": "secret",
      "label": "服务凭据"
    }
  ]
}
```

Config 使用 Aervox DSL，不是任意 JSON Schema。数值约束使用 `min/max`；Secret 禁止默认值。顶层字段最多 200 个，嵌套深度最多 5。选择项、对象与数组必须满足共享作者校验；顶层 Secret 是现行保存与状态回显的作者规则，不应擅自推广到嵌套 Secret。

Manifest 当前不接受 `metadata.category`、`metadata.tags` 或 `metadata.breaking`。分类和发布说明不能借这些未知字段写入可安装包。

## 5. Skill、Page 与安全边界

Skill 名称匹配 `/^(?!\.{1,2}$)[\w.-]+$/`，不能包含冒号。默认根技能使用 pluginId；辅助技能应使用可通过校验的唯一名称，例如带插件名前缀和短横线的名称。

`spec.skills[]` 可以声明文件 `entry` 或 inline `content`，同时提供时优先读取 `entry`；`spec.skill` 优先于根 `SKILL.md`/`skill.md` 回退。传统 `skills/<name>/SKILL.md` 按确定顺序发现，显式引用的文件不重复登记。Bundle Skill 的解析不强制 front matter；描述可以来自显式声明、front matter 或实际回退规则。不要把独立 Skill 包的作者要求混同为所有 Bundle 的机器门禁，也不要假定技能目录内任意脚本会自动安装或执行。

Page ID 允许大小写字母、数字、下划线与短横线，最长 64。入口必须位于自己的 `pages/<page-id>/` 下并为 `.html` 或 `.htm`；`index.html` 是推荐布局，不是唯一可用文件名。Page capability 当前只有 `config.read`、`config.write`、`host.notify`、`host.close`。

Page 通过受限 iframe 与宿主 Bridge 交互，配置操作仍经过启用状态、权限、代际与 revision 检查。网络 CSP 不等于任意代码安全：完整 Token 资源通道、全部资源原子发布、跨窗口实时撤权、CPU/内存配额和运行中代码强制终止仍未完全交付。页面不能把 Token 放入 URL，也不能为访问资源关闭生产认证。开发和发布前阅读宿主[Page 当前限制](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/plugin-config-and-pages.md)。

## 6. 版本、升级与用户数据

Plugin ID、发布版本、Config `schemaVersion`、声明包 Host API 与根界面 `apiVersion` 分别管理。改变版本号或资源文件名不能改变持久身份，声明包兼容区间也不能替代第一方源码的实际编译与宿主合同测试。

**作者规则**：新发布宜使用可比较的 SemVer，并说明接口、权限、配置及数据变化；破坏性变化必须评审兼容、迁移和回退方案。当前没有根据上一版本自动识别所有破坏变化并强制升级 MAJOR 的 CI，版本号本身不授予迁移或扩大权限的授权。历史非 SemVer 发布标签可能无法排序，宿主不会据此猜测新旧。

**机器强制**：`requires.hostApiVersion` 使用完整稳定版本的半开区间，当前宿主声明包 API 为 `1.0.0`。旧包省略时采用 v1 默认区间；预发布版本可用于发布标签，但兼容区间边界不接受预发布。完整语义见[版本实现](https://github.com/3yearsZhuang/Aervox-harness/blob/main/packages/contracts/src/plugin-compatibility.ts)。

同 ID 覆盖安装通过资源 generation 准备与 SQLite 短事务激活，保留用户启停、配置、Secret 和授权记录。新增顶层字段补默认值，移除字段保留到 `orphanedValues`；不兼容类型或约束变化拒绝自动激活。当前没有通用复杂配置迁移器、运行失败后的自动降级或旧 generation 自动回收。已安装 generation 的导出返回保留的原包字节，不包含用户配置和 Secret。

普通 Config Secret 的 API 只回显配置状态，但当前默认 SQLite 实现直接存值，不提供默认静态加密或 OS Keychain 保证。Bot 连接凭据遵循独立的宿主凭据合同，不能将其实现泛化为所有插件 Secret 已加密。

缺包、停用、撤权和显式卸载是不同操作。恢复代码不会恢复被撤销授权；缺包不应清除配置、Secret、授权历史或业务数据。Git 回退恢复已验收的插件 gitlink、配对根锁及兼容宿主，不回滚用户数据库或悄悄执行配置降级。

## 7. 开发、CI 与分发

从[开发入口](README.md#开发与验证)进入宿主工作区，按宿主工具链和根锁冻结安装，不在集合仓或单插件目录另行安装。代码在 `feat/`、`fix/` 或 `docs/` 分支经 PR 审查。

在已准备依赖和必要参考夹具的宿主根，按变更范围运行：

```bash
mise exec -- node --test plugins/scripts/check-host-workspaces.test.mjs
mise exec -- node plugins/scripts/check-host-workspaces.mjs
mise exec -- markdownlint-cli2 --config .markdownlint-cli2.jsonc 'plugins/README.md' 'plugins/SPECIFICATION.md'
mise exec -- pnpm --filter @aervox/contracts build
mise exec -- node --test plugins/scripts/check-docs.test.mjs
mise exec -- node plugins/scripts/check-docs.mjs
mise exec -- pnpm exec turbo run build typecheck test --filter='./plugins/*' --filter='./plugins/surfaces/*'
mise tasks run package-plugins
./aervox ci all
```

集合覆盖检查从受跟踪 Manifest 发现源码包，并核对宿主真实 workspace 和 Turbo 构建、类型检查、测试任务，防止嵌套 surfaces 被遗漏。文档检查使用宿主共享校验器验证标记的示例资源，并检查文档本地链接；它不验证业务功能或外部服务。

[集合 CI](.github/workflows/ci.yml)把当前集合提交挂入固定公开宿主 SHA，在宿主根冻结安装，执行集合检查、宿主全量门禁和依赖审计。检查结果须保留宿主与集合的精确提交；一个固定基线的绿测不证明兼容所有宿主版本、真实平台或正式发布。

依赖输入变化时，插件候选 SHA 与宿主集成提交的 gitlink、根锁必须配对验证。先合入插件 PR，再把宿主 gitlink 固定到插件最终合并 SHA，核对文件树与依赖输入并复验消费者，最后合入宿主 PR。不要使用非冻结安装掩盖不兼容，也不向两个仓库的 `main` 直接提交。

`mise tasks run package-plugins` 生成 `dist/plugins/<id>-<version>.aervox-plugin`，先运行共享作者校验，再按固定 DOS 纪元时间戳和排序资源打包，保证该构建期导出入口的可重现性。此保证不能推广为所有 HTTP、市场或历史兼容导出都会重新产生同一归档。`dist/plugins/` 是生成目录，冷检出后按任务恢复，不依赖手工保留产物。

## 8. 当前市场与未交付事项

`GET /v1/plugins/market` 当前扫描本地出厂插件目录；就地安装从该目录收集声明资源并走安装验证。更新提示比较版本字符串是否不同，不是完整 SemVer 新旧决策。

远程 `registry/catalog.json` 客户端直读、分类目录改造、逐插件 Tag 自动 Release、发布者签名认证、外部依赖解析与自动破坏性变更识别均未在此规范中交付。现有预检报告的 `signature` 为 `null`；SHA-256 是内容校验和，不是发布者身份认证。任何后续工作都须另行实现、测试和评审，不能通过本文件先行改变权限、数据责任或源码组织。

声明校验通过只证明已执行的静态检查通过，不代表资源引用全部可运行、外部账号连接成功、业务效果成立或安全发布。接口、配额和剩余限制随宿主合同维护，避免在集合仓再建立一套漂移的运行时说明。

本文档沿用 [LICENSE.docs](LICENSE.docs) 的 CC BY-NC-SA 4.0 许可；源码及第三方材料继续遵守 [LICENSE](LICENSE) 和各文件已有声明，不因本文改变代码许可。
