# PostgreSQL 数据库

`ap-tool-postgresql`，主分类 `tool`。版本 `1.0.0`。

这是用户自主安装的可选扩展。SQLite 保持默认；出厂市场展示此插件，首次启动不创建安装、配置或授权记录。安装插件本身不会立即连接 PostgreSQL 或迁移数据库。

## 安装与切换

配对宿主需要 Host API `1.2.0` 及其 PostgreSQL 维护命令。先在插件市场安装并启用本插件，也可安装预检后的 `.aervox-plugin`。包内提供 [SKILL.md](SKILL.md) 操作指引；数据库驱动、Schema、仓储、凭据和迁移均由宿主实现。

准备 PostgreSQL 16 或更新版本、UTF-8 数据库和专用 Schema。远端连接须通过验证服务器身份的 TLS。迁移创建缺失的专用 Schema，拒绝公用 Schema、非空未知结构及其他实例拥有的目标。连接串只通过宿主进程环境 `AERVOX_POSTGRESQL_URL` 提供，不写入插件配置、聊天正文或命令行参数。

停止 API、Worker、桌面内嵌宿主和其他数据库写者，然后在配对宿主仓库根执行。以下示例使用默认源库和一个尚不存在的备份目录；实际路径以当前实例为准。

```sh
./aervox database status
./aervox database migrate --source data/aervox.db --schema aervox_primary --backup data/backups/postgresql-first
./aervox database activate --receipt data/backups/postgresql-first/postgresql-migration-receipt.json
./aervox database status
```

`migrate` 保留 SQLite 源库，建立备份并导入、校验业务数据和搜索投影，返回 `activated: false` 与回执路径。需要固定实例身份时传入 `--instance`；独立 Vault 和恢复账本可分别用 `--vault`、`--ledger` 指定。`activate` 再次验证回执和目标，发布宿主启动配置并保留 SQLite 写入锁。重启 API 与 Worker 后，两者读取同一主库选择；连接或结构验证失败时启动失败。

启动选择默认保存于宿主 `data/database-selection.json`；`AERVOX_DATABASE_SELECTION_PATH` 可指定其他位置。连接凭据由宿主在本机加密保存，`status` 只返回数据库类型、目标、Schema 和回执位置。

## 中断与恢复

启用操作中断后，先确认原维护进程退出，再运行 `./aervox database recover`。它恢复启动配置的发布状态，不重放业务事务。

尚未启用时可运行 `./aervox database abort --source data/aervox.db`，归档迁移锁，保留源库、备份、回执和目标 Schema。已启用 PostgreSQL 后禁止用此命令重新开放旧 SQLite；回切需要处理新写入数据的独立迁移。

## 数据与隐私

数据库、备份、删除、撤权和恢复责任属于宿主。插件停用或卸载不自动切回 SQLite、不删除业务数据，也不删除正在使用的宿主数据库凭据。插件源代码缺席时，宿主仍须保留数据库状态与修复入口。

本机私密 Vault、附件及独立恢复账本保持各自边界；`local_only` 来源不能因主库配置变化而进入远端数据库。宿主只为实际验证为本机存储的 PostgreSQL 开放受保护画像及主动处理；localhost 或本地 Vault 本身不构成主库存储证明。远端或无法验证的目标关闭这些操作，受保护历史的迁移拒绝执行。连接失败或提交结果未知须明确报告，不静默创建空 SQLite 库或重放事务。

## 开发与许可

在配对宿主根冻结安装后运行集合 `lint-plugins.mjs`、本目录声明测试及可重现打包检查。宿主另行验证真实 PostgreSQL 连接、会话、配置、学习、隐私、迁移与重开；本地验证完成不代表正式发布。源码许可见 [LICENSE](LICENSE)；集合规范见 [SPECIFICATION.md](../../../SPECIFICATION.md)。
