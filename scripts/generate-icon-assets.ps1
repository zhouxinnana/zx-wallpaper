param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\\build')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$pngPath = Join-Path $OutputDirectory 'zx-wallpaper.png'
$icoPath = Join-Path $OutputDirectory 'zx-wallpaper.ico'
$bitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-Points([int[]]$coordinates) {
  $points = [System.Collections.Generic.List[System.Drawing.Point]]::new()
  for ($index = 0; $index -lt $coordinates.Length; $index += 2) {
    $points.Add([System.Drawing.Point]::new($coordinates[$index], $coordinates[$index + 1]))
  }
  return $points.ToArray()
}

[System.Drawing.Point[]]$background = New-Points @(44, 12, 212, 12, 244, 44, 244, 212, 212, 244, 44, 244, 12, 212, 12, 44)
[System.Drawing.Point[]]$zGlyph = New-Points @(54, 60, 172, 60, 172, 88, 108, 88, 182, 168, 182, 196, 54, 196, 54, 168, 126, 168, 54, 88)

$graphics.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 17, 22, 28)), $background)
$graphics.DrawPolygon([System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 121, 131, 142), 6), $background)
$graphics.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 238, 242, 245)), $zGlyph)
$xPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 170, 180, 190), 26)
$xPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
$xPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
$graphics.DrawLine($xPen, 156, 60, 208, 196)
$graphics.DrawLine($xPen, 208, 60, 156, 196)
$xPen.Dispose()
$graphics.Dispose()
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$iconBytes = [byte[]]::new(22 + $pngBytes.Length)
[BitConverter]::GetBytes([UInt16]0).CopyTo($iconBytes, 0)
[BitConverter]::GetBytes([UInt16]1).CopyTo($iconBytes, 2)
[BitConverter]::GetBytes([UInt16]1).CopyTo($iconBytes, 4)
$iconBytes[6] = 0
$iconBytes[7] = 0
[BitConverter]::GetBytes([UInt16]1).CopyTo($iconBytes, 10)
[BitConverter]::GetBytes([UInt16]32).CopyTo($iconBytes, 12)
[BitConverter]::GetBytes([UInt32]$pngBytes.Length).CopyTo($iconBytes, 14)
[BitConverter]::GetBytes([UInt32]22).CopyTo($iconBytes, 18)
$pngBytes.CopyTo($iconBytes, 22)
[System.IO.File]::WriteAllBytes($icoPath, $iconBytes)
