# Smart Counter Island - system probe (ASCII-only, locale-safe)
# Spawned by the Electron main process with -Sta (UI Automation requires STA).
# Tasks:
#   1) stdin line "probe" -> JSON line (fg window, cursor, last input, toasts list)
#   2) poll %TEMP%\sci-region-cmd.txt  -> SetWindowRgn rounded hit-region
#   3) poll %TEMP%\sci-exclude-cmd.txt -> SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
#   4) poll %TEMP%\sci-transparent-cmd.txt -> SetWindowLongPtr WS_EX_TRANSPARENT toggle
# NOTE: keep this file pure ASCII - PowerShell 5.1 reads BOM-less scripts as ANSI/GBK.
$ErrorActionPreference = 'SilentlyContinue'

$code = @"
using System;
using System.Runtime.InteropServices;
public static class Probe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern bool SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  // ---- fast window enumeration helpers (compiled: the per-window loop must NOT
  //      run in PowerShell - a scriptblock delegate + New-Object per window costs
  //      far more than the Win32 calls themselves) ----
  public static string GetClassOf(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }
  public static string GetTitleOf(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
  public static int[] GetRectOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  private static System.Collections.Generic.List<long> _cands;
  private static uint _myPid;
  private static uint[] _pids;
  private static string[] _classes;
  private static string[] _black;
  private static int _minW, _maxW, _minH, _maxH;
  private static bool _topMost;

  private static bool CandProc(IntPtr h, IntPtr l) {
    try {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (_pids != null) {
        bool ok = false;
        for (int i = 0; i < _pids.Length; i++) { if (_pids[i] == pid) { ok = true; break; } }
        if (!ok) return true;
      } else if (pid == _myPid) {
        return true;
      }
      if (!IsWindowVisible(h)) return true;
      string cls = GetClassOf(h);
      if (_classes != null) {
        bool ok2 = false;
        for (int i = 0; i < _classes.Length; i++) { if (_classes[i] == cls) { ok2 = true; break; } }
        if (!ok2) return true;
      }
      if (_black != null) {
        for (int i = 0; i < _black.Length; i++) { if (_black[i] == cls) return true; }
      }
      if (_topMost) {
        long ex = GetWindowLongPtr(h, -20).ToInt64();
        if ((ex & 0x8L) == 0) return true;
      }
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left;
      int hh = r.Bottom - r.Top;
      if (w < _minW || w > _maxW || hh < _minH || hh > _maxH) return true;
      int cloaked = 0;
      DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;
      _cands.Add(h.ToInt64());
    } catch {
      /* never break enumeration */
    }
    return true;
  }

  // visible windows of the given processes whose class is in classes[]
  public static long[] FindClassWindows(uint[] pids, string[] classes) {
    _pids = pids; _classes = classes; _black = null; _topMost = false;
    _minW = 0; _maxW = 100000; _minH = 0; _maxH = 100000;
    _cands = new System.Collections.Generic.List<long>(16);
    EnumWindows(new EnumWindowsProc(CandProc), IntPtr.Zero);
    return _cands.ToArray();
  }

  // generic notification candidates: not ours, visible, not blacklisted, topmost,
  // notification-sized, not DWM-cloaked
  public static long[] FindNotifCandidates(uint myPid, string[] blacklist, int minW, int maxW, int minH, int maxH) {
    _pids = null; _myPid = myPid; _classes = null; _black = blacklist; _topMost = true;
    _minW = minW; _maxW = maxW; _minH = minH; _maxH = maxH;
    _cands = new System.Collections.Generic.List<long>(16);
    EnumWindows(new EnumWindowsProc(CandProc), IntPtr.Zero);
    return _cands.ToArray();
  }

  // ---- desktop wallpaper (SPI_SETDESKWALLPAPER = 20) ----
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
}
"@
Add-Type -TypeDefinition $code
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$regionFile = Join-Path $env:TEMP 'sci-region-cmd.txt'
$excludeFile = Join-Path $env:TEMP 'sci-exclude-cmd.txt'
$excludeResultFile = Join-Path $env:TEMP 'sci-exclude-result.txt'
$ptFile = Join-Path $env:TEMP 'sci-transparent-cmd.txt'
$wallpaperFile = Join-Path $env:TEMP 'sci-wallpaper-cmd.txt'
$wallpaperResultFile = Join-Path $env:TEMP 'sci-wallpaper-result.txt'
$script:toastCounter = 0
$script:toasts = @()
$script:notifFp = @{}
$script:notifSweep = 0
$script:BLACKLIST = @(
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow',
  '#32770', 'ConsoleWindowClass', 'DV2ControlHost', 'NotifyIconOverflowWindow'
)

# -- read notification text from ShellExperienceHost window via UI Automation --
function Get-NotificationText([intptr]$hwnd) {
  try {
    $ae = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $ae) { return '' }
    $name = [string]$ae.Current.Name
    if ($name -eq '') { return '' }
    $body = ''
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $texts = $ae.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($texts) {
      foreach ($t in $texts) {
        $n = [string]$t.Current.Name
        if ($n -ne '') { $body += $n + ' ' }
      }
    }
    return ($name + '|' + $body.Trim())
  } catch {
    return ''
  }
}

# -- enumerate visible ShellExperienceHost toast windows --
# Only "Windows.UI.Core.CoreWindow" windows are toast notifications;
# this excludes volume/brightness flyouts and other shell overlays.
# Enumeration runs in compiled code (FindClassWindows) - only the few toast
# windows reach the PowerShell side.
function Get-Toasts {
  $result = @()
  $exp = Get-Process -Name 'ShellExperienceHost' -ErrorAction SilentlyContinue
  if (-not $exp) { return $result }
  $pids = [uint32[]]@($exp | ForEach-Object { [uint32]$_.Id })
  if ($pids.Length -eq 0) { return $result }
  $handles = [Probe]::FindClassWindows($pids, [string[]]@('Windows.UI.Core.CoreWindow'))
  foreach ($h in $handles) {
    $info = Get-NotificationText([intptr]$h)
    if ($info -ne '') {
      $result += ($h.ToString() + '|' + $info)
    }
  }
  return $result
}

# -- generic notification windows (QQ NT / WeChat / any topmost small bubble) --
# Enumerate ALL visible topmost windows that are notification-sized (not fullscreen,
# not ours, not shell chrome, not cloaked). A candidate is reported only when its
# fingerprint (rect + window title) CHANGES - so a reused hwnd (QQ NT reuses its
# bubble window per message) is still detected as a new notification. Text is read
# via UI Automation; the main process dedupes by hwnd + full text.
function Get-GenericNotifs {
  $result = @()
  $myPid = 0
  try { $myPid = [uint32]$env:LGC_PID } catch { $myPid = 0 }
  # compiled enumeration: filtering (pid/visible/blacklist/topmost/size/cloaked)
  # happens in C#; only the surviving candidates are inspected from PowerShell
  $handles = [Probe]::FindNotifCandidates($myPid, [string[]]$script:BLACKLIST, 100, 720, 40, 520)
  $new = @()
  foreach ($h in $handles) {
    Assert-HostAlive
    $hInt = [intptr]$h
    $r = [Probe]::GetRectOf($hInt)
    if ($null -eq $r) { continue }
    $w = $r[2] - $r[0]
    $hh = $r[3] - $r[1]
    $title = [Probe]::GetTitleOf($hInt)
    $key = $h.ToString()
    $fp = "$($r[0]),$($r[1]),$w,$hh|$title"
    if ($script:notifFp.ContainsKey($key) -and $script:notifFp[$key] -eq $fp) { continue }
    $script:notifFp[$key] = $fp
    $new += $hInt
  }
  # sweep dead window entries every 25 cycles
  $script:notifSweep += 1
  if ($script:notifSweep -ge 25) {
    $script:notifSweep = 0
    $dead = @()
    foreach ($k in $script:notifFp.Keys) {
      if (-not [Probe]::IsWindow([intptr][int64]$k)) { $dead += $k }
    }
    foreach ($k in $dead) { [void]$script:notifFp.Remove($k) }
  }
  foreach ($hInt in $new) {
    Assert-HostAlive
    $info = Get-NotificationText($hInt)
    if ($info -ne '') {
      $result += ($hInt.ToInt64().ToString() + '|' + $info)
    }
  }
  return $result
}

# host process id (set by the app): if it disappears we must not linger as an orphan
$script:hostPid = 0
try { $script:hostPid = [uint32]$env:LGC_PID } catch { $script:hostPid = 0 }
if ($script:hostPid -gt 0 -and $null -eq (Get-Process -Id $script:hostPid -ErrorAction SilentlyContinue)) { exit }
$script:hostCheck = 0

# Called from inside long loops too (notification enumeration can sit in UI Automation
# for a while): without this an app that is hard-killed leaves us sampling forever.
function Assert-HostAlive {
  if ($script:hostPid -le 0) { return }
  $script:hostCheck += 1
  if (($script:hostCheck % 3) -ne 0) { return }
  if ($null -eq (Get-Process -Id $script:hostPid -ErrorAction SilentlyContinue)) { exit }
}

while ($true) {
  # -- exit if the host app is gone (hard kill / crash leaves no 'quit' on stdin) --
  Assert-HostAlive
  # -- rounded hit-region command --
  # format: "hwnd x y w h r"
  if (Test-Path -LiteralPath $regionFile) {
    try {
      $content = (Get-Content -LiteralPath $regionFile -Raw).Trim()
      $parts = $content.Split(' ')
      if ($parts.Length -ge 6) {
        $hwnd = [intptr][int64]$parts[0]
        $x = [int]$parts[1]
        $y = [int]$parts[2]
        $w = [int]$parts[3]
        $h = [int]$parts[4]
        $r = [int]$parts[5]
        if ($r -lt 1) { $r = 1 }
        $rgn = [Probe]::CreateRoundRectRgn($x, $y, ($x + $w), ($y + $h), $r, $r)
        if ($rgn -ne [intptr]::Zero) {
          [Probe]::SetWindowRgn($hwnd, $rgn, $true) | Out-Null
        }
      }
      Remove-Item -LiteralPath $regionFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $regionFile -Force -ErrorAction SilentlyContinue
    }
  }

  # -- exclude-from-capture command (WDA_EXCLUDEFROMCAPTURE = 0x11) --
  if (Test-Path -LiteralPath $excludeFile) {
    try {
      $content = (Get-Content -LiteralPath $excludeFile -Raw).Trim()
      if ($content.Length -gt 0) {
        $hwnd = [intptr][int64]$content
        $setOk = [Probe]::SetWindowDisplayAffinity($hwnd, 0x11)
        $aff = [uint32]0
        [void][Probe]::GetWindowDisplayAffinity($hwnd, [ref]$aff)
        Set-Content -LiteralPath $excludeResultFile -Value ("set=" + $setOk + " aff=" + $aff) -Encoding ASCII
      }
      Remove-Item -LiteralPath $excludeFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $excludeFile -Force -ErrorAction SilentlyContinue
    }
  }

  # -- mouse passthrough command (WS_EX_TRANSPARENT = 0x20; content "hwnd 0|1") --
  if (Test-Path -LiteralPath $ptFile) {
    try {
      $content = (Get-Content -LiteralPath $ptFile -Raw).Trim()
      $parts = $content.Split(' ')
      if ($parts.Length -ge 2) {
        $hwnd = [intptr][int64]$parts[0]
        $on = ($parts[1] -eq '1')
        $cur = [Probe]::GetWindowLongPtr($hwnd, -20).ToInt64()
        $new = 0
        if ($on) { $new = $cur -bor 0x20 } else { $new = $cur -band (-bnot 0x20) }
        if ($new -ne $cur) {
          [void][Probe]::SetWindowLongPtr($hwnd, -20, [intptr]$new)
        }
      }
      Remove-Item -LiteralPath $ptFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $ptFile -Force -ErrorAction SilentlyContinue
    }
  }

  # -- desktop wallpaper command (content = image path; SPI_SETDESKWALLPAPER=20, fWinIni=3) --
  if (Test-Path -LiteralPath $wallpaperFile) {
    try {
      $wpPath = (Get-Content -LiteralPath $wallpaperFile -Raw).Trim()
      if ($wpPath.Length -gt 0 -and (Test-Path -LiteralPath $wpPath)) {
        $setOk = [Probe]::SystemParametersInfo(20, 0, $wpPath, 3)
        Set-Content -LiteralPath $wallpaperResultFile -Value ("set=" + $setOk + " path=" + $wpPath) -Encoding ASCII
      } else {
        Set-Content -LiteralPath $wallpaperResultFile -Value "set=False path-missing" -Encoding ASCII
      }
      Remove-Item -LiteralPath $wallpaperFile -Force -ErrorAction SilentlyContinue
    } catch {
      Set-Content -LiteralPath $wallpaperResultFile -Value ("set=False error=" + $_.Exception.Message) -Encoding ASCII
      Remove-Item -LiteralPath $wallpaperFile -Force -ErrorAction SilentlyContinue
    }
  }

  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'quit') { break }
  # 'probe-lite': foreground/cursor/last-input only, skip notification enumeration
  # (used while the island is auto-hidden in fullscreen -> saves CPU)
  $lite = $false
  if ($line -eq 'probe-lite') { $lite = $true }
  elseif ($line -ne 'probe') { continue }

  $fg = [Probe]::GetForegroundWindow()
  $fgClass = ''
  if ($fg -ne [intptr]::Zero) {
    $clsSb = New-Object System.Text.StringBuilder 256
    [void][Probe]::GetClassName($fg, $clsSb, 256)
    $fgClass = $clsSb.ToString()
  }
  $r = [Probe+RECT]::new()
  $ok = [Probe]::GetWindowRect($fg, [ref]$r)
  $vis = [Probe]::IsWindowVisible($fg)
  $procId = 0
  [Probe]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
  $p = [Probe+POINT]::new()
  [Probe]::GetCursorPos([ref]$p) | Out-Null
  $li = [Probe+LASTINPUTINFO]::new()
  $li.cbSize = 8
  $gotLi = [Probe]::GetLastInputInfo([ref]$li)
  if ($gotLi) { $liVal = $li.dwTime } else { $liVal = 0 }

  # -- toast check: shell toasts every 3 probes, generic bubbles every probe --
  # probe-lite keeps the previous notification list (no enumeration, so no
  # "notification disappeared" false positives)
  if (-not $lite) {
    $script:toastCounter += 1
    if ($script:toastCounter -ge 3) {
      $script:toastCounter = 0
      $script:toasts = Get-Toasts
    }
    $script:toasts += Get-GenericNotifs
  }

  $rect = $null
  if ($ok) {
    $rect = @{ l = $r.Left; t = $r.Top; r = $r.Right; b = $r.Bottom }
  }
  $o = [ordered]@{
    fg      = $fg.ToInt64()
    fgClass = $fgClass
    vis     = [bool]$vis
    pid     = $procId
    rect    = $rect
    cx      = $p.X
    cy      = $p.Y
    li      = $liVal
    tick    = [Environment]::TickCount
    toasts  = $script:toasts
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
