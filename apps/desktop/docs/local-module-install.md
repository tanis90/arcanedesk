# 本地模块安装入口

`arcane-fvtt-mods` 现在接收用户提供的完整模块 ZIP。它不要求将私有内容发布到 mirror，也不读取包内 URL 下载其他文件。原始内容数据或 module assembly bundle 尚不能在 Desktop 内编译；它们需先由模组仓库的共享构建工具装配。

`local-inspect` 只读 ZIP 和明确给定的 Foundry 数据目录。检查路径、安全边界、单一 manifest、文件大小，输出本地文件 SHA256、模块身份、目标、现有版本和依赖。根目录或单层目录包装均支持；不允许目录外杂项、歧义 manifest 或大小写冲突。

`local-stage` 必须提供 inspect 的 id/version/bytes/SHA256，重验输入并校验复制后的 ZIP，再交给已有安全解压内核。输出 schemaVersion 2 stage record，明确 sourceKind=local-archive；清单字节保留不改。`commit` 复用既有归档和清单校验、旧版本检查、备份、替换及回读。哈希不是发布方签名或内容授权。

新增四个测试覆盖只读检查、离线安装和备份、确认字段漂移、危险/歧义 ZIP、暂存归档篡改；Desktop verify:source 与全部 412 个测试通过。

2026-09-07：使用私有模组仓库中通过基线比较的 Auto 2014 0.4.0 完整构建，在隔离 Data 目录实测 local-inspect → local-stage → commit。安装后 839 个文件的路径和 SHA256 全部一致；不包含世界启用或战斗 QA。第一次 Windows incoming 目录 rename 返回 EPERM，目标保持空且 stage 保留；确认状态后使用同一 stage 恢复成功。尚未定位该瞬时文件系统错误的根因，不宣称所有 Windows 锁冲突均已解决。

本次只提交源码和 skill revision 9；没有发布 App/OSS skill bundle，也没有安装到用户正在运行的 Foundry 或更改世界 Actor。
