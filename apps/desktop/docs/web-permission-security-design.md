# Web Permission Security

Foundry panel 加载用户指定的远程页面。所有 Chromium permission 请求均由主进程策略处理，
renderer 或网页脚本不能直接修改授权记录。

原则：

- 默认拒绝未识别的 permission 与设备类别。
- 授权绑定 exact origin、permission 和必要的 subtype，不使用宽泛域名通配。
- 只有当前受控 Foundry 页面可触发提示；后台、销毁或导航后的页面请求失败关闭。
- 麦克风、摄像头、屏幕共享等敏感能力需要即时用户动作与明确选择。
- “仅本次”在会话结束时失效；持久决定可以在设置页查看和撤销。
- 不把设备 label、页面内容或授权上下文发送给模型或遥测。
- 密码输入、license 激活与 GM 登录只发生在 Foundry 页面，不通过 Agent 工具。

实现分层：

```text
Electron session handlers
  -> WebPermissionPolicy
  -> WebPermissionStore (userData/config)
  -> trusted chat IPC prompt
```

显示媒体由单独 controller 处理，避免把摄像头/麦克风授权误当成桌面捕获授权。页面导航、
panel 销毁和 app 退出都会清理未决请求。

测试必须覆盖未知权限默认拒绝、origin 精确匹配、持久/会话授权、撤销、导航竞态、请求超时、
屏幕共享选择取消和不可信 IPC sender。
