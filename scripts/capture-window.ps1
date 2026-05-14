# Capture a Windows window's contents to a PNG by title.
#   pwsh -NoProfile -File scripts/capture-window.ps1 -Title "LoopDec" -Out docs/screenshots/idle.png
#
# Brings the window to the foreground first (unminimized if needed),
# waits a beat for the redraw, then bitblts its client area.

param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Out
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinCap {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  public const int SW_RESTORE = 9;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
}
"@

Add-Type -AssemblyName System.Drawing

$proc = Get-Process |
  Where-Object { $_.MainWindowTitle -like "*$Title*" -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proc) {
  Write-Error "No visible window with title matching '$Title'."
  exit 1
}

$hwnd = $proc.MainWindowHandle

if ([WinCap]::IsIconic($hwnd)) {
  [WinCap]::ShowWindow($hwnd, [WinCap]::SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 250
}

# Send Alt to release focus restrictions (Windows lets the calling process take foreground
# briefly after a key event), then SwitchToThisWindow is the most reliable raise primitive.
$wshell = New-Object -ComObject WScript.Shell
$wshell.SendKeys('%') | Out-Null
Start-Sleep -Milliseconds 80
[WinCap]::SwitchToThisWindow($hwnd, $true)
[WinCap]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object WinCap+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS excludes invisible resize borders (~7px on each side on Windows 10+).
$hr = [WinCap]::DwmGetWindowAttribute($hwnd, [WinCap]::DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
if ($hr -ne 0) {
  [WinCap]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
}
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) {
  Write-Error "Window has no area (w=$w h=$h)."
  exit 1
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "Saved $Out ($w x $h)"
