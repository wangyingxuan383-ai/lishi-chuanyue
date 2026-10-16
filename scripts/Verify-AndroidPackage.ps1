# Offline APK validation only: no device connection, signing or API requests.
param(
    [Parameter(Mandatory=$true)][string]$ApkPath,
    [ValidateSet('debug','release')][string]$Profile='release',
    [string]$ReferenceApk,
    [switch]$AllowUnsigned,
    [switch]$RequireR8,
    [string]$OutputPath
)
$ErrorActionPreference='Stop'
$packageProjectRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $PSScriptRoot 'Enter-Dev.ps1')
if (!$OutputPath) { $OutputPath=Join-Path $packageProjectRoot ('.cache\validation\apk-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'.json') }
$packageArguments=@((Join-Path $PSScriptRoot 'check-android-package.py'),'--apk',[IO.Path]::GetFullPath($ApkPath),'--native',(Join-Path $packageProjectRoot "target\aarch64-linux-android\$Profile\liblishi_app_lib.so"),'--output',[IO.Path]::GetFullPath($OutputPath))
if ($ReferenceApk) { $packageArguments+=@('--reference-apk',[IO.Path]::GetFullPath($ReferenceApk)) }
if ($AllowUnsigned) { $packageArguments+='--allow-unsigned' }
if ($RequireR8) { $packageArguments+='--require-r8' }
if ($Profile -eq 'release') { $packageArguments+='--require-non-debuggable' }
& python @packageArguments
if ($LASTEXITCODE -ne 0) { throw 'APK checks failed; no device/credential action performed.' }
