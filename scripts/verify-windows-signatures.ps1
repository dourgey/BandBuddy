$ErrorActionPreference = 'Stop'

$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release'))
$packageJson = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
$requiredArtifacts = @(
  (Join-Path $releaseRoot "BandBuddy-$version-x64.exe"),
  (Join-Path $releaseRoot "BandBuddy-$version-x64-portable.exe"),
  (Join-Path $releaseRoot 'win-unpacked\BandBuddy.exe')
)

$missing = @($requiredArtifacts | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missing.Count -gt 0) {
  throw "Missing signed release artifacts:`n$($missing -join "`n")"
}

$binaryExtensions = @('.exe', '.dll', '.node')
$packagedBinaries = Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'win-unpacked') -Recurse -File |
  Where-Object { $binaryExtensions -contains $_.Extension.ToLowerInvariant() } |
  ForEach-Object { $_.FullName }
$targets = @($requiredArtifacts + $packagedBinaries | Sort-Object -Unique)
$failures = @()

foreach ($target in $targets) {
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  $relativePath = $target.Substring($releaseRoot.Length).TrimStart('\')
  if ($signature.Status -ne 'Valid') {
    $failures += "$relativePath : $($signature.Status)"
    continue
  }
  $algorithm = $signature.SignerCertificate.PublicKey.Oid.Value
  if ($algorithm -ne '1.2.840.113549.1.1.1') {
    $failures += "$relativePath : signer is not RSA"
  }
}

if ($failures.Count -gt 0) {
  throw "Windows release signature verification failed:`n$($failures -join "`n")"
}

Write-Host "Verified $($targets.Count) trusted RSA Authenticode signatures."
