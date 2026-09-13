# Probe end-to-end check (ASCII only, run with powershell.exe -Sta)
# 1) starts a win-probe.ps1 copy with the same args the app uses
# 2) creates a real notification-sized topmost window + fires a real shell toast
# 3) sends "probe" lines and prints the JSON lines, so the notice path
#    (window enumeration -> candidate filter -> UIA text) can be verified
# Usage: powershell -Sta -NoProfile -ExecutionPolicy Bypass -File scripts/test-probe.ps1 [-ProbeScript <path>] [-OwnerPid <n>]
param(
  [string]$ProbeScript,
  [int]$OwnerPid = 999999
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $ProbeScript) { $ProbeScript = Join-Path $root 'src\main\win-probe.ps1' }
$script = (Resolve-Path $ProbeScript).Path
"PROBE_SCRIPT=$script"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-Sta -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $false
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['LGC_PID'] = "$OwnerPid"
$proc = [System.Diagnostics.Process]::Start($psi)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Simulated Notify App'
$form.Size = New-Object System.Drawing.Size(320, 140)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(900, 500)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Hello from the simulated notification body'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(16, 40)
$form.Controls.Add($label)
$form.Show()
$form.TopMost = $true

# a genuine WS_EX_TOPMOST window created via CreateWindowEx (WinForms cannot set the
# extended style reliably in every session) - satisfies the probe's topmost filter
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RawWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateWindowExW(long exStyle, string cls, string title, long style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
}
"@
$raw = [RawWin]::CreateWindowExW(0x8L, 'Static', 'Raw Notify Bubble', 0x80000000L, 700, 400, 360, 160, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
if ($raw -ne [IntPtr]::Zero) {
  [void][RawWin]::ShowWindow($raw, 5)
  "RAW_WINDOW_CREATED handle=$raw"
} else {
  "RAW_WINDOW_FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

# real shell toast (exercises the ShellExperienceHost / toast path)
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $tmpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $tmpl.GetElementsByTagName('text')
  [void]$texts[0].AppendChild($tmpl.CreateTextNode('Probe Test Title'))
  [void]$texts[1].AppendChild($tmpl.CreateTextNode('Probe test body'))
  $toast = New-Object Windows.UI.Notifications.ToastNotification $tmpl
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Smart Counter Island Probe Test').Show($toast)
  "TOAST_FIRED"
} catch {
  "TOAST_FAILED: " + $_.Exception.Message
}

$seen = $false
for ($i = 1; $i -le 8; $i++) {
  $proc.StandardInput.WriteLine('probe')
  $proc.StandardInput.Flush()
  $line = $proc.StandardOutput.ReadLine()
  if ($line) {
    $o = $line | ConvertFrom-Json
    "probe#$i RAW=$line"
    foreach ($t in @($o.toasts)) { if ($t -ne $null -and "$t" -ne '') { "   toast: [$t]"; $seen = $true } }
  } else {
    "probe#$i <no output>"
  }
  Start-Sleep -Milliseconds 400
}
$proc.StandardInput.WriteLine('quit')
$proc.StandardInput.Flush()
Start-Sleep -Milliseconds 400
if (-not $proc.HasExited) { $proc.Kill() }
$form.Close()
if ($raw -ne [IntPtr]::Zero) { [void][RawWin]::DestroyWindow($raw) }
"RESULT=" + $(if ($seen) { 'NOTIFY_PATH_OK' } else { 'NO_TOAST_DETECTED' })
