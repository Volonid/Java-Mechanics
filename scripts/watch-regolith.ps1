$mutex = New-Object System.Threading.Mutex($false, 'Global\JavaMechanics-RegolithWatch')
$ownsMutex = $false

try {
    $ownsMutex = $mutex.WaitOne(0)
}
catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
}

if (-not $ownsMutex) {
    $mutex.Dispose()
    exit 0
}

$deno = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\DenoLand.Deno_*" -Filter 'deno.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($deno) {
    $env:Path = "$($deno.Directory.FullName);$env:Path"
}

Set-Location $PSScriptRoot\..
$sourceRoot = (Resolve-Path 'packs').Path
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) '.regolith\tmp'))
$comMojang = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\Shared\games\com.mojang'
$targets = @{
    BP = Join-Path $comMojang 'development_behavior_packs\JavaMechanics_bp'
    RP = Join-Path $comMojang 'development_resource_packs\JavaMechanics_rp'
}

function Get-TreeFingerprint($path, [string[]]$excludedRelativePaths = @()) {
    if (-not (Test-Path $path)) {
        return @('MISSING')
    }

    $files = Get-ChildItem $path -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' }
    if (-not $files) {
        return @('__EMPTY__')
    }

    return @($files | ForEach-Object {
            $relative = $_.FullName.Substring($path.Length + 1)
            if ($relative -in $excludedRelativePaths) {
                return
            }
            "$relative|$($_.Length)|$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)"
        } | Where-Object { $null -ne $_ } | Sort-Object)
}

function Test-FingerprintMatch($left, $right) {
    if ($null -eq $left) {
        $left = @('__EMPTY__')
    }
    if ($null -eq $right) {
        $right = @('__EMPTY__')
    }

    $difference = @(Compare-Object -ReferenceObject @($left) -DifferenceObject @($right))
    return $difference.Count -eq 0
}

function Invoke-VerifiedBuild {
    $generatedBehaviorFiles = @('scripts\main.js', 'scripts\README.txt')

    do {
        & regolith run dev-gametest
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Start-Sleep -Seconds 2
            continue
        }

        $bpMatch = Test-FingerprintMatch (Get-TreeFingerprint (Join-Path $tempRoot 'BP') $generatedBehaviorFiles) (Get-TreeFingerprint $targets.BP $generatedBehaviorFiles)
        $rpMatch = Test-FingerprintMatch (Get-TreeFingerprint (Join-Path $tempRoot 'RP')) (Get-TreeFingerprint $targets.RP)
        $generatedFilesPresent = @($generatedBehaviorFiles | Where-Object { Test-Path (Join-Path $targets.BP $_) }).Count -eq $generatedBehaviorFiles.Count
        if (-not ($bpMatch -and $rpMatch -and $generatedFilesPresent)) {
            Write-Host '[Java Mechanics] Export verification failed; retrying.'
            $exitCode = 1
            Start-Sleep -Seconds 2
        }
    } while ($exitCode -ne 0)
}

function Get-SourceFingerprint {
    return @(Get-TreeFingerprint $sourceRoot)
}

try {
    Invoke-VerifiedBuild
    $previous = Get-SourceFingerprint

    while ($true) {
        Start-Sleep -Seconds 2
        $current = Get-SourceFingerprint
        if (-not (Test-FingerprintMatch $previous $current)) {
            Write-Host '[Java Mechanics] Change detected; rebuilding development packs.'
            Invoke-VerifiedBuild
            $current = Get-SourceFingerprint
        }
        $previous = $current
    }
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
