param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$agentProjectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
$agentCompilerBin = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$agentEnvironment = @{}
$agentSettings = @{
    CC_aarch64_linux_android = (Join-Path $agentCompilerBin 'aarch64-linux-android24-clang.cmd')
    CXX_aarch64_linux_android = (Join-Path $agentCompilerBin 'aarch64-linux-android24-clang++.cmd')
    AR_aarch64_linux_android = (Join-Path $agentCompilerBin 'llvm-ar.exe')
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = (Join-Path $agentCompilerBin 'aarch64-linux-android24-clang.cmd')
    RUSTFLAGS = '-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'
}
foreach ($agentName in $agentSettings.Keys) {
    $agentEnvironment[$agentName] = [Environment]::GetEnvironmentVariable($agentName, 'Process')
}
$agentPreviousPath = $env:PATH
try {
    foreach ($agentName in $agentSettings.Keys) {
        [Environment]::SetEnvironmentVariable($agentName, $agentSettings[$agentName], 'Process')
    }
    $env:PATH = $agentCompilerBin + ';' + $env:PATH
    $agentBuildArguments = @('build', '--manifest-path', (Join-Path $agentProjectRoot 'Cargo.toml'), '-p', 'android-agent-host', '--release', '--target', 'aarch64-linux-android', '--locked')
    if ($Offline) { $agentBuildArguments += '--offline' }
    & cargo @agentBuildArguments
    if ($LASTEXITCODE -ne 0) { throw 'The dedicated Android Agent host did not build.' }
} finally {
    foreach ($agentName in $agentSettings.Keys) {
        [Environment]::SetEnvironmentVariable($agentName, $agentEnvironment[$agentName], 'Process')
    }
    $env:PATH = $agentPreviousPath
}
