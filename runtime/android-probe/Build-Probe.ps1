param(
    [Parameter(Mandatory = $true)][string]$NativeDirectory,
    [string]$RuntimeDirectory,
    [string]$NativeNoticesDirectory,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $projectDirectory 'scripts/Enter-Dev.ps1')
if (!$RuntimeDirectory) { $RuntimeDirectory = Join-Path $projectDirectory 'agent-host/.cache/runtime' }
$RuntimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$probeCache = Join-Path $projectDirectory '.cache/r19/android-probe'
$probeTarget = Join-Path $probeCache 'rust-target'
$probeTls = Join-Path $probeCache 'test-tls'
New-Item -ItemType Directory -Force -Path $probeTls, (Join-Path $NativeDirectory 'arm64-v8a') | Out-Null
$NativeDirectory = (Resolve-Path -LiteralPath $NativeDirectory).Path
$env:CARGO_TARGET_DIR = $probeTarget
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd'
$env:RUSTFLAGS = '-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'
& cargo build --manifest-path (Join-Path $PSScriptRoot 'bridge/Cargo.toml') --target aarch64-linux-android --release --locked --offline
if ($LASTEXITCODE -ne 0) { throw 'The owned Rust JNI gateway did not build' }
Copy-Item -LiteralPath (Join-Path $probeTarget 'aarch64-linux-android/release/liblishi_pi_probe_gateway.so') -Destination (Join-Path $NativeDirectory 'arm64-v8a/liblishi_pi_probe_gateway.so')
if ($probeTls -notmatch '^([A-Za-z]):[\\/](.+)$') { throw 'A drive-qualified owned TLS cache directory is required' }
$probeTlsLinux = '/mnt/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2].Replace('\', '/')
$tlsArguments = @('-d', 'Ubuntu-24.04', '-u', 'root', '--', 'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', "$probeTlsLinux/tls-key.pem", '-out', "$probeTlsLinux/tls-cert.pem", '-days', '7', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1')
$tlsArgumentLine = ($tlsArguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$tlsProcess = Start-Process -FilePath (Join-Path $env:WINDIR 'System32/wsl.exe') -ArgumentList $tlsArgumentLine -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $probeCache 'test-tls-generation.stdout.log') -RedirectStandardError (Join-Path $probeCache 'test-tls-generation.stderr.log')
if ($tlsProcess.ExitCode -ne 0) { throw 'The ignored, probe-only TLS fixture did not generate' }
if ($PrepareOnly) { Write-Host "Prepared owned fixtures in $probeCache"; return }
if (!$NativeNoticesDirectory) { throw 'Provide the verified native runtime notices directory for APK packaging' }
$NativeNoticesDirectory = (Resolve-Path -LiteralPath $NativeNoticesDirectory).Path
$probeJavaTemp = Join-Path $probeCache 'tmp'
New-Item -ItemType Directory -Force -Path $probeJavaTemp | Out-Null
# Keep JDK local socket paths in the owned build cache, not a short-name TEMP path.
$probePriorJavaToolOptions = $env:JAVA_TOOL_OPTIONS
try {
    $env:JAVA_TOOL_OPTIONS = "$probePriorJavaToolOptions `"-Djdk.net.unixdomain.tmpdir=$probeJavaTemp`""
    $gradleFiles = @(Get-ChildItem -LiteralPath (Join-Path $env:GRADLE_USER_HOME 'wrapper/dists/gradle-9.6.1-bin') -Recurse -Filter gradle.bat | Select-Object -ExpandProperty FullName)
    if ($gradleFiles.Count -ne 1) { throw 'Expected the pinned Gradle 9.6.1 runtime' }
    & $gradleFiles[0] -p $PSScriptRoot --no-daemon --offline "-PpiRuntimeDirectory=$RuntimeDirectory" "-PpiNativeDirectory=$NativeDirectory" "-PpiNativeNoticesDirectory=$NativeNoticesDirectory" "-PpiTestTlsDirectory=$probeTls" :app:assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'The isolated probe APK did not build' }
} finally {
    $env:JAVA_TOOL_OPTIONS = $probePriorJavaToolOptions
}
$probeApk = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
Get-Item -LiteralPath $probeApk | Select-Object FullName, Length
$probeHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$probeHashStream = [System.IO.File]::OpenRead($probeApk)
try {
    $probeHash = [System.BitConverter]::ToString($probeHashAlgorithm.ComputeHash($probeHashStream)).Replace('-', '').ToLowerInvariant()
    [pscustomobject]@{ Algorithm = 'SHA256'; Hash = $probeHash; Path = $probeApk }
} finally {
    $probeHashStream.Dispose()
    $probeHashAlgorithm.Dispose()
}
