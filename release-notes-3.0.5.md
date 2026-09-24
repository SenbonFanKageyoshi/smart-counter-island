# Smart Counter Island 3.0.5 版本说明

> 发布日期：2026-09-24 · 产物：`SmartCounterIsland-Setup-3.0.5.exe` · `SmartCounterIsland-3.0.5-portable.exe`

## 计时坞重做：对齐 iOS 倒计时（Live Activity）观感

参考苹果官方规范重做了计时坞的视觉：

- [Live Activities · Apple HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities)：倒计时属于"扫一眼就能读懂"的信息 —— 大号数字 + 进度指示，文字层级极简、深底高对比，不堆装饰。
- [`SystemFormatStyle.Timer(countingDownIn:showsHours:maxFieldCount:)`](https://developer.apple.com/documentation/swiftui/systemformatstyle/timer/init(countingdownin:showshours:maxfieldcount:maxprecision:))：倒计时文本用**等宽（tabular）数字**，小时为 0 时不显示小时字段。
- iOS 26 液态玻璃设计资源（[ithome 报道](https://m.ithome.com/html/859953.htm)）：深色玻璃面 + 高对比白字。
- 灵动岛倒计时形态参考（[PCOnline 说明](https://www.pconline.com.cn/ask/47448.html)）：紧凑形态是**环形进度 + 剩余时间**。

改造后的一栏（500×104 黑底胶囊）结构：

```
◜◝   256 天                 ← 环形进度（从 12 点顺时针）+ 超大等宽数字
◟◞   距离 高考               ← 极小标签（12.5px / 52% 白）
     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁        ← 细线性进度条（3px，Live Activity 式）
[+1 天][+3 天][+7 天][+30 天][自定义…][完成]   ← 快捷添加芯片（长按进坞时出现）
```

关键细节：

- **数字 40px / 700 字重 / 字距 -1.2px / `tabular-nums`** —— 数字宽度恒定，倒计时走秒时不会左右抖。
- **环形进度**：SVG 环 52px、线宽 4、圆头端点，`stroke-dashoffset` 平滑过渡（0.45s 缓出）；进度 = 1 − 剩余天数 / 窗口天数，越临近越满。
- **最后一天**：自动切换成 **`hh:mm:ss` 逐秒** 走（本地每秒重绘，不依赖主进程推状态），与 iOS 倒计时一致。
- **恒定黑底白字**：计时坞不再跟随"背景亮度自适应"（原来桌面亮时会被改成浅底深字，看起来完全不像通知那种黑底倒计时）。
- 快捷添加芯片改为半透明白胶囊（`rgba(255,255,255,.12)` + 1px 描边），"完成"为白底黑字主按钮。

## 验证

- 真实输入诊断 `--diag-press` 截图落盘 `shots/dock.png`（已肉眼复核）：环形进度 + `256 天` + `距离 高考` + 细进度条 + 芯片排，黑底白字。
- 自检（3.0.4 时）282 项全绿；本次为纯视觉/样式改造（新增 `pct`/`at` 载荷字段 + 渲染层本地逐秒）。
