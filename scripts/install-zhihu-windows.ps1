# Explicitly installs the official optional CLI. No admin, PATH or policy changes.
$ErrorActionPreference = "Stop"
$ManifestUrl = "https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/manifest.json"
$Current = Join-Path $env:LOCALAPPDATA "ZhihuCLI\current\zhihu-cli.exe"
if (Test-Path $Current) { Write-Host "Official CLI already installed: $Current. Use its upgrade command if required."; exit 0 }
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("scholay-zhihu-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir | Out-Null
$Manifest = Invoke-RestMethod -Uri $ManifestUrl -MaximumRedirection 0 -TimeoutSec 30
$Artifact = $Manifest.cli.artifacts.'windows-amd64'
$Uri = [uri]$Artifact.url
if ($Uri.Scheme -ne "https" -or $Uri.Host -ne "developer-cdn.zhihu.com" -or $Uri.UserInfo -or $Uri.Port -ne 443) { throw "Unexpected download origin" }
if ($Artifact.sha256 -cnotmatch '^[a-f0-9]{64}$' -or [long]$Artifact.size -le 0 -or [long]$Artifact.size -gt 128MB) { throw "Invalid integrity metadata" }
$Archive = Join-Path $TempDir "cli.zip"
Invoke-WebRequest -UseBasicParsing -Uri $Uri -MaximumRedirection 0 -OutFile $Archive -TimeoutSec 120
if ((Get-Item $Archive).Length -ne [long]$Artifact.size -or (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Artifact.sha256) { throw "Official archive checksum mismatch" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $Entries = @($Zip.Entries | Where-Object { $_.Name -ceq "zhihu-cli.exe" })
    if ($Entries.Count -ne 1 -or $Entries[0].Length -gt 128MB) { throw "Invalid CLI archive" }
    $Staged = Join-Path $TempDir "zhihu-cli.exe"
    [IO.Compression.ZipFileExtensions]::ExtractToFile($Entries[0], $Staged, $false)
} finally { $Zip.Dispose() }
$Version = (& $Staged version | ConvertFrom-Json).version
if ($LASTEXITCODE -ne 0 -or $Version -ne $Manifest.cli.latest_version) { throw "CLI version validation failed" }
New-Item -ItemType Directory -Force -Path (Split-Path $Current) | Out-Null
[IO.File]::Move($Staged, $Current)
Write-Host "Installed official Zhihu CLI $Version. Open scholay today Settings > Platforms to authorize."
Write-Host "Verified download retained at $Archive; no credentials were requested or copied."
