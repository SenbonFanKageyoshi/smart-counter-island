# Smart Counter Island

面向希沃教学大屏 / Windows 10/11 的高考·中考·期末考倒数日程序：屏幕顶端的 iOS 灵动岛风格悬浮窗，带 liquid glass 质感，托盘常驻。零运行时依赖、零原生编译，解压即用。

## 功能

- 三种状态窗口：**灵动岛**（默认小条，纯黑底 + 1px 纯白边）· **横幅**（无操作 4 秒自动展开，显示事件名+天数+时分秒）· **倒计时窗口**（大屏纯展示：高度为屏幕 1/4、宽度随文字自适应、突出天数、**鼠标穿透不可操作**）
- 智能切换：有操作收起为灵动岛，无操作展开横幅；**非全屏/非最大化时闲置 N 秒自动弹出大屏（秒数可自定义，0=不自动）**；无计时事件时锁定灵动岛（纯黑）
- **全屏状态无条件锁定灵动岛**：鼠标点击穿透、不响应任何操作（任何模式、任何手势均不可唤起）
- 系统通知接管：捕获所有通知弹窗（系统 Toast / QQ（NT 架构）/ 微信 / 钉钉等），黑底白字展示，弹窗尺寸随内容自适应，滑动收起，可一键「免打扰至下课」（按时间表计算下课时间）
- 时间表：每天上下课时间段，支持几周一休循环（休息周可少排课）、跨午夜时段、两次点击高效复制（复制此天 / 复制此周 / 一键复制到所有周）
- **计划任务**：定时提醒 / 定时关机（**提前 N 分钟提醒，提醒文案固定、关键词红色高亮，可随时取消**，取消后当天不再触发）/ 运行命令；可每天、每周几或仅一次
- **开机自启**：登录 Windows 后自动运行（可开关）
- liquid glass 真实毛玻璃（已排除小岛自身）、文字颜色随背景亮度自动适配、多事件轮播、文言文模式、配置窗口暗色主题
- 手势：单击只收不放 · 双击打开配置 · 按住向下拖放大 / 向上拖收起 · 通知滑动收起
- 托盘：单击显示/隐藏 · 双击打开配置 · 右键快速菜单

## 下载

从 [Releases](https://github.com/SenbonFanKageyoshi/smart-counter-island/releases) 下载：

- `SmartCounterIsland-Setup-1.3.1.exe` —— 安装版（创建开始菜单/桌面快捷方式）
- `SmartCounterIsland-1.3.1-portable.exe` —— 便携版（免安装，直接双击运行）

程序未做代码签名，Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。

## 开发运行

需要 Node.js 18+。

```powershell
npm install
npm run start    # 直接运行
```

自检：`npm run test`（102 项自动化断言）/ `npm run smoke`（探针、毛玻璃、配置窗口）。

## 打包 exe

```powershell
npm run dist
```

产物在 `release/`：安装版 + 便携版（已内置全部依赖，目标电脑无需安装 Node）。

### 国内网络加速

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://mirrors.huaweicloud.com/electron-builder-binaries/"
npm install
```

## 技术要点

- **技术栈**：Electron 33 + 原生 HTML/CSS/JS，零运行时依赖、零原生模块
- **系统检测**：常驻 PowerShell 探针子进程（Win32 API）检测前台窗口/光标/最后输入，识别全屏授课与最大化，驱动状态机；探针崩溃自动重启
- **毛玻璃**：`WDA_EXCLUDEFROMCAPTURE` 排除小岛自身后截屏模糊，无重影；DPI 缩放与 Win32 圆角命中区域（`SetWindowRgn`）适配，无黑边锯齿
- **通知接管**：UI Automation 读取通知窗口标题与内容，同一窗口内容变化也视为新通知（兼容 QQ NT 复用气泡窗口）
- **设置**：`%APPDATA%\SmartCounterIsland\settings.json`（旧版 Liquid Glass Counter 设置自动迁移）

## 常见问题

- 小岛不出现：检查托盘图标，单击托盘切换显示；检查「智能行为」与「手动模式」是否为自动
- 全屏时不隐藏：确认「全屏授课自动收成灵动岛」已开启；判定标准为窗口盖住任务栏区域
- 毛玻璃是模拟的：低配机器可将玻璃效果改为「模拟玻璃」或「关闭」
- 设置文件：`%APPDATA%\SmartCounterIsland\settings.json`，可直接编辑后重启程序
