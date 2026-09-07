# 本地模块包

适用于用户提供的完整模块 ZIP，包括本地装配的 Auto 2014。交互预算最多两点：提供文件和
确认安装计划；会话中已有文件或对同一准确计划的授权就沿用。将“该包不由镜像担保”的信任
说明并入同一次计划，不再问哈希、工具或目录结构等技术问题。

先用当前运行时契约中的管理器执行：

```text
local-inspect --archive <ZIP绝对路径> --data-dir <Foundry数据目录绝对路径>
```

这是只读检查，不解压、不访问网络。工具读取包内 `module.json`，检查 ZIP 路径、大小和结构，
计算哈希，返回版本、安装目标、现有版本与依赖。包必须有完整模块文件；原始数据、单独内容
JSON 或 `module-assembly-bundle.json` 不是可安装 ZIP，不能改后缀或伪造清单。当前入口负责
安装已装配产物，不代替 Auto 2014 内容编译。

展示名称、旧/新版本、大小、目标和自动备份安排，并说明：“这是你提供的本地包，Arcane 会
检查文件是否完整并备份旧版本，但不代表镜像已审核其内容。”依赖缺失或版本不兼容列入同一
计划，按主 skill 的镜像流程处理。多个已安装目录声明同一 id 时停止定位冲突，不猜一个覆盖。
只针对计划尚未得到授权的部分取得一次确认；不要把机器校验值交给用户判断。

随后把本次检查结果逐项传入：

```text
local-stage --archive <archivePath> --expected-id <id> --expected-version <version> --expected-sha256 <archiveSha256> --expected-bytes <archiveBytes>
```

包发生变化时工具拒绝；重新检查并展示变更后的计划，不用新的哈希强行套用旧授权。
全部暂存成功后，按主 skill 精确停服，再使用现有备份与提交入口：

```text
commit --stage-dir <stageDir> --data-dir <数据目录绝对路径> --expected-current-version <检查到的旧版本或none> --accept-sha256 <同一archiveSha256>
```

校验值仅证明本次使用的是检查过的文件，不是发布方签名或再分发许可。无需联网验证包内的
manifest/download URL；这些字段保持原值，本次安装不从它们下载。不要将用户包、私有描述
或完整装配输入上传到 GitHub、镜像、日志附件或其他服务。

回读最终绝对路径的 `module.json`，报告版本、来源本地路径和实际备份路径。模块替换不改写
世界 Actor；保留已有条目，不用新包批量覆盖角色描述。新模块依主 skill 提醒在世界启用。
