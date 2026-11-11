$sourceDir = 'C:\Users\Admin\Downloads\stripe-webhook-integration\stripe-webhook-integration'
$zipPath = 'C:\Users\Admin\Downloads\stripe-webhook-integration\stripe-webhook-integration.zip'

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')

$files = Get-ChildItem -Path $sourceDir -Recurse | Where-Object {
    $_.FullName -notmatch '\\node_modules(\\.*)?$' -and
    $_.FullName -notmatch '\\\.env$' -and
    $_.FullName -notmatch '\\logs\\.*\.jsonl$'
}

foreach ($item in $files) {
    if (-not $item.PSIsContainer) {
        $rel = $item.FullName.Substring($sourceDir.Length + 1)
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $rel)
    }
}

$zip.Dispose()

Write-Host "ZIP created successfully at: $zipPath"
Get-Item $zipPath | Select-Object Name, Length, LastWriteTime
