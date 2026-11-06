---
name: ap-tool-postgresql
description: 查看 Aervox 主库状态，在用户选择 PostgreSQL 后指导宿主执行离线备份、迁移、验证、启用与中断恢复；SQLite 保持默认。
---

# PostgreSQL 主库维护

用户请求切换或检查主库时使用此指引。所有命令在配对宿主仓库根通过 `./aervox database` 执行。普通对话没有终端维护能力时，提供具体命令和待补全的信息，不声称已经执行。

## 读取状态

执行 `./aervox database status`，根据返回的 `backend`、`schema`、`generation` 和 `migrationReceiptPath` 报告实际状态。安装或启用本插件不代表主库已经切换。

## 离线切换

用户选择 PostgreSQL 后，先核实本插件已安装且启用，宿主支持 Host API `1.2.0` 及维护命令，目标为 PostgreSQL 16+ 的 UTF-8 数据库。宿主进程通过 `AERVOX_POSTGRESQL_URL` 取得连接凭据；不要要求在聊天中粘贴密码，也不要把连接串放入 CLI 参数或普通插件配置。

停止 API、Worker、桌面内嵌宿主及其他写者，确定源 SQLite 文件、专用 Schema 和新的备份目录。示例：

```sh
./aervox database migrate --source data/aervox.db --schema aervox_primary --backup data/backups/postgresql-first
```

可选参数为 `--instance <实例ID>`、`--vault <本地Vault文件>` 和 `--ledger <独立恢复账本文件>`。缺省实例 ID 由宿主生成；默认 Vault 路径由宿主配置解析。目标 Schema 必须专用；非空未知结构和其他实例目标不能自动覆盖。

只在返回验证成功回执后执行：

```sh
./aervox database activate --receipt data/backups/postgresql-first/postgresql-migration-receipt.json
./aervox database status
```

以 `migrate` 返回的实际 `receiptPath` 为准。迁移保留源库、备份和验证证据；`activate` 再次检查证据并发布启动选择。重启宿主后检查 API 与 Worker 是否都使用所选主库；目标连接失败或结构不符必须报告启动失败。

## 中断处理

启用中断时，确认原维护进程退出后执行 `./aervox database recover`。提交结果未知时保留全部证据，不重放事务、不手工删锁。

未启用迁移可以通过 `./aervox database abort --source data/aervox.db` 放弃；该操作保留源库、备份、回执和 PostgreSQL 目标。已启用的主库不能用 `abort`、卸载插件或删除启动配置回切旧 SQLite，因为其中缺少切换后的新数据。

## 数据边界与报告

主库、连接凭据、Schema、删除与恢复责任属于宿主。插件不直接执行数据库维护。独立本地 Vault、附件和恢复账本保持各自边界；宿主未证明 PostgreSQL 实际位于本机时，受保护画像和主动处理关闭，受保护历史不能向该目标迁移。

区分插件安装、迁移验证、主库启用、宿主启动验证和正式发布。报告可观察到的回执、状态及错误码，不把保存配置描述为迁移完成，也不把本地测试描述为生产发布。
