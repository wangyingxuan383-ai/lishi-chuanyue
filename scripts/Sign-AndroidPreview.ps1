# Private optimized preview only. Never installs or changes the application ID.
# Signing passwords must be supplied through the named process environment vars.
param(
    [Parameter(Mandatory=$true)][string]$UnsignedApk,
    [Parameter(Mandatory=$true)][string]$ReferenceApk,
    [Parameter(Mandatory=$true)][string]$KeystorePath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [string]$KeyAlias='androiddebugkey',
    # v2 shrank release builds with R8; v3 keeps Tauri's default (no R8) until it is tested on a phone.
    [switch]$RequireR8
)
$ErrorActionPreference='Stop'
$previewRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
if (!$env:LISHI_SIGNING_STORE_PASSWORD) { throw 'Set LISHI_SIGNING_STORE_PASSWORD for this process. Never put it in Git, logs or command arguments.' }
$previewOutput=[IO.Path]::GetFullPath($OutputPath)
$previewAllowed=@('.cache','.private') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $previewRoot $_))+[IO.Path]::DirectorySeparatorChar }
if (!($previewAllowed | Where-Object { $previewOutput.StartsWith($_,[StringComparison]::OrdinalIgnoreCase) }) -or [IO.Path]::GetExtension($previewOutput) -ne '.apk') { throw 'Preview output must be a new APK under this project .cache or .private directory.' }
$previewReport=$previewOutput+'.checks.json'
if ((Test-Path -LiteralPath $previewOutput) -or (Test-Path -LiteralPath $previewReport)) { throw 'Preview output/report already exists; choose a new name. Existing artifacts are preserved.' }
foreach ($previewInput in @($UnsignedApk,$ReferenceApk,$KeystorePath)) {
    if (!(Test-Path -LiteralPath $previewInput -PathType Leaf)) { throw 'Required input/signing material missing.' }
}
$previewSigner=Join-Path $env:ANDROID_HOME 'build-tools\36.0.0\apksigner.bat'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($previewOutput)) | Out-Null
$previewStage=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($previewOutput)) ('.sign-'+[Guid]::NewGuid().ToString('N'))))
if (!($previewAllowed | Where-Object { $previewStage.StartsWith($_,[StringComparison]::OrdinalIgnoreCase) })) { throw 'Invalid private staging directory.' }
[IO.Directory]::CreateDirectory($previewStage) | Out-Null
$previewStageApk=Join-Path $previewStage 'preview.apk'
$previewStageReport=$previewStageApk+'.checks.json'
$previewPublishedReport=$false
try {
    $previewToolArguments=@('sign','--ks',[IO.Path]::GetFullPath($KeystorePath),'--ks-key-alias',$KeyAlias,'--ks-pass','env:LISHI_SIGNING_STORE_PASSWORD','--v2-signing-enabled','true','--v4-signing-enabled','false','--out',$previewStageApk)
    if ($env:LISHI_SIGNING_KEY_PASSWORD) { $previewToolArguments+=@('--key-pass','env:LISHI_SIGNING_KEY_PASSWORD') }
    & $previewSigner @previewToolArguments ([IO.Path]::GetFullPath($UnsignedApk))
    if ($LASTEXITCODE -ne 0) { throw 'Preview signing failed. No application/device was modified.' }
    & (Join-Path $PSScriptRoot 'Verify-AndroidPackage.ps1') -ApkPath $previewStageApk -Profile release -ReferenceApk $ReferenceApk -RequireR8:$RequireR8 -OutputPath $previewStageReport
    $previewChecked=Get-Content -LiteralPath $previewStageReport -Raw | ConvertFrom-Json
    $previewChecked.apk=$previewOutput
    [IO.File]::WriteAllText($previewStageReport,($previewChecked | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    # Move refuses to overwrite. Publish the APK only after every check passed.
    # If the final move fails, roll back only the report this invocation created.
    [IO.File]::Move($previewStageReport,$previewReport)
    $previewPublishedReport=$true
    try { [IO.File]::Move($previewStageApk,$previewOutput) }
    catch {
        if ($previewPublishedReport) { [IO.File]::Delete($previewReport) }
        throw
    }
}
finally {
    # Delete only exact files owned by this invocation, never a recursive tree.
    foreach ($previewTemporaryFile in @($previewStageApk,$previewStageReport,($previewStageApk+'.idsig'))) {
        if (Test-Path -LiteralPath $previewTemporaryFile -PathType Leaf) { [IO.File]::Delete($previewTemporaryFile) }
    }
    if (Test-Path -LiteralPath $previewStage -PathType Container) { [IO.Directory]::Delete($previewStage,$false) }
}
Write-Host 'Private preview signed and checked against the reference certificate. Device upgrade still requires actual verification.'
