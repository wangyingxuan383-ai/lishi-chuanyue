# Dot-source this file: . .\scripts\Enter-Dev.ps1
param(
    [string]$JavaHome,
    [string]$AndroidHome,
    [string]$NdkVersion = '28.2.13676358'
)

$projectRoot = Split-Path $PSScriptRoot -Parent
$configPath = Join-Path $projectRoot '.private\toolchain.json'
$localConfig = if (Test-Path -LiteralPath $configPath) {
    Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
} else { $null }

if (!$JavaHome) { $JavaHome = $env:JAVA_HOME }
if (!$JavaHome -and $localConfig) { $JavaHome = $localConfig.javaHome }
if (!$AndroidHome) { $AndroidHome = $env:ANDROID_HOME }
if (!$AndroidHome -and $localConfig) { $AndroidHome = $localConfig.androidHome }
if (!$AndroidHome) { $AndroidHome = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$newPaths = @($cargoBin)
if ($JavaHome) {
    if (!(Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
        throw 'JDK path is invalid. Pass -JavaHome or set .private/toolchain.json.'
    }
    $env:JAVA_HOME = $JavaHome
    $newPaths += Join-Path $JavaHome 'bin'
}
if (Test-Path -LiteralPath $AndroidHome) {
    $env:ANDROID_HOME = $AndroidHome
    $env:NDK_HOME = Join-Path $AndroidHome "ndk\$NdkVersion"
    $newPaths += Join-Path $AndroidHome 'platform-tools'
    $newPaths += Join-Path $AndroidHome 'cmdline-tools\latest\bin'
}
$env:PATH = ($newPaths -join ';') + ';' + $env:PATH
# Tauri's beforeBuildCommand calls `pnpm`; provide a corepack shim when it is not on PATH.
if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
    $shimDir = Join-Path $projectRoot '.cache\bin'
    if (!(Test-Path -LiteralPath (Join-Path $shimDir 'pnpm.CMD'))) {
        New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
        corepack enable pnpm --install-directory $shimDir | Out-Null
    }
    $env:PATH = $shimDir + ';' + $env:PATH
}
if (!$env:GRADLE_USER_HOME) {
    $env:GRADLE_USER_HOME = Join-Path $projectRoot '.cache\gradle'
}
if ($localConfig -and $localConfig.javaProxyHost -and $localConfig.javaProxyPort) {
    $proxyHost = [string]$localConfig.javaProxyHost
    $proxyPort = [int]$localConfig.javaProxyPort
    if ($proxyHost -notmatch '^[a-zA-Z0-9.:-]+$' -or $proxyPort -lt 1 -or $proxyPort -gt 65535) {
        throw 'Invalid local Java proxy configuration.'
    }
    $env:GRADLE_OPTS = "$env:GRADLE_OPTS -Dhttps.proxyHost=$proxyHost -Dhttps.proxyPort=$proxyPort -Dhttp.proxyHost=$proxyHost -Dhttp.proxyPort=$proxyPort -Dhttp.nonProxyHosts=localhost"
}

Write-Host 'Project tool paths are active in this PowerShell process only.'
