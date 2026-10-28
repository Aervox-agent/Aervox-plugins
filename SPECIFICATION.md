# Aervox-plugins 构成规范与文件结构标准

> 规范版本：`AVX-PLUG-002`  
> 关联主仓：[Aervox-harness](https://github.com/3yearsZhuang/Aervox-harness)  
> 适用目标：[Aervox-plugins 官方生态仓库](https://github.com/Aervox-agent/Aervox-plugins)

本文档为 Aervox 插件生态的权威构成规范，明确插件在命名标识、文件组织、配置与清单契约、破坏性变更演进、安全权限分级及集市（Marketplace）分发中的标准化要求。

---

## 1. 核心设计原则：三维正交解耦

在 Aervox 本地优先（Local-first）单用户架构中，持久化配置（`plugin_configs`）、加密凭据（`plugin_secrets`）、权限授权（`plugin_grants`）和代际目录指针（`bundle_generation`）均在本地 SQLite 数据库中以唯一标识作为不可变主键和外键关联。

若将动态变化的属性（例如“是否破坏性”和“版本号”）拼入插件 ID 或源码目录名，会导致版本迭代或破坏性升级时插件身份断裂，被宿主识别为全新插件，从而造成用户历史配置与授权彻底丢失。

因此，Aervox 插件生态采用**三维正交解耦方案**：

```text
┌────────────────────────────────────────────────────────┐
│ 1. 标识维（Plugin ID）: ap-<category>-<slug>           │  ← 不可变持久身份（数据库外键）
├────────────────────────────────────────────────────────┤
│ 2. 演进维（SemVer & Git Tag）: MAJOR.MINOR.PATCH       │  ← 破坏性与兼容性（语义版本）
├────────────────────────────────────────────────────────┤
│ 3. 分发维（Asset Filename）: <id>-v<version>...        │  ← 归档产物（Release 交付物）
└────────────────────────────────────────────────────────┘
```

1. **标识维（Plugin ID）**：全局唯一且生命周期内不可变，作为宿主存储、权限绑定与代码调用的唯一句柄。
2. **演进维（SemVer & Breaking Indicator）**：遵循 SemVer 2.0.0 规范，通过主版本号（`MAJOR`）递增明确破坏性，通过 Git Tag 与 Changelog 呈现兼容变化。
3. **分发维（Distribution Asset）**：`.aervox-plugin` 分发包携带版本与通道标签，作为最终交付物提供校验和（SHA-256）验证。

---

## 2. 命名规范体系

### 2.1 插件唯一标识（Plugin ID）

- **命名格式**：`ap-<category>-<slug>`
- **字符限制**：严格匹配 `^[a-z0-9][a-z0-9-]{1,63}$`（小写字母、数字与连字符，最长 64 字符）。
- **组成规则**：
  - `ap`：**Aervox Plugin** 统一生态标识前缀。
  - `<category>`：功能分类，必须取自预设的 7 大标准分类（见 §2.2）。
  - `<slug>`：具备辨识度的业务短名（kebab-case）。
- **标准范例**：
  - `ap-tool-anki-sync`
  - `ap-bot-weixin`
  - `ap-ui-focus-mode`
  - `ap-proactive-posture`

### 2.2 七大标准能力分类（Categories）

| 分类标识 | 语义范围 | 典型场景 | 核心承载能力 |
|---|---|---|---|
| `tool` | 外部服务调用与本地执行工具 | 天气查询、题库检索、计算器 | `spec.tools`、MCP |
| `bot` | 第三方通信与 IM 平台接入 | 微信私聊/群、QQ OneBot、Telegram | 平台传输适配器、连接状态 |
| `ui` | 前端界面呈现、工作台卡片与扩展 | 专注工作坞、复习抽屉、统计面板 | `spec.pages`、工作台插槽 |
| `proactive` | 主动智能与规则感知 | 久坐疲劳提醒、作息漂移监控 | `spec.proactive.sensors/triggers` |
| `sync` | 外部知识系统与笔记双向同步 | Anki 闪卡、Obsidian 库、Notion | 数据导入导出、遗忘曲线排期 |
| `workflow` | 多步骤结构化工作流编排 | 论文速读流、复盘蒸馏工作流 | 技能组合、提示词管道 |
| `theme` | 外观风格、音效与桌宠模型 | Live2D 皮肤、音效包、UI 主题 | 静态资源包、桌宠表现声明 |

### 2.3 版本号与破坏性指示规范

严格遵循 **SemVer 2.0.0**（`MAJOR.MINOR.PATCH[-PRERELEASE]`）：

- **破坏性变更（Breaking Change）**：
  - 判定标准：修改已有配置字段类型；删除或重命名配置字段；移除已有工具或修改非可选参数；要求更高不兼容宿主版本；改变数据持久化结构。
  - 标识规范：**必须递增 MAJOR 主版本号**（例如 `1.4.2` → `2.0.0`），并在 `CHANGELOG.md` 与 Git Commit 中标明 `[BREAKING]`。
- **功能特性新增（Feature）**：
  - 判定标准：新增可选配置项；新增工具或 Page；向后兼容的能力增强。
  - 标识规范：**递增 MINOR 次版本号**（例如 `1.0.0` → `1.1.0`）。
- **缺陷修复（Fix）**：
  - 判定标准：修补内部逻辑错误；优化文案与样式；无接口或配置形态改变。
  - 标识规范：**递增 PATCH 修订号**（例如 `1.1.0` → `1.1.1`）。

### 2.4 分发包与 Git 资产命名

- **Git Tag 规范**：`<plugin-id>@v<version>`，例如 `ap-tool-anki-sync@v1.0.0`，支持多插件单仓独立发版。
- **Release 分发包产物**：`<plugin-id>-v<version>.aervox-plugin`，例如 `ap-tool-anki-sync-v1.0.0.aervox-plugin`。
- **预发布通道包**：`<plugin-id>-v<version>-<channel>.<num>.aervox-plugin`，例如 `ap-bot-weixin-v2.0.0-rc.1.aervox-plugin`。

### 2.5 内部要素命名约定

- **Tool 名称**：`<slug>_<action>`（小写蛇形），如 `anki_import_deck`。宿主在全局工具注册表自动以 `<plugin-id>.<tool_name>` 隔离命名空间。
- **Skill 名称**：默认技能使用 `pluginId`；辅助子技能使用 `<plugin-id>:<sub-skill>`。
- **Page ID**：匹配 `^[a-z0-9_-]+$`，如 `settings`、`dashboard`。
- **Config Key**：`camelCase` 驼峰命名，如 `syncIntervalMinutes`、`apiKey`。

---

## 3. 文件构成规范

### 3.1 仓库全局布局（`Aervox-plugins` Repo Layout）

```text
Aervox-plugins/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # PR 合规门禁：校验 Manifest、Schema 与资源白名单
│       ├── release-plugin.yml     # 依据 Tag 自动构建并发布 Release 附件
│       └── generate-registry.yml  # 聚合生成集市索引 catalog.json
├── docs/                          # 生态文档
│   ├── SPECIFICATION.md           # 本规范白皮书
│   └── SECURITY_GUIDELINES.md     # 安全与权限指引
├── registry/                      # 集市官方索引数据
│   ├── catalog.json               # 全量插件集市目录（宿主在线集市直读）
│   └── plugins/
│       └── <plugin-id>.json       # 单插件历史版本清单与元数据
├── templates/                     # 开发者初始化模板
│   ├── basic-tool/                # 纯工具/技能插件模板
│   ├── ui-page/                   # 带前端 Page 交互与配置的模板
│   └── proactive-sensor/          # 主动规则与感知源模板
├── plugins/                       # 核心收录的插件源码
│   ├── tools/
│   │   └── anki-sync/             # 单个插件源码工程
│   ├── bots/
│   │   └── weixin/
│   ├── ui/
│   │   └── focus-mode/
│   └── proactive/
│       └── posture-guard/
├── scripts/                       # 校验与构建脚本
│   ├── lint-plugins.mjs           # 静态门禁检查器
│   ├── pack-plugin.mjs            # 确定性 ZIP 打包工具
│   └── build-registry.mjs         # 索引聚合生成器
├── package.json                   # 仓库根配置与工作区声明
├── pnpm-workspace.yaml
└── README.md
```

### 3.2 单个插件源码工程文件构成（Source Layout）

位于 `plugins/<category>/<slug>/` 下，每个插件工程的文件构成与约束如下：

| 相对路径 | 必需性 | 规范与内容要求 |
|---|---|---|
| `plugin.manifest.json` | **必须** | 核心清单声明，严格符合 `PluginManifest` 模式（见 §4.1） |
| `README.md` | **必须** | 包含插件功能阐述、安装指引、配置说明与数据流向隐私声明 |
| `LICENSE` | **必须** | 开源许可证（推荐 Apache-2.0 或 MIT） |
| `CHANGELOG.md` | **必须** | 遵循 Keep a Changelog 格式，明确标记各版本破坏性变更 |
| `icon.svg` | **建议** | 插件图标，1:1 正方形 SVG 或 128x128 PNG（≤ 100KB） |
| `config.schema.json` | 可选 | Aervox DSL 配置元数据定义（必须通过共享校验器验证） |
| `SKILL.md` | 可选 | 对话模型心智技能说明（含 `name` 和 `description` front-matter） |
| `skills/` | 可选 | 包含多个独立子技能时的存放目录：`skills/<sub-name>/SKILL.md` |
| `pages/` | 可选 | Page 扩展目录，子结构必须为 `pages/<page-id>/index.html` 等资源 |
| `src/` | 可选 | 本地构建源码（仅用于第一方或开发调试，严禁打包进分发包） |
| `test/` | **必须** | 单元测试与 Schema 自动化回归用例 |
| `package.json` | 可选 | 本地构建工具依赖声明（不随分发包打包） |

### 3.3 分发包（`.aervox-plugin`）物理归档文件构成（Bundle Distribution Layout）

分发包为标准 ZIP 归档，直接在归档根目录展开，**严禁包装额外顶层目录**，并实行**严格资源白名单（Fail-closed Allowlist）**：

```text
[Zip Root]
├── plugin.manifest.json              # [必须] 插件核心清单
├── config.schema.json                # [可选] 配置模式文件
├── SKILL.md                          # [可选] 默认技能
├── icon.svg                          # [可选] 插件图标
├── skills/                           # [可选] 子技能目录
│   └── <skill-name>/
│       └── SKILL.md
└── pages/                            # [可选] 前端 Page 资源
    └── <page-id>/
        ├── index.html                # 入口必须由 Manifest 显式声明
        ├── app.js
        └── style.css
```

#### 资源白名单与排除规则

- **允许打包的条目**：`plugin.manifest.json`、`manifest.json`、`config.schema.json`、`SKILL.md`、`skill.md`、`icon.svg`、`icon.png`、`skills/**`、`pages/**`。
- **强制排除项（CI 门禁阻断）**：
  - 源码与工程配置：`src/`、`package.json`、`tsconfig*.json`、`vite.config.*`、`.turbo/`。
  - 依赖与编译产物：`node_modules/`、`dist/`、`target/`、`.cache/`。
  - 测试用例：`test/`、`tests/`、`*.test.*`、`*.spec.*`。
  - 版本控制与临时文件：`.git/`、`.github/`、`.gitignore`、`.DS_Store`。
  - 任何符号链接（Symlink）与多硬链接（Hardlink）。

#### 物理资源配额与确定性构建约束

- **压缩包体积**：≤ 20 MiB
- **解压后总体积**：≤ 50 MiB
- **单条目体积**：≤ 5 MiB
- **条目总数量**：≤ 2048 个
- **时间戳确定性**：所有 ZIP 条目必须使用固化 DOS 纪元时间戳 `1980-01-01 00:00:00`，条目名称排序后打包，保证**同源码编译的 SHA-256 校验和完全一致（Reproducible Build）**。

---

## 4. 核心模式与契约规范

### 4.1 清单文件（`plugin.manifest.json`）

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
    "id": "ap-tool-anki-sync",
    "displayName": "Anki 闪卡同步器",
    "publisher": "Aervox 官方生态组",
    "version": "1.0.0",
    "description": "提供 Anki 牌组与 TSV 题库双向同步，并无缝接入遗忘曲线复习系统。",
    "license": "Apache-2.0",
    "category": "tool",
    "tags": ["learning", "anki", "flashcards"],
    "breaking": false
  },
  "spec": {
    "config": {
      "schemaVersion": 1,
      "entry": "config.schema.json"
    },
    "pages": [
      {
        "id": "settings",
        "title": "同步控制台",
        "entry": "pages/settings/index.html",
        "capabilities": ["config.read", "config.write", "host.notify"]
      }
    ],
    "tools": [
      {
        "name": "anki_import_deck",
        "description": "从文本格式导入 Anki 牌组并批量入库",
        "category": "learning",
        "safetyLevel": "guarded",
        "requiredPermissions": ["learning.write"],
        "inputSchema": {
          "type": "object",
          "properties": {
            "content": { "type": "string", "description": "牌组文本内容" },
            "format": { "type": "string", "enum": ["csv", "tsv", "json"] }
          },
          "required": ["content"]
        },
        "priority": 10
      }
    ],
    "skills": []
  }
}
```

### 4.2 配置元数据（`config.schema.json`）DSL 规则

Aervox 使用自有声明式配置 DSL：

- 字段类型：`string`, `text`, `integer`, `number`, `boolean`, `select`, `multi_select`, `object`, `array`, `secret`。
- `secret` 必须定义在最外层（顶级字段），禁止声明 `default` 默认值；系统存储状态布尔值，不回显明文。
- 约束语法：使用 `min` 与 `max`，不得使用 `minimum`/`maximum`；字符串使用 `minLength`、`maxLength` 与 `pattern`。
- 结构约束：顶级字段最多 200 个，递归嵌套深度最多 5 层。

```json
{
  "apiVersion": "aervox.dev/v1",
  "kind": "PluginConfigSchema",
  "schemaVersion": 1,
  "fields": [
    {
      "key": "syncIntervalMinutes",
      "type": "integer",
      "label": "同步间隔（分钟）",
      "default": 30,
      "validation": { "min": 5, "max": 1440 }
    },
    {
      "key": "ankiApiKey",
      "type": "secret",
      "label": "AnkiConnect 密钥",
      "description": "本地 AnkiConnect 插件的安全凭据"
    }
  ]
}
```

### 4.3 前端 Page 与安全沙箱限制

Page 运行在浏览器受限沙箱 iframe 中（`sandbox="allow-scripts allow-forms allow-downloads"`，严格禁止 `allow-same-origin`）：

- 资源必须通过相对路径引入，必须显式加载 Bridge 脚本：

  ```html
  <script src="/v1/plugin-pages/bridge.js"></script>
  ```

- 严格遵循 CSP：`connect-src 'none'`，页面禁止直连任意外部互联网，所有数据操作必须通过 `window.AervoxPluginPageBridge`。
- Bridge 调用权限按 Manifest `capabilities` 严格门控：
  - `config.read`：允许读取本插件配置快照；
  - `config.write`：允许保存本插件配置修改；
  - `host.notify`：允许向宿主工作台弹出通知；
  - `host.close`：允许请求关闭弹窗或抽屉。

---

## 5. 集市（Marketplace）与 CI 门禁体系

### 5.1 集市索引定义（`registry/catalog.json`）

Aervox 客户端通过直读官方集市索引提供可视化浏览、检索与安装体验：

```json
{
  "version": 1,
  "updatedAt": "2026-10-28T19:00:00Z",
  "plugins": [
    {
      "id": "ap-tool-anki-sync",
      "displayName": "Anki 闪卡同步器",
      "category": "tool",
      "latestVersion": "1.0.0",
      "description": "提供 Anki 牌组与 TSV 题库双向同步，并无缝接入遗忘曲线复习系统。",
      "publisher": "Aervox 官方生态组",
      "icon": "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/plugins/tools/anki-sync/icon.svg",
      "breaking": false,
      "requires": {
        "hostApiVersion": { "min": "1.0.0", "maxExclusive": "2.0.0" }
      },
      "downloadUrl": "https://github.com/Aervox-agent/Aervox-plugins/releases/download/ap-tool-anki-sync%40v1.0.0/ap-tool-anki-sync-v1.0.0.aervox-plugin",
      "sha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      "size": 15420
    }
  ]
}
```

### 5.2 自动化门禁测试（CI Pipeline）

所有提交至 `Aervox-plugins` 的 PR 均须通过以下流水线门禁：

1. **命名合规检查**：目录路径必须与 `plugin.manifest.json` 的 `metadata.id` 保持 `plugins/<category>/<slug>` 严格对应。
2. **清单合法性检查**：执行共享验证器 `validatePluginBundleFiles`，验证模式完整性。
3. **资源白名单审计**：确认没有包含未申报文件、符号链接、或超出配额体积的条目。
4. **确定性构建校验**：在独立隔离环境中连续构建两次 `.aervox-plugin`，断言 SHA-256 完全相同。
5. **SemVer 与破坏性审计**：若比对上一版本存在破坏性变动，但未升级 `MAJOR` 版本，CI 立即阻断。
