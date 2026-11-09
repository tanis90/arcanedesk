# 分阶段发布设计（mac 云端闭环，Windows 本地收口）

状态：已拍板待实施 → 实施中（2026-09-20 定稿）。
前置背景与首轮全本地发布的实战记录见 `release-runbook.md` 的 Windows 签名章节。

## 动机

0.4.3-1b1e90da 的首个先签后发版本采用"全量本地发布"：本地下载全部 8 路构建产物
（约 2.8GB）、组装 staging、签名 Windows 安装包后一次性发布。暴露的问题：

- mac 产物在 CI 已完成 Developer ID 签名 + 公证，却要整体落地本地再原样上传，
  本地流量与时长翻倍，且下载环节在慢速网络上多次停滞；
- 本地是发布链路中唯一的"全量持有者"，任何一步失败都要在本地重摆全场。

拍板原则：**mac 自己搞得定就云端自己搞定，Windows 自己做**。

## 总体结构

```
阶段 0  build（Release Arcane Desktop，仅构建）
  8 路矩阵（4 平台 × cn/intl）→ Actions artifacts
  Windows 产物拆两种 artifact：-exe（仅安装器）与 -pkg（zip + 校验清单），
  为"本地只下载 exe"创造条件。mac artifact 不变（dmg/zip/SHA256SUMS）。

阶段 1  stage-release（新增 workflow：Stage Arcane Desktop Release）
  dispatch 输入：build_run_id、release_id（默认 <version>-<commit8>）、channel。
  按 region 矩阵执行：
  - 从 build run 只下载 mac 全部产物 + windows -pkg（不取 -exe）；
  - 上传版本目录中所有"签名器不触碰"的对象：
      mac dmg/zip/SHA256SUMS、windows zip
    （不可变纪律照旧：上传前 HEAD 预检 + OSS x-oss-forbid-overwrite）；
  - 产出 manifest 分片 fragment-<region>.json（Actions artifact，约 1KB）：
      已上传每个文件的 name/bytes/sha256/kind；
  - 创建 GitHub draft release 并上传 mac + windows-zip 资产
    （draft 仅维护者可见、不建 tag、不通知；转正由阶段 2 独占）。
  不出 release.json、不碰 latest。

阶段 2  finalize（本地）
  - gh run download 只取 4 个 -exe artifact（约 820MB）与 2 个分片；
  - sign-windows.mjs 签名（SimplySign，先于任何云端变更执行）；
  - dispatch 阶段 1，等待其完成；
  - publish-release.mjs --finalize：
      · windows 条目本地计算（签名 exe + 分片中的 zip 哈希重建 windows SHA256SUMS）；
      · mac/zip 条目来自分片，并与桶上 mac SHA256SUMS.txt 双源交叉校验；
      · 合成全量 release.json → 上传 → 全对象 HEAD 验证；
      · gh release 补 4 个 exe 资产、写入最终 notes、转正 draft；
  - 验证通过后 promote latest（沿用 --skip-latest + 独立 promote 两步纪律）。
```

执行顺序刻意为"**先签后上云**"：本地签名是最脆的环节（SimplySign 会话可挂死，
2026-09-18 实证），放在阶段 1 之前，失败时连孤儿对象都不产生。代价是多一次
dispatch（阶段 1 无构建，仅 CI 中继上传，数分钟）。

## 幂等与失败契约

| 对象 | 语义 |
| --- | --- |
| 阶段 1 上传的对象（mac/zip） | 上传一次；重跑/续做时"HEAD 长度与分片一致 → 跳过"，不一致 → 硬错误 |
| 4 个签名 exe | journal 记账跳过；无记账但桶上存在且长度一致 → 收养并记账（覆盖"上传后、记账前"崩溃窗口）；长度不一致 → 硬错误 |
| release.json | finalize 上传时必须不存在；已存在 = 该 releaseId 已收口，硬错误（此时正确动作是单独 promote） |
| latest.json | 仅 promote 触达，语义不变 |
| GitHub release | draft 态可追加资产；转正仅 finalize；已是正式 release 再 finalize → 硬错误 |

**journal（发布日志）** 是续做安全的最后一块板：finalize 每成功上传一个对象立即
追加 `{region, key, sha256, bytes}` 到
`apps/desktop/generated/release-journal-<releaseId>.json`（generated/ 已 gitignore）。
重跑规则：

- 本地文件哈希 == journal 记录 → 跳过上传；
- 本地文件哈希 != journal 记录 → 硬报错"签名字节已变化，该 releaseId 污染，换新
  releaseId"。这条防的是**重签**：Authenticode 签名内嵌 RFC3161 时间戳，同一文件
  两次签名字节不同；若不拦下，会把桶里旧签名对象与 manifest 新哈希静默错配
  （HEAD 验证只比长度不比哈希，恰好同长就会漏过）。

配套纪律：续做时不得删除 `dist-signed/`、不得 `--force` 重签
（sign-windows 对"已有效签名"默认跳过，天然满足）。

失败面归纳：

- 签名失败：零云端痕迹，重新登录后重跑；
- 阶段 1 失败：重跑阶段 1（已传对象按长度一致跳过）；
- finalize 中断：journal + 容忍语义续传；
- finalize 已出 release.json、promote 未跑：单独执行 `--promote-release`；
- 彻底放弃：版本目录留孤儿对象（RAM 无 Delete 权限，成本数百 MB），下次换新
  releaseId。

## 流量对比

| 路径 | 全量本地（0.4.3-1b1e90da 实测） | 分阶段 |
| --- | --- | --- |
| 本地下载 | 2.8GB（8 路） | 约 820MB（4 个 exe）+ 2KB 分片 |
| 本地 → 桶上传 | 2.8GB | 约 820MB（4 个签名 exe + sums + manifest） |
| 本地 → GitHub 资产上传 | 2.8GB | 约 820MB（4 个 exe） |
| mac 字节 | 落地本地再上传 | CI → 桶 / CI → GitHub，不过本地 |

## 接口清单

1. `.github/workflows/arcane-desktop-release.yml`
   - 删除 publish job 与 `skip_oss` / `update_latest` / `create_github_release` /
     `channel` 输入（CI 全量发布 = 未签名 Windows 上线，是脚枪，移除）；
     紧急场景的答案改为"不发"。
   - build job 的 Windows 产物拆 `-exe` / `-pkg` 两种 artifact。
2. `.github/workflows/arcane-desktop-stage-release.yml`（新增）
   - dispatch：`build_run_id` / `release_id`（可选）/ `channel`；
   - region 矩阵执行上传 + 分片 + draft release；
   - draft 已存在则 `gh release upload --clobber` 追加，已转正则硬失败。
3. `apps/desktop/scripts/stage-release.mjs`（新增）
   - `--staging <dir> --region cn|intl --release-id <id>`；
   - staging 内出现 `.exe` 直接报错（防未签名安装包入桶）；
   - mac SHA256SUMS 先与实文件比对再上传；windows sums 不在阶段 1 上传。
4. `apps/desktop/scripts/publish-release.mjs`
   - 新增 `--finalize`：`--staging <仅 exe 目录> --signed-dir <dir>
     --fragment <file> --region <r> --release-id <id> --channel <ch>
     [--skip-latest] [--dry-run]`；
   - journal 记账与校验；分片与桶上 mac sums 交叉校验；
   - `--promote-release` 语义不变。
5. `apps/desktop/test/stage-release.test.mjs`、`publish-release.test.mjs`
   - 分片生成与 exe 拒收；finalize 的合并/幂等/污染拦截/已收口拦截分支。
6. `release-runbook.md` Windows 签名章节改写为两阶段流程
   （编排脚本 `local-release.mjs` 为后续便利项，不在本期）。

## 已拍板的取舍记录

- **draft release 时机**：阶段 1 建 draft（CI 带宽传 mac 资产），finalize 补 exe
  后转正；换来本地少传 1.4GB，且用户只见一次成型的 Release。
- **先签后上云**：签名在阶段 1 之前，宁可多一次 dispatch。
- **旧 CI publish job 删除**而非保留改名：新流程下它只会发出未签名 Windows 包。
- **windows zip 走云端**：zip 不需要签名，由阶段 1 直接上传；本地只经手需要
  变换字节的 4 个 exe。

## 2026-09-21 重构：Windows 构建撤出 CI，全本机

0.6.0 发版（三次实跑的经验）暴露两处结构性摩擦，均指向同一根源——
Windows 未签名构建放在 CI，产物却必须回到本机签名：

1. 构件跨境下载：810MB 的 exe 从 GitHub 拉到本机，0.4.3/0.5.1/0.6.0 三次
   都是最慢、最易挂死的一段（0.6.0 时一对下载任务挂死一小时零产出）。
2. 签名等待窗口：构建→下载→签名的数小时间隔里 SimplySign 会话会过期。

重构后的分工：mac 留 CI（Developer ID 证书与公证凭证是 GH secrets，不可
本地化）；Windows 全本机——`build-windows-release.mjs` 编排四变体构建，
逐项复刻 CI 腿的门禁（钉提交 sha8==HEAD、tracked 树干净、同组构建 env、
每变体 verify-package），产物直接落本机树，签名紧随其后。zip 经本机
stage-release 出第二份 fragment；finalize 的 `--fragment` 改为可重复参数，
mac（CI）与 windows（本机）分片在收口处合并，跨片重复即拒绝。

顺带沉淀的三条硬守卫（都有事故对应）：基座 `product.version` 与 release id
版本前缀一致（0.5.0 cn 事故）；基座 `source.commit` 与 release id 的 sha8
一致（0.6.0 intl 未遂——发版中途 HEAD 被另一会话推进）；分片不相交
（结构性约束显式化）。

代价（记录在案）：本机产物没有 GitHub Actions provenance attestation
（个人机器无 OIDC 主体）；下游目前无消费方，release.json 的 sha256/sha512
锚仍是完整性契约。runner→OSS 北京路由断裂（0.6.0 当日）的本地 staging
逃生口已写进 runbook，与新流程天然兼容——分片合并让「mac 云端 + windows
本机」与「全部本机」两种 staging 组合都成立。
