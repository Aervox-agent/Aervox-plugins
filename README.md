# Aervox-plugins

Aervox 第一方插件与受信界面集合，通过 [Aervox-harness](https://github.com/3yearsZhuang/Aervox-harness) 的 `plugins/` Git submodule 消费。生态标准见 [构成规范与文件结构标准 AVX-PLUG-002](SPECIFICATION.md)，保留统一 ID、七分类、独立版本、Registry 和发布门禁设计。

## 目录与身份

业务插件位于集合 `plugins/<category>/<slug>/`，采用 `ap-<category>-<slug>`。七分类为 tool、bot、ui、proactive、sync、workflow、theme；主分类随身份冻结，能力变化使用 tags。原有九个 ID 通过宿主显式停写迁移工具转换，不能通过重装或别名猜测合并配置、凭据和授权。

受信根界面仍位于 `surfaces/companion-ui`、`surfaces/panels-ui`、`surfaces/proactive-ui`、`surfaces/workbench-ui`，遵循 [ADR-025](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-025-ui-surface-hosts.md)。它们随宿主编译，不作为 `.aervox-plugin` 动态代码安装。

## 开发与验证

依赖、工具链、公共 Contracts、构建和锁文件统一由宿主根维护，集合不是独立安装工作区。主仓实际业务源码路径为 `plugins/plugins/<category>/<slug>`；源码包名和公共 exports 保持。修改在 feat/fix/docs 分支经两仓 PR 交付。

```bash
git clone https://github.com/3yearsZhuang/Aervox-harness.git
cd Aervox-harness
mise tasks run install
git -C plugins switch -c feat/my-plugin-change
mise tasks run native-toolchain-setup
mise exec -- pnpm exec turbo run build --filter=@aervox/host-runtime...
mise exec -- node --test plugins/scripts/ecosystem.test.mjs
mise exec -- node plugins/scripts/lint-plugins.mjs
mise exec -- node --test plugins/scripts/check-docs.test.mjs
mise exec -- node plugins/scripts/check-docs.mjs
mise exec -- pnpm exec turbo run build typecheck test --filter='./plugins/plugins/*/*' --filter='./plugins/surfaces/*'
mise tasks run package-plugins
./aervox ci all
```

需要配对宿主分支时，先检出公开候选并暂存 gitlink，再冻结安装验证；不用非冻结安装掩盖不兼容，也不在单插件目录另行安装。文档排版使用宿主固定版本：

```bash
mise exec -- markdownlint-cli2 --config .markdownlint-cli2.jsonc 'plugins/README.md' 'plugins/SPECIFICATION.md'
```

## 发布与市场

Tag `<plugin-id>@v<version>` 触发标准与可重现门禁，生成 `<plugin-id>-v<version>.aervox-plugin` 和 SHA-256 文件。Registry 生成器只收录已发布且实际验证的附件，通过 PR 更新 [catalog](registry/catalog.json) 和版本历史；尚无公开发布时 catalog 为空。

[基础工具](templates/basic-tool/README.md)、[Page](templates/ui-page/README.md) 和[主动感知](templates/proactive-sensor/README.md) 模板提供完整声明示例。声明、受信 handler、执行授权和真实外部连接分开验证；标准通过不代表业务已上线。

## 来源、责任与许可

集合从宿主冻结输入 [`119dbf2067337153724830094fc304e096bfdf28`](https://github.com/3yearsZhuang/Aervox-harness/tree/119dbf2067337153724830094fc304e096bfdf28/plugins) 提取并保留路径历史；更早跨目录历史可从原仓追溯。Surfaces 历史随后迁入，原作者与版权继续保留。

接口与数据责任见宿主 [AVX-PLUG-001](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/plugin-config-and-pages.md)、[ADR-031](https://github.com/3yearsZhuang/Aervox-harness/blob/main/docs/reference/adr/ADR-031-first-party-plugin-repositories.md) 和 Host Plugin API。宿主持有模型、账本、授权/取消、凭据与用户数据；缺包不删除这些数据。源码继续采用 [AGPL-3.0-or-later](LICENSE)，本说明与规范采用 [CC BY-NC-SA 4.0](LICENSE.docs)，具体文件已有许可继续有效。
