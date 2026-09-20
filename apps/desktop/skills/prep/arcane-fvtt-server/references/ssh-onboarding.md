# SSH 首次接入引导(小白单一主路径)

原则:**用户零选择**。分支全部由 skill 决定;用户全程只做两件事——跑一条 skill
给好的命令、输一次 yes + 一次密码。私钥材料永不进入 agent 上下文:会话会被
持久化/快照重放,钥匙贴进对话等于永久写进日志。

## 厂商 → 默认登录名(登录失败自动试下一候选)

| 云厂商 | 默认用户 | 首选认证 |
|---|---|---|
| 阿里云 / 腾讯云 / 华为云 / 火山引擎 / 京东云 / UCloud / Vultr / DigitalOcean / Hetzner | root | 购买时设的密码 |
| AWS EC2 | ec2-user(Amazon Linux)/ ubuntu(Ubuntu) | .pem |
| Oracle Cloud | ubuntu | .pem |
| GCP | 购买时自设 | .pem 或密码 |
| 不认识的小服务商 | root → ubuntu → admin 逐个试 | 密码 |

厂商同时决定安全组引导话术与控制台兜底路径(见 vendor-map.md)。

## ① 开场(问且只问三个事实)

> 你的服务器买好了,我们花两分钟连上它。告诉我三件事:
> 1. 在哪家买的(阿里云?腾讯云?……)
> 2. 服务器的公网 IP(控制台实例列表里那串,比如 47.98.x.x)
> 3. 买的时候是**设置了登录密码**,还是**下载过一个 .pem 文件**?(不记得也没事,先按密码试)

## ② skill 静默准备(用户无感知)

- 探测 `ssh` 客户端存在性(`Get-Command ssh` / `command -v ssh`);缺失 → 引导
  安装 Windows 的 OpenSSH Client 可选功能(设置 → 应用 → 可选功能),macOS 自带。
- `~/.ssh/id_ed25519` 不存在则自己生成:
  `ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519`
  (空口令:小白场景 Windows 账户即锁;生成钥匙不等于接触私钥内容,skill 依然
  永不读取私钥文件内容。)
- 读 `~/.ssh/id_ed25519.pub` 备用(公钥非机密)。

## ③ 用户唯一的一步(参数已按①填好)

> 最后一步需要你动手,因为密码只能输给你电脑上的 SSH。
> 开始菜单搜 **PowerShell**,打开,把下面这条**整个复制**进去回车(IP 已填好):
>
> ```
> type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@47.98.x.x "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
> ```
>
> - 第一次会问 `Are you sure you want to continue connecting?` → 输 **yes** 回车;
> - 然后输你买服务器时设置的密码(屏幕上不会显示,输完回车)——密码交给 SSH,我看不到;
> - 如果它提示你先改密码,改一个能记住的,改完把这条命令再跑一遍。
>
> 跑完跟我说一声。

macOS 变体:`cat ~/.ssh/id_ed25519.pub | ssh root@47.98.x.x "…"`。

## ④ skill 收尾(全自动)

1. `ssh-keyscan` 记录指纹(供日后漂移告警,不打扰用户核对)。
2. 写 `~/.ssh/config` 别名块(告知即可,纯配置非机密):
   ```
   Host arcane-server
       HostName 47.98.x.x
       User root
       Port 22
       IdentityFile ~/.ssh/id_ed25519
   ```
3. `ssh arcane-server 'echo ok'` 验证;`Permission denied` → 换下一候选用户名,
   回到③换一条命令;22 端口超时 → 提示"去云厂商控制台把安全组的 22 端口放行"
   (vendor-map.md 有各家路径)。
4. 汇报:

> ✅ 连上了。以后你对我说"服务器"就是它(arcane-server),你的密码和私钥我从头到尾没碰过。现在开始检查服务器环境(系统、Docker、30000 端口)……

## .pem 分支(skill 判断,不问偏好)

①的答案提到 .pem → 让用户把文件拖到 `~/.ssh/`(或告知下载位置),skill 复制为
`~/.ssh/<厂商>-<IP>.pem`、修正权限(Windows 用 `icacls` 收紧 ACL;macOS/Linux
`chmod 600`)、config 的 IdentityFile 指向它、直接验证——**用户一条命令都不用跑**。

## 控制台兜底(命令路走不通才用)

适用:所有候选用户名都 Permission denied(密码登录被禁/密码丢失),或用户主动
要求在控制台操作。此时导入的是**我们生成的公钥**(skill 展示 .pub 内容),用户
不需要下载任何 .pem。各家控制台的密钥对规则与坑见 vendor-map.md;以阿里云为例:

> 打开阿里云控制台 → 云服务器 ECS → 左侧"密钥对"——**先看左上角地域是不是你
> 实例所在的那个**,不对先切。点"导入密钥对",把我给你的这串公钥粘进去;然后
> 选中它 → "绑定密钥对" → 勾你的实例。注意两点:**绑定前实例会要求关一次机,
> 绑完再开机生效**(云厂商的规则);如果这个实例以前绑过别的钥匙,新钥匙会
> **替换**旧的。绑好开机后跟我说一声,我来验证。

## 拒绝话术(用户提出把私钥发给 agent)

> 不用也不行:我们的对话会被存档,钥匙贴进对话等于永久写进日志。命令你敲、
> 结果我查,一样快。
