# Arcane FVTT 镜像包下载说明(阿里云 OSS)

生成时间:2026-08-20T13:21:40+00:00(由 index.json 自动生成本表)

## 基本信息

- 基线:Foundry VTT `13.351` + dnd5e 系统 `5.3.3`(Foundry 本体是付费软件,不在镜像内,需用户从官网下载)
- Bucket:`arcane-package`(阿里云 OSS,北京区),**公共读、匿名禁写**(2026-08-20 验证:匿名 GET 200,PUT/DELETE/LIST 均 403)
- 基准 URL:`https://arcane-package.oss-cn-beijing.aliyuncs.com`
- 机器可读索引:[index.json](https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json),agent/脚本应优先消费它而不是本表

## 目录结构

```text
index.json                                  # 全量索引(版本/大小/SHA256/URL)
packages/<id>/<version>/<id>-<version>.zip  # 包本体
packages/<id>/<version>/module.json         # 该版本的 manifest(系统包为 system.json)
```

路径按版本不可变存放:发新版 = 新增目录,旧版保留可回退,永不清缓存。

## 通用下载与安装(手动)

```bash
# 1. 下载(示例:midi-qol)
curl -L -o midi-qol.zip "https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/midi-qol/13.0.63/midi-qol-13.0.63.zip"

# 2. 校验(SHA256 与下表一致才可用)
sha256sum midi-qol.zip

# 3. 解压到 Foundry 数据目录(模块)
mkdir -p "<数据目录>/Data/modules/midi-qol"
cd "<数据目录>/Data/modules/midi-qol" && unzip -o <路径>/midi-qol.zip
#    系统包(dnd5e)解压到 <数据目录>/Data/systems/dnd5e

# 4. 重启 Foundry,并在世界里启用对应模块
```

zip 内 `module.json` 在压缩包根目录,解压目标目录即 `<id>/`,不要多套一层。

## 包清单与下载地址

### 系统(1 个)

> 装进 `Data/systems/`,不是 `Data/modules/`

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `dnd5e` | `5.3.3` | 102.0 MB | `09b93b36330b15ab6dc94d7dd9a9d053b7d70b35c008dffc1f136e415c3f5e3e` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/dnd5e/5.3.3/dnd5e-5.3.3.zip |

### core 战斗自动化(12 个)

> 战斗自动化运行时契约,全装

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `ATL` | `v1.1.1` | 27 KB | `9d9fabb8be52d68d0f4c62e002ca8dd32c836cc4c4112a5a266440c2f9607f37` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/ATL/v1.1.1/ATL-v1.1.1.zip |
| `ActiveAuras` | `0.12.7` | 67 KB | `6cd48efe4e368ce378e5a338f80d1f5ed4776af8ff87a4b44073a743aa41d0b4` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/ActiveAuras/0.12.7/ActiveAuras-0.12.7.zip |
| `auraeffects` | `1.5.2` | 33 KB | `b6338a96a7666569747c5cd2b6ea68b30c0e5837b25a36e81221bbe2c8dcf7a4` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/auraeffects/1.5.2/auraeffects-1.5.2.zip |
| `dae` | `13.0.28` | 1.2 MB | `c44e2550e4cdb88a7f10e71b0a070d3058345fe8b487e4735c4df00b2f3867af` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/dae/13.0.28/dae-13.0.28.zip |
| `dfreds-convenient-effects` | `8.2.5` | 573 KB | `be1c74584177906fbda954a78299d773ea6fb15fa9550af1df337424dbf3b8c2` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/dfreds-convenient-effects/8.2.5/dfreds-convenient-effects-8.2.5.zip |
| `itemacro` | `3.0.1` | 28 KB | `4b682fffff0b82560097ea114de1e6baa0d08b06fd9e4584fe8dac96d7965b81` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/itemacro/3.0.1/itemacro-3.0.1.zip |
| `lib-dfreds-migrations` | `1.0.2` | 3 KB | `169e6b02feb44759133f0f10f4c88d991b56fb44f631339789406a9fcc57cc8f` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/lib-dfreds-migrations/1.0.2/lib-dfreds-migrations-1.0.2.zip |
| `lib-dfreds-ui-extender` | `2.2.0` | 8 KB | `8b2a662a7fb25800b4db828f1d0603eeb6f8c24723d6cab58d4bbaf5a65a0648` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/lib-dfreds-ui-extender/2.2.0/lib-dfreds-ui-extender-2.2.0.zip |
| `lib-wrapper` | `1.13.5.1` | 133 KB | `889115065a95c740aa5d090c32f331b1ae37598242538ec16a62ffe416154d20` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/lib-wrapper/1.13.5.1/lib-wrapper-1.13.5.1.zip |
| `midi-qol` | `13.0.63` | 6.4 MB | `ee9d1c460ed741f342f1a6bee26976a85c4ed5e541894555c510a7377838f670` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/midi-qol/13.0.63/midi-qol-13.0.63.zip |
| `socketlib` | `1.1.3` | 8 KB | `3c77652b2b4d022b3d60cebd99f8ec9321fa087b03142b8a9be5c3add1496a29` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/socketlib/1.1.3/socketlib-1.1.3.zip |
| `times-up` | `13.1.9` | 82 KB | `8051524eb02632add9267281abb78f582d80445d394656c423f6585660e18d90` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/times-up/13.1.9/times-up-13.1.9.zip |

### arcane 自有(5 个)

> 自有模块,源码在仓库 `foundry-modules/` 与 `translate/`,不依赖 GitHub

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `arcane-agent-bridge` | `0.1.0` | 42 KB | `39eb848b78973cce4dcdae537d73f96c06627308d3656f4ae7dc56f4b261bf40` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/arcane-agent-bridge/0.1.0/arcane-agent-bridge-0.1.0.zip |
| `arcane-common-display-vision` | `0.1.0` | 3 KB | `27a32967ec916d6f26674af87c0ee634f25a33d6118507dc4b6652dae8310118` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/arcane-common-display-vision/0.1.0/arcane-common-display-vision-0.1.0.zip |
| `arcane-dice-so-nice-dnd5e-fix` | `0.1.0` | 1 KB | `3639df30759af780e5a61d08a35b5a5c44e1815ecc5d89987bcbeb86b7aa2a1a` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/arcane-dice-so-nice-dnd5e-fix/0.1.0/arcane-dice-so-nice-dnd5e-fix-0.1.0.zip |
| `arcane-dnd5e-2014-automation` | `0.3.17` | 13.2 MB | `150dbbb9a5f532347ff2cacf0ebeb2fe4844bcccb9fc320e972661ce9774d1e1` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/arcane-dnd5e-2014-automation/0.3.17/arcane-dnd5e-2014-automation-0.3.17.zip |
| `zzzz_arcane_dnd5e_cn` | `0.1.3` | 381 KB | `07f8e430dcd198cd2a4bc8ff4dea3f2f77fdff24062df8e6fb30e01ff894ec36` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/zzzz_arcane_dnd5e_cn/0.1.3/zzzz_arcane_dnd5e_cn-0.1.3.zip |

### fx 美化动画(5 个)

> 美化动画,默认可选;JB2A 是大件

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `JB2A_DnD5e` | `0.8.8` | 1556.9 MB | `7d2e98a1713a801f80da479960f359c760a658edcf0e9cb53f2faf853ac3e35b` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/JB2A_DnD5e/0.8.8/JB2A_DnD5e-0.8.8.zip |
| `autoanimations` | `6.8.5` | 1.2 MB | `01623b88228146e5ab4a0a972bbe838aabd0823b7508ae007fd5c542b1af4334` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/autoanimations/6.8.5/autoanimations-6.8.5.zip |
| `dice-so-nice` | `5.2.5` | 10.4 MB | `5ef6b83aed16d580d28941f4395a701a809c1fcbef6f6958c2eb5910f9014a42` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/dice-so-nice/5.2.5/dice-so-nice-5.2.5.zip |
| `dnd5e-animations` | `3.2.0` | 8.2 MB | `c6f7833dbb83b58d5217573335651c9c581b220116b68d32c01804f6bcbee98f` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/dnd5e-animations/3.2.0/dnd5e-animations-3.2.0.zip |
| `sequencer` | `3.6.11` | 2.5 MB | `53eba9865b583c567eed22887fec788ef03dedd826ff796544738959d2c216af` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/sequencer/3.6.11/sequencer-3.6.11.zip |

### ui 界面(9 个)

> 界面增强

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `color-picker` | `1.7` | 34 KB | `94997782d8ecc536488d89f6332e0a3047388a1c82a7d52299ec3ff2a906cb92` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/color-picker/1.7/color-picker-1.7.zip |
| `colorsettings` | `3.0.4` | 80 KB | `64bb6a940ae290f75d78647131f30e2fbe42d625cb269e917768891ccf0ceb71` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/colorsettings/3.0.4/colorsettings-3.0.4.zip |
| `combat-tracker-dock` | `4.1.8` | 237 KB | `91b1155f675d358f12cd2820bb53d9b8e9e754ee629feba33c00ff91894da86b` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/combat-tracker-dock/4.1.8/combat-tracker-dock-4.1.8.zip |
| `foundryvtt-actor-studio` | `2.9.8` | 3.7 MB | `184d2686bfb287458b44a62bac69225e1c58086bf8fee7bcb0839e146b75b158` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/foundryvtt-actor-studio/2.9.8/foundryvtt-actor-studio-2.9.8.zip |
| `monks-common-display` | `13.01` | 36 KB | `7d6e2793adcb583008d179cf5e8d9f3500d5836bd91aab442b07e2391ee68ebe` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/monks-common-display/13.01/monks-common-display-13.01.zip |
| `tidy-ui_game-settings` | `0.1.52` | 11 KB | `c4afd4e042f50327bc574d6aa370236ed2eee04410f1c0d99c7299415a26274e` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/tidy-ui_game-settings/0.1.52/tidy-ui_game-settings-0.1.52.zip |
| `tidy5e-sheet` | `13.3.0` | 6.2 MB | `413ee8295cc528f730c9867769ae7090571c37ceb31ad1474306fe468d3f8702` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/tidy5e-sheet/13.3.0/tidy5e-sheet-13.3.0.zip |
| `token-action-hud-core` | `2.1.1` | 202 KB | `bee161af056687db09f16ee9ddd35245123e2221894cf27a94549f16887ceb71` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/token-action-hud-core/2.1.1/token-action-hud-core-2.1.1.zip |
| `token-action-hud-dnd5e` | `2.1.0` | 65 KB | `aed7ce484937b42c707b4f72f14e4b01f03ea5f56a78809a330d5bee643e5453` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/token-action-hud-dnd5e/2.1.0/token-action-hud-dnd5e-2.1.0.zip |

### zh 中文(4 个)

> 中文语言栈;babele 是 zzzz_arcane_dnd5e_cn 的硬依赖

| id | 版本 | 大小 | SHA256 | 下载 URL |
|---|---|---|---|---|
| `5e_chn` | `5.3.0` | 51 KB | `bd92eb1735097d840550dcb978215e3e2430fb1bed5bc06e8e1257d6a61b3fa5` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/5e_chn/5.3.0/5e_chn-5.3.0.zip |
| `babele` | `2.9.1` | 1.0 MB | `c177dfdfddc2ed4dc1b7d78a80ac96ad6529fbafcff2dc550aded6be95d50f48` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/babele/2.9.1/babele-2.9.1.zip |
| `foundry_chn` | `13.350` | 56 KB | `1e46a938fe5ed093a1b6ad3bea8cd12bb21af891a820d55257a48b21cf78543a` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/foundry_chn/13.350/foundry_chn-13.350.zip |
| `zzz_mod_chn` | `13.92` | 1.3 MB | `fbef8ae8f8e63541d81dd588b297dceaad2b06335a7e01c8950b818be7a18c55` | https://arcane-package.oss-cn-beijing.aliyuncs.com/packages/zzz_mod_chn/13.92/zzz_mod_chn-13.92.zip |

## 维护与更新

1. 第三方包:从生产服务器 `/home/admin/foundryvtt/data/Data/{modules,systems}` 打包(线上即 QA 基线);自有包:从仓库 `foundry-modules/`、`translate/` 打包。zip 根目录必须直接是 `module.json`(不要多套一层目录)。
2. 发布/校验统一用 `apps/desktop/scripts/oss-mirror-publish.mjs`(替代已废弃的 `.tmp/mirror/*.py` 临时脚本):`add` 上传新包并重生成 index.json、`fix-manifest` 把既有包的 manifest 改写为 OSS 指向、`fix-all` 一次性迁移索引内所有非 OSS 指向的 manifest(结束打印原始 URL JSON 作回滚参照)、`verify` 全量 HEAD + 大小校验。工具自动拒绝覆盖已存在的 id+version(不可变路径),上传后自动跑契约第 3 条校验。manifest 对象键从 index 条目的 manifestUrl 派生,`dnd5e` 的 `system.json` 也能正确回写。
3. 凭证:本机走 aliyun CLI 当前 profile(`~/.aliyun/config.json`,OAuth 模式;token 过期会用 refresh token 静默续期)。CI 侧可用 `ALIYUN_BIN` 指向可执行文件。历史 ossutil profile(`yangqi` 账户)与 `--profile arcane-package` 用法已由本工具取代。覆盖上传(如 index.json、fix-manifest)工具内部已带 `--force`,不存在"按大小跳过"的静默跳过坑。
4. bump 版本 = 新目录 + 重生成 index.json;不要原地覆盖已有版本路径。manifest 的 download/manifest 字段一律改写为本桶地址,Foundry "URL 安装"才不会绕回 GitHub/GitLab。

## 变更记录

- 2026-08-20:首批 35 包建立镜像。
- 2026-08-30:新增 `combat-tracker-dock@4.1.8`(ui 组,顶部先攻/Carousel Combat Tracker);勘误性原地重写 `monks-common-display@13.01` 的 `module.json`(download 原指向 GitHub archive,现指向本桶 zip;zip 本体与 index.json 中的 sha256 未变)——这是对契约不可变规则的一次有记录例外,原因是原 manifest 从未指向过本桶,重写仅影响 Foundry URL 安装的下载源。
- 2026-08-30(晚):`fix-all` 全量迁移完成——34 个 manifest 原地改写为本桶指向(29 个第三方 ext + 5 个自有包补上原本缺失的 download/manifest 字段,自有包从此也支持 Foundry URL 安装),`dnd5e` 的 `system.json` 一并迁移。终检 36/36 全部 `oss` 指向。zip 与 index.json 均未变动。迁移前的原始 URL 留存在主仓 `.tmp/mirror/manifest-originals-20260830.json`(gitignore 目录,作回滚参照;上游地址本身也可在各自仓库查到)。
