# Local verification only. This script never calls a model endpoint or uses API keys.
param(
    [switch]$BuildWindows,
    [switch]$BuildAndroid,
    [switch]$AndroidTests
)

$ErrorActionPreference = 'Stop'
if ($AndroidTests -and !$BuildAndroid) {
    throw '-AndroidTests requires -BuildAndroid so the test APK matches the native source.'
}
$taskProjectRoot = [System.IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
$taskStarted = [DateTimeOffset]::UtcNow
$taskChecks = [System.Collections.Generic.List[object]]::new()
$taskArtifacts = [System.Collections.Generic.List[object]]::new()
$taskSuccess = $false
$taskRecordPath = Join-Path $taskProjectRoot ('.cache\validation\verify-' + $taskStarted.ToString('yyyyMMddTHHmmssfffZ') + '.json')

function Invoke-ProjectCheck {
    param([string]$Name, [string]$Executable, [string[]]$Arguments)
    Write-Host "Checking: $Name"
    $checkTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $exitCode = $null
    try {
        & $Executable @Arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw "Check failed: $Name (exit $exitCode)." }
    } finally {
        $checkTimer.Stop()
        $taskChecks.Add([ordered]@{ name = $Name; exitCode = $exitCode; elapsedMs = $checkTimer.ElapsedMilliseconds })
    }
}

function Add-VerifiedArtifact {
    param([string]$RelativePath)
    $artifactPath = Join-Path $taskProjectRoot $RelativePath
    if (!(Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "Missing build artifact: $RelativePath" }
    $artifactFile = Get-Item -LiteralPath $artifactPath
    $taskArtifacts.Add([ordered]@{ path = $RelativePath; bytes = $artifactFile.Length;
        sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() })
}

Push-Location -LiteralPath $taskProjectRoot
try {
    Invoke-ProjectCheck 'Rust format' 'cargo' @('fmt', '--all', '--', '--check')
    Invoke-ProjectCheck 'Rust lint' 'cargo' @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings')
    Invoke-ProjectCheck 'Core and shell tests' 'cargo' @('test', '--workspace')
    Invoke-ProjectCheck 'Frontend types and build' 'pnpm' @('build')
    Invoke-ProjectCheck 'POST fixture syntax' 'node' @('--check', 'scripts/model-fixture.mjs')
    Invoke-ProjectCheck 'GET fixture syntax' 'node' @('--check', 'scripts/stream-fixture.mjs')
    Invoke-ProjectCheck 'Durable context documents' 'node' @('scripts/check-docs.mjs')
    if ($BuildWindows) {
        Invoke-ProjectCheck 'Windows debug build' 'pnpm' @('tauri', 'build', '--debug', '--no-bundle')
        Add-VerifiedArtifact 'target\debug\lishi-app.exe'
    }
    if ($BuildAndroid) {
        Invoke-ProjectCheck 'Android ARM64 debug build' 'pnpm' @('tauri', 'android', 'build', '--debug', '--target', 'aarch64', '--apk', '--ci')
        Add-VerifiedArtifact 'src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk'
    }
    if ($AndroidTests) {
        Invoke-ProjectCheck 'Android instrumentation compile only' '.\src-tauri\gen\android\gradlew.bat' @(
            '-p', 'src-tauri/gen/android', ':app:assembleUniversalDebugAndroidTest',
            '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64',
            '-x', ':app:rustBuildUniversalDebug', '-x', ':app:rustBuildArm64Debug')
        Add-VerifiedArtifact 'src-tauri\gen\android\app\build\outputs\apk\androidTest\universal\debug\app-universal-debug-androidTest.apk'
    }
    $taskSuccess = $true
} finally {
    Pop-Location
    $taskCompleted = [DateTimeOffset]::UtcNow
    [System.IO.Directory]::CreateDirectory((Split-Path $taskRecordPath -Parent)) | Out-Null
    $record = [ordered]@{
        startedAt = $taskStarted.ToOffset([TimeSpan]::FromHours(8)).ToString('o')
        finishedAt = $taskCompleted.ToOffset([TimeSpan]::FromHours(8)).ToString('o')
        success = $taskSuccess
        checks = $taskChecks.ToArray()
        artifacts = $taskArtifacts.ToArray()
        deviceTestsExecuted = $false
        modelRequestsExecuted = $false
    }
    [System.IO.File]::WriteAllText($taskRecordPath, ($record | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Verification record: $taskRecordPath"
}
