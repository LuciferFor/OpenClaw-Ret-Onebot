[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Profile,

  [switch]$SkipBuild,
  [switch]$SkipTests,
  [switch]$SkipServiceInstall
)

$ErrorActionPreference = "Stop"

function Read-ProfileFile {
  param([string]$Path)
  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $idx = $trimmed.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $result[$key] = $value
  }
  return $result
}

function Require-Value {
  param([hashtable]$Config, [string]$Key)
  if (-not $Config.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace([string]$Config[$Key])) {
    throw "Missing required profile key: $Key"
  }
  return [string]$Config[$Key]
}

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File failed with exit code $LASTEXITCODE"
  }
}

function Quote-Remote {
  param([string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-RemoteDir {
  param([string]$Path)
  $normalized = $Path.Replace("\", "/")
  $idx = $normalized.LastIndexOf("/")
  if ($idx -lt 1) {
    throw "Remote path must be absolute and contain a directory: $Path"
  }
  return $normalized.Substring(0, $idx)
}

function New-ServiceFile {
  param([hashtable]$Config)

  $serviceName = Require-Value $Config "SERVICE_NAME"
  $mode = (Require-Value $Config "DEPLOY_MODE").ToLowerInvariant()

  if ($mode -eq "docker") {
    $container = Require-Value $Config "CONTAINER_NAME"
    $sidecarContainerPath = Require-Value $Config "SIDECAR_CONTAINER_PATH"
    return @"
[Unit]
Description=OpenClaw OneBot reliable sidecar hook
After=network-online.target docker.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker exec $container sh -lc "/usr/bin/pkill -9 -f 'node .*openclaw-onebot-sidecar.mjs' || true"
ExecStart=/usr/bin/docker exec $container node $sidecarContainerPath
ExecStopPost=-/usr/bin/docker exec $container sh -lc "/usr/bin/pkill -9 -f 'node .*openclaw-onebot-sidecar.mjs' || true"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"@
  }

  if ($mode -ne "native") {
    throw "DEPLOY_MODE must be docker or native, got: $mode"
  }

  $serviceUser = $Config["SERVICE_USER"]
  if ([string]::IsNullOrWhiteSpace([string]$serviceUser)) {
    $serviceUser = Require-Value $Config "REMOTE_USER"
  }
  $nodeBin = Require-Value $Config "NODE_BIN"
  $sidecarHostPath = Require-Value $Config "SIDECAR_HOST_PATH"

  $envKeys = @(
    "OPENCLAW_CONFIG_PATH",
    "ONEBOT_PLUGIN_ROOT",
    "OPENCLAW_MAIN_SESSIONS_PATH",
    "OPENCLAW_GATEWAY_WS",
    "OPENCLAW_TRUSTED_USER",
    "ONEBOT_AGENT_ID",
    "ONEBOT_WS_PACKAGE",
    "ONEBOT_SIDECAR_WS_URL",
    "ONEBOT_SIDECAR_HTTP_URL",
    "ONEBOT_ASSISTANT_IDLE_TIMEOUT_MS",
    "ONEBOT_ASSISTANT_MAX_WAIT_MS",
    "ONEBOT_ASSISTANT_TIMEOUT_MS",
    "ONEBOT_ASSISTANT_CATCHUP_SCAN_MS",
    "ONEBOT_ASSISTANT_SETTLE_MS",
    "ONEBOT_PENDING_FINAL_WAIT_MS",
    "ONEBOT_INBOUND_TEXT_DEBOUNCE_MS",
    "ONEBOT_INBOUND_MEDIA_GRACE_MS",
    "ONEBOT_INBOUND_MAX_BATCH_MS"
  )
  $envLines = @("Environment=HOME=/home/$serviceUser")
  foreach ($key in $envKeys) {
    if ($Config.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace([string]$Config[$key])) {
      $envLines += "Environment=$key=$($Config[$key])"
    }
  }
  $envText = $envLines -join "`n"

  return @"
[Unit]
Description=OpenClaw OneBot reliable sidecar hook
After=network-online.target

[Service]
Type=simple
User=$serviceUser
WorkingDirectory=/home/$serviceUser/.openclaw
$envText
ExecStart=$nodeBin $sidecarHostPath
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"@
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$profilePath = Resolve-Path $Profile
$config = Read-ProfileFile -Path $profilePath

$remoteHost = Require-Value $config "REMOTE_HOST"
$remoteUser = Require-Value $config "REMOTE_USER"
$pluginRoot = Require-Value $config "PLUGIN_ROOT_HOST"
$sidecarHostPath = Require-Value $config "SIDECAR_HOST_PATH"
$sidecarHostDir = Get-RemoteDir $sidecarHostPath
$serviceName = Require-Value $config "SERVICE_NAME"
$remote = "$remoteUser@$remoteHost"

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    Invoke-Checked "npm" @("run", "build")
  }
  if (-not $SkipTests) {
    Invoke-Checked "npm" @("test")
  }

  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("openclaw-onebot-hook-deploy-" + [Guid]::NewGuid().ToString("N"))
  $stage = Join-Path $tempRoot "package"
  New-Item -ItemType Directory -Path $stage | Out-Null

  foreach ($file in @("openclaw.plugin.json", "package.json", "package-lock.json", "README.md", "AGENTS.md", "tsconfig.json")) {
    if (Test-Path $file) {
      Copy-Item -LiteralPath $file -Destination (Join-Path $stage $file)
    }
  }
  foreach ($dir in @("dist", "src", "test", "scripts", "docs")) {
    if (Test-Path $dir) {
      Copy-Item -LiteralPath $dir -Destination (Join-Path $stage $dir) -Recurse
    }
  }

  $archive = Join-Path $tempRoot "openclaw-onebot-hook.tgz"
  Invoke-Checked "tar" @("-czf", $archive, "-C", $stage, ".")

  $remoteArchive = "/tmp/openclaw-onebot-hook.tgz"
  $remoteService = "/tmp/$serviceName"
  $serviceFile = Join-Path $tempRoot $serviceName
  New-ServiceFile -Config $config | Set-Content -LiteralPath $serviceFile -Encoding UTF8

  Invoke-Checked "ssh" @($remote, "mkdir -p $(Quote-Remote $pluginRoot) $(Quote-Remote $sidecarHostDir)")
  Invoke-Checked "scp" @($archive, "$remote`:$remoteArchive")
  Invoke-Checked "ssh" @($remote, "tar -xzf $(Quote-Remote $remoteArchive) -C $(Quote-Remote $pluginRoot) && mkdir -p $(Quote-Remote $sidecarHostDir) && cp $(Quote-Remote "$pluginRoot/scripts/openclaw-onebot-sidecar.mjs") $(Quote-Remote $sidecarHostPath)")

  if (-not $SkipServiceInstall) {
    Invoke-Checked "scp" @($serviceFile, "$remote`:$remoteService")
    Invoke-Checked "ssh" @("-t", $remote, "sudo mv $(Quote-Remote $remoteService) /etc/systemd/system/$(Quote-Remote $serviceName) && sudo systemctl daemon-reload && sudo systemctl enable --now $(Quote-Remote $serviceName) && sudo systemctl restart $(Quote-Remote $serviceName) && systemctl is-active $(Quote-Remote $serviceName)")
  }

  Invoke-Checked "ssh" @($remote, "journalctl -u $(Quote-Remote $serviceName) --since '2 minutes ago' --no-pager -o short-iso | tail -80")
}
finally {
  Pop-Location
}
