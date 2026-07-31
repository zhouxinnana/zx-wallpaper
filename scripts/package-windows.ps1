param(
  [switch]$Unpacked,
  [switch]$NoPublish
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$toolsRoot = Join-Path $projectRoot 'tools\\electron-builder'
$nsisDirectory = Join-Path $toolsRoot 'nsis-3.0.4.1'
$rceditPath = Join-Path $toolsRoot 'winCodeSign-2.6.0\\rcedit-x64.exe'

if (-not (Test-Path -LiteralPath (Join-Path $nsisDirectory 'Bin\\makensis.exe'))) {
  throw "Missing local NSIS tool: $nsisDirectory"
}
if (-not (Test-Path -LiteralPath $rceditPath)) {
  throw "Missing local rcedit tool: $rceditPath"
}

& (Join-Path $projectRoot 'scripts\\generate-icon-assets.ps1')
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE" }

$env:ELECTRON_BUILDER_NSIS_DIR = $nsisDirectory
$env:ZX_WALLPAPER_RCEDI_PATH = $rceditPath
$target = if ($Unpacked) { 'dir' } else { 'nsis' }
$builderArguments = @('--win', $target, '--config.win.signAndEditExecutable=false')
if ($NoPublish) { $builderArguments += @('--publish', 'never') }
& npx.cmd electron-builder @builderArguments
if ($LASTEXITCODE -ne 0) { throw "Electron Builder failed with exit code $LASTEXITCODE" }
