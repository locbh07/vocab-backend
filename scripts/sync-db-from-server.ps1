param(
  [ValidateSet("staging", "production")]
  [string]$From = "staging",

  [string]$LocalEnvFile = ".env.local",

  [string]$Schema = "public",

  [string]$PgBinDir = "",

  [switch]$SkipBackup,

  [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-EnvValueFromFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing env file: $Path"
  }

  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
  if (-not $line) {
    throw "Cannot find key '$Key' in $Path"
  }

  $value = ($line -replace "^\s*$Key\s*=\s*", "").Trim()
  if ($value.StartsWith('"') -and $value.EndsWith('"')) {
    $value = $value.Trim('"')
  } elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
    $value = $value.Trim("'")
  }

  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Key '$Key' is empty in $Path"
  }

  return $value
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  Write-Host ">> $FilePath $($Arguments -join ' ')" -ForegroundColor Cyan
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
  }
}

function Resolve-PgToolPath {
  param(
    [Parameter(Mandatory = $true)][string]$ToolName,
    [string]$PreferredBinDir = ""
  )

  if (-not [string]::IsNullOrWhiteSpace($PreferredBinDir)) {
    $candidate = Join-Path $PreferredBinDir "$ToolName.exe"
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
    throw "Cannot find $ToolName.exe in PgBinDir: $PreferredBinDir"
  }

  $windowsPgRoot = "C:\Program Files\PostgreSQL"
  if (Test-Path -LiteralPath $windowsPgRoot) {
    $dirs = Get-ChildItem -LiteralPath $windowsPgRoot -Directory | Sort-Object {
      try { [version]$_.Name } catch { [version]"0.0" }
    } -Descending
    foreach ($dir in $dirs) {
      $candidate = Join-Path $dir.FullName "bin\$ToolName.exe"
      if (Test-Path -LiteralPath $candidate) {
        return $candidate
      }
    }
  }

  $cmd = Get-Command $ToolName -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw "$ToolName not found. Install PostgreSQL client tools and ensure $ToolName is in PATH."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverEnvFile = Join-Path $root ".env.$From"
$localEnvPath = if ([System.IO.Path]::IsPathRooted($LocalEnvFile)) { $LocalEnvFile } else { Join-Path $root $LocalEnvFile }
$backupDir = Join-Path $root "backups\db-sync"

$null = New-Item -ItemType Directory -Path $backupDir -Force

$pgDumpPath = Resolve-PgToolPath -ToolName "pg_dump" -PreferredBinDir $PgBinDir
$pgRestorePath = Resolve-PgToolPath -ToolName "pg_restore" -PreferredBinDir $PgBinDir

$serverDbUrl = Get-EnvValueFromFile -Path $serverEnvFile -Key "DATABASE_URL"
$localDbUrl = Get-EnvValueFromFile -Path $localEnvPath -Key "DATABASE_URL"

if ($serverDbUrl -eq $localDbUrl) {
  throw "Server DATABASE_URL and local DATABASE_URL are identical. Aborting to avoid destructive overwrite."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$serverDumpPath = Join-Path $backupDir "$From-$timestamp.dump"
$localBackupPath = Join-Path $backupDir "local-before-sync-$timestamp.dump"

Write-Host "Sync source : $serverEnvFile" -ForegroundColor Yellow
Write-Host "Sync target : $localEnvPath" -ForegroundColor Yellow
Write-Host "Backup dir  : $backupDir" -ForegroundColor Yellow
Write-Host "pg_dump     : $pgDumpPath" -ForegroundColor Yellow
Write-Host "pg_restore  : $pgRestorePath" -ForegroundColor Yellow
Write-Host "schema      : $Schema" -ForegroundColor Yellow

if ($WhatIf) {
  Write-Host "WhatIf mode enabled. No command will be executed." -ForegroundColor Magenta
  if (-not $SkipBackup) {
    Write-Host "Would run local backup to $localBackupPath" -ForegroundColor Magenta
  }
  Write-Host "Would dump $From DB to $serverDumpPath" -ForegroundColor Magenta
  Write-Host "Would restore dump into local DB with --clean --if-exists" -ForegroundColor Magenta
  exit 0
}

if (-not $SkipBackup) {
  Invoke-External -FilePath $pgDumpPath -Arguments @(
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file=$localBackupPath",
    $localDbUrl
  )
}

Invoke-External -FilePath $pgDumpPath -Arguments @(
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  "--file=$serverDumpPath",
  $serverDbUrl
)

Invoke-External -FilePath $pgRestorePath -Arguments @(
  "--schema=$Schema",
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-privileges",
  "--dbname=$localDbUrl",
  $serverDumpPath
)

Write-Host ""
Write-Host "Database sync completed successfully." -ForegroundColor Green
if (-not $SkipBackup) {
  Write-Host "Local backup: $localBackupPath" -ForegroundColor Green
}
Write-Host "Server dump : $serverDumpPath" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1) npm run env:local"
Write-Host "2) npm run prisma -- generate"
