$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = '1.0.4314.35'
$dependencyRoot = Join-Path $projectRoot '.deps'
$packagePath = Join-Path $dependencyRoot "webview2-$version.nupkg"
$sdkPath = Join-Path $dependencyRoot "webview2-$version"
New-Item -ItemType Directory -Path $dependencyRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $packagePath)) {
  Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $packagePath
}
if (-not (Test-Path -LiteralPath $sdkPath)) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $sdkPath)
}
Write-Output "WebView2 SDK $version ready."
