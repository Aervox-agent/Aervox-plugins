# Aervox-plugins 构成规范与文件结构标准

规范标识：`AVX-PLUG-002`。适用目标：[Aervox-plugins 官方生态仓库](https://github.com/Aervox-agent/Aervox-plugins)。本文规定生态目标和实现约束，沿用原 #2 的命名、分类、文件组织、版本、Registry 和发布门禁设计。接口和数据责任以配对宿主的 [AVX-PLUG-001](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/plugin-config-and-pages.md) 与 [ADR-031](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-031-first-party-plugin-repositories.md) 为准，字段由宿主 Contracts 及共享作者校验器执行。

本标准不将旧实现能力当成设计上限。实现、自动验证、真实服务连接与正式发布分别验收；本仓提交规范和工作流不等于已经生成首个公开 Release。

## 1. 核心设计：身份、演进与分发正交

| 维度 | 标准 | 责任 |
|---|---|---|
| 持久身份 | `ap-<category>-<slug>` | 插件整个生命周期保持不变，绑定配置、凭据、授权、资源和业务关联 |
| 演进与兼容 | SemVer `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]` | 描述接口、权限、配置和兼容变化；版本不拼入持久身份 |
| 分发资产 | `<plugin-id>-v<version>.aervox-plugin` | 对应不可变发布，附 SHA-256 校验和；不携带用户配置和凭据 |

改变分类或版本不能暗中创建第二个持久身份。主分类在首次建立身份时选定并冻结；后续新增能力使用 `tags` 和能力声明表达。确需改身份时，只能通过显式迁移流程，不能注册多个可互换 ID 来绕过授权或安装判据。

普通插件 Secret 的 API 仅回显配置状态，现有 SQLite 适配器并不因此获得默认静态加密保证。凭据具体存储保护由宿主合同负责，不把设计中的安全要求写成未经验证的加密事实。

## 2. 命名、分类与版本

### 2.1 Plugin ID

官方集合的新增或迁移后 ID 必须为 `ap-<category>-<slug>`，长度不超过 64，仅使用小写字母、数字和连字符；`slug` 使用可辨认的 kebab-case，不能带版本或破坏性标记。例：`ap-tool-anki-sync`、`ap-bot-weixin`、`ap-ui-focus-mode`。

共享运行时兼容读取历史 v1 Bundle，并不使旧命名满足官方集合标准。集合命名门禁严格执行新命名；现有用户安装通过第 6 节的一次性显式迁移接续。

### 2.2 七类能力

| 分类 | 范围 | 载体示例 |
|---|---|---|
| `tool` | 外部服务调用、本地受控工具 | Tool 描述、受信 handler、MCP 引用 |
| `bot` | IM 和通信渠道接入 | 平台传输适配器、连接状态 |
| `ui` | 界面、工作台卡片和扩展 | 受信 UI 插槽、受限 Page |
| `proactive` | 主动智能规则和感知 | sensors、triggers 与宿主授权 |
| `sync` | 外部知识或设备数据同步 | 导入导出、同步适配器 |
| `workflow` | 多步骤结构化工作流 | 技能组合、受控工作流 |
| `theme` | 皮肤、音效和表现 | 经允许清单审查的声明资源 |

目录一律使用单数分类名，修正原稿 `tool/tools`、`bot/bots` 混用。一个插件选择一个主分类；复合能力通过 `metadata.tags`、tools、skills、pages 和主动声明表达。分类不授予任何权限，也不允许第三方动态执行 TypeScript/Vue。

### 2.3 SemVer 与破坏性变更

- 破坏性变化必须递增 MAJOR，并在 `metadata.breaking`、`CHANGELOG.md` 和提交说明标出 `[BREAKING]`。包括删除或改名配置字段、字段类型或约束收紧、工具移除/必需参数变化、不兼容宿主要求和业务持久化合同变化。
- 向后兼容的能力新增递增 MINOR。
- 不改变公共合同的修复递增 PATCH。

共享比较器实际检查 Manifest、Config 与工具参数 Schema 的结构变化，CI 对上一发布快照及 PR 基线执行检查。它无法推断任意源码逻辑或业务语义，作者仍须申报无法静态识别的破坏变化；显式 `breaking=true` 同样触发 MAJOR 要求。不能因检测器未报警而宣称任意改动均兼容。

Git Tag 为 `<plugin-id>@v<version>`；Release 资产为 `<plugin-id>-v<version>.aervox-plugin`，附同名 `.sha256`。例如 `ap-bot-weixin@v2.0.0-rc.1` 对应 `ap-bot-weixin-v2.0.0-rc.1.aervox-plugin`；预发布通道已包含在 SemVer 中，不再重复追加。

### 2.4 内部名称

Tool `name` 使用 `<slug>_<action>`，全局名称须唯一；宿主对工具 **ID** 自动加 `<plugin-id>.` 命名空间，并不自动重命名 `name`。实际 handler 和执行权限由宿主注册并校验。

默认 Skill 名称为 pluginId，辅助技能使用 `<plugin-id>:<sub-skill>`。逻辑名称与磁盘目录分开，共享编码函数将冒号编码为 `%3A`，避免 Windows 路径问题；Manifest 命名空间必须匹配归属插件。Page ID 推荐小写 kebab/snake，运行时仍兼容历史大小写；入口位于对应 `pages/<page-id>/`。Config Key 使用 camelCase。

## 3. 文件组织与分发

### 3.1 集合仓布局

```text
Aervox-plugins/
├── .github/workflows/
│   ├── ci.yml
│   ├── release-plugin.yml
│   └── generate-registry.yml
├── SPECIFICATION.md
├── README.md
├── LICENSE
├── LICENSE.docs
├── registry/
│   ├── catalog.json
│   └── plugins/<plugin-id>.json
├── templates/
│   ├── basic-tool/
│   ├── ui-page/
│   └── proactive-sensor/
├── plugins/
│   ├── tool/anki-sync/
│   ├── bot/weixin/
│   ├── ui/focus-mode/
│   ├── proactive/health-guard/
│   ├── sync/xiaomi-health/
│   ├── workflow/diary-distillers/
│   └── theme/
├── surfaces/
│   ├── companion-ui/
│   ├── panels-ui/
│   ├── proactive-ui/
│   └── workbench-ui/
└── scripts/
    ├── lint-plugins.mjs
    ├── pack-plugin.mjs
    └── build-registry.mjs
```

集合整体仍由一个宿主 `plugins` gitlink 固定，所以实际源码路径为宿主 `plugins/plugins/<category>/<slug>/`。受信根界面继续在集合 `surfaces/<id>/`，遵循 ADR-025；不是需要伪造 PluginManifest 的声明式包。原 workspace 包名、exports 和默认产品组成保持，源码目录调整不改变宿主的数据所有权。

本阶段沿用宿主根 `pnpm-workspace.yaml`、依赖锁和 mise 工具链作为安装/构建权威；集合不另建第二锁。模板初始化工具或独立 SDK 的未来配置不能绕过宿主根冻结安装。规范原图中的仓根 package/workspace 只表达治理承载需求，不要求复制一套产品依赖。

### 3.2 单插件源码

每个 `plugins/<category>/<slug>/` 必须有 `plugin.manifest.json`、`README.md`、`LICENSE`、`CHANGELOG.md` 与必要 `test/`；README 说明功能、安装、配置与数据流向。已有源码沿用 AGPL-3.0-or-later，不能通过迁目录擅改 MIT/Apache。`icon.svg` 或 `icon.png` 推荐 1:1、128 像素、100 KB 以内。

`config.schema.json`、`SKILL.md`、`skills/`、`pages/` 按声明选配；受信源码在 `src/`，对应 workspace 包可有 `package.json` 和本地编译配置。源码与测试不能进入声明包。

### 3.3 Bundle

`.aervox-plugin` 是根目录直接展开的 ZIP，无额外顶层文件夹。允许根 Manifest（`plugin.manifest.json` 或兼容 `manifest.json`，不能同时有两份）、Config、根 Skill、图标和许可/变更材料，及 `skills/**`、`pages/**`。所有声明入口须存在；Page 资源须对应声明 Page。

`src/`、`test/`、`tests/`、`node_modules/`、`dist/`、工程配置和 Git 元数据按明确本地角色排除；未知条目拒绝打包。不得默默忽略新资源，也不得为通过打包删除必要许可。符号链接、多硬链接、路径逃逸与凭据不得进入声明资源。

压缩包最多 20 MiB，展开最多 50 MiB，单条目最多 5 MiB，最多 2048 条目。HTTP Base64 请求另受请求体上限约束。打包器排序资源，固定 DOS 纪元 `1980-01-01 00:00:00`，两次独立输出的字节与 SHA-256 必须一致；原始已安装 generation 导出仍保留历史包字节，不重写成当前构建产物。

## 4. 清单、配置与 Page

下面三份文件构成可由配对宿主真实校验器验证的完整 Bundle。本批声明包 Host API 为 1.1.0，新增官方包声明 `>=1.1.0 <2.0.0`；旧 v1 包的默认 `[1.0.0, 2.0.0)` 仍兼容读取。Metadata 新增 category/tags/breaking，不通过忽略未知字段假装成功。

<!-- aervox-bundle-file: plugin.manifest.json -->

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginManifest",
  "requires": {
    "hostApiVersion": { "min": "1.1.0", "maxExclusive": "2.0.0" }
  },
  "metadata": {
    "id": "ap-ui-example",
    "displayName": "配置页面示例",
    "publisher": "example-author",
    "version": "1.0.0",
    "category": "ui",
    "tags": ["settings"],
    "breaking": false,
    "license": "AGPL-3.0-or-later"
  },
  "spec": {
    "config": { "schemaVersion": 1, "entry": "config.schema.json" },
    "pages": [{
      "id": "settings",
      "title": "配置",
      "entry": "pages/settings/index.html",
      "capabilities": ["config.read", "host.close"]
    }]
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
    { "key": "message", "type": "string", "label": "提示", "default": "你好" },
    { "key": "apiKey", "type": "secret", "label": "服务凭据" }
  ]
}
```

<!-- aervox-bundle-file: pages/settings/index.html -->

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>配置示例</title>
<body>
<p>通过宿主 Bridge 读取配置；完整交互模板见 templates/ui-page。</p>
<script src="/v1/plugin-pages/bridge.js"></script>
</body>
</html>
```

Config 使用 Aervox DSL，字段包含 string/text/integer/number/boolean/select/multi_select/object/array/secret。数值约束为 min/max，字符串为 minLength/maxLength/pattern；Secret 不设默认值并按顶层作者规则保存，API 不回显明文。顶层最多 200 字段、嵌套最多 5 层；不是任意 JSON Schema。

Page 运行在受限 iframe，禁止 `allow-same-origin`，网络 CSP 使用 `connect-src 'none'`。通过 `window.AervoxPluginPageBridge` 调用 config.read/config.write/host.notify/host.close，仍须启用、权限、代际和 revision 检查。Token 资源通道、实时撤权与全部执行配额的剩余验收沿宿主既有计划维护；本标准不将这些声明当成完整 OS 沙箱或额外执行授权。

## 5. Registry、Release 与门禁

### 5.1 索引合同

`registry/catalog.json` 是版本 1 的已发布插件目录。每项包含 id、displayName、category、latestVersion、description、publisher、可选 icon/tags/license、breaking、requires.hostApiVersion、downloadUrl、sha256 和 size；能力摘要供界面展示。`registry/plugins/<id>.json` 保存各版本 Tag、下载 URL、校验和、体积和不可变 Manifest/Config 快照，用于兼容审计。

目录只收录已存在并重验的 Release 附件。未发布时目录为空，不构造看似可下载的虚假 URL/checksum。生成器校验 Tag、资产名、真实 SHA-256、体积、Bundle 和历史版本一致性；同版本附件不能覆盖。稳定版优先作为 latest，预发布通道不自动压过稳定版。

宿主通过官方 HTTPS Registry 获取目录，前端市场支持七分类检索和版本提示；下载必须重新校验大小、SHA-256、插件 ID、版本、Host API 和完整 Bundle，再进入既有原子安装流程。破坏性升级须明确确认，校验和证明内容一致，不证明发布者身份签名。市场元数据不能扩大权限或绕过受信代码装配。

### 5.2 自动发布

推送 `<plugin-id>@v<version>` 触发 `release-plugin.yml`：在固定宿主内冻结安装，执行标准和可重现门禁，Tag 必须与 Manifest ID/版本一致，Tag 所指提交必须已进入审查后的 main，然后生成 `.aervox-plugin` 与 `.sha256` 附件，拒绝覆盖既有 Release。预发布 SemVer 标为 GitHub prerelease。

`generate-registry.yml` 由发布或手动调度触发，从实际 Release 附件重验并生成索引，通过 PR 提交 registry 差量；不直接向 main 推送。GitHub 权限和仓库允许 Actions 创建 PR 的设置是运行前置，失败必须可见。工作流定义验证与真实首次发布分开记录。

### 5.3 CI 门禁

1. 命名与路径：ID、主分类及 `plugins/<category>/<slug>` 一致，拒绝重复身份。
2. 声明与资源：运行宿主真实共享作者校验器，检查完整 Manifest/Config/Skill/Page、必要源码文件和分发允许清单。
3. 可重现性：两次独立目录打包，逐字节及 SHA-256 相同。
4. 版本与破坏性：对比上一发布快照和 PR 基线，结构破坏或作者显式申报均须 MAJOR，变更记录标明 `[BREAKING]`。
5. 集成：真实 workspace/Turbo 任务覆盖、文档排版/示例/链接、宿主全量及依赖审计。

在宿主根运行：

```bash
mise tasks run native-toolchain-setup
mise exec -- pnpm exec turbo run build --filter=@aervox/host-runtime...
mise exec -- node --test plugins/scripts/ecosystem.test.mjs
mise exec -- node plugins/scripts/lint-plugins.mjs
mise exec -- node plugins/scripts/check-docs.mjs
mise exec -- node plugins/scripts/pack-plugin.mjs --id ap-tool-anki-sync
mise exec -- pnpm exec turbo run build typecheck test --filter='./plugins/plugins/*/*' --filter='./plugins/surfaces/*'
./aervox ci all
```

## 6. 现有身份迁移与两仓交付

九个旧插件分别映射到标准身份：anki-sync→ap-tool-anki-sync、bot-onebot→ap-bot-onebot、bot-weixin→ap-bot-weixin、diary-distillers→ap-workflow-diary-distillers、focus-mode→ap-ui-focus-mode、health-guard→ap-proactive-health-guard、home-assistant→ap-tool-home-assistant、multimodal-ocr→ap-tool-multimodal-ocr、xiaomi-health→ap-sync-xiaomi-health。

迁移须停写、备份，构建 staging 数据与资源，验证后原子切换，并保留回滚包。身份冲突、未知引用、缺资源或取消授权数据不一致应拒绝；不能只改 plugins 表、通过别名分叉门控、丢弃失败记录或覆盖目标 ID。工具实现和临时数据库回归不构成对用户业务库的迁移授权；实际运行另由用户明确发起。具体 CLI 与恢复步骤以宿主迁移合同为准。

插件仓候选与宿主根锁、workspace、发现器、授权/安装合同和 gitlink 必须配对验证。先发布可获取候选与宿主集成分支，集合 CI 固定该公开宿主 SHA；两仓检查通过后先合插件，再固定插件最终合并 SHA，核对文件树并复验宿主。学习事实、模型、执行账本、授权/取消、幂等/fencing、数据权利继续由宿主负责。

缺包、停用、撤权与卸载分别处理。回退源码不回滚用户数据库，不恢复已撤销授权。现有第一方代码仍随宿主受信编译；Release 声明包不能安装执行这些源码，也不将仓库分离算作真实 Bot、外部账号或正式产品验收。

本文档采用 [LICENSE.docs](LICENSE.docs) 的 CC BY-NC-SA 4.0；源码沿用 [LICENSE](LICENSE) 与已有第三方声明。
