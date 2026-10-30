<#
.SYNOPSIS
    Install (or uninstall) the Maya Expression Bridge: the Maya module and the VS Code extension.

.DESCRIPTION
    Run from an unpacked release folder (Install.bat calls this). It:
      1. copies maya\MayaExpressionBridge into Maya's modules folder and writes MayaExpressionBridge.mod
      2. installs vscode\maya-expressions-<version>.vsix with VS Code's `code` command
    Nothing else on the machine is changed. Run it again to upgrade; -Uninstall removes both parts.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Uninstall
.EXAMPLE
    .\install.ps1 -SkipVSCode -ModulesDir D:\pipeline\maya\modules
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$SkipMaya,
    [switch]$SkipVSCode,
    # Defaults to $env:MAYA_APP_DIR\modules, else <Documents>\maya\modules (Maya's own default).
    [string]$ModulesDir,
    # Path to VS Code's `code` command; found automatically when omitted.
    [string]$CodeCli
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Name = 'MayaExpressionBridge'
$ExtensionId = 'local.maya-expressions'
$Root = Split-Path -Parent $PSScriptRoot   # the unpacked release folder
$Package = Join-Path $Root "maya\$Name"

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Get-ModulesDir {
    if ($ModulesDir) { return $ModulesDir }
    if ($env:MAYA_APP_DIR) { return (Join-Path $env:MAYA_APP_DIR 'modules') }
    # MyDocuments follows a redirected Documents folder (e.g. OneDrive), like Maya does.
    $docs = [Environment]::GetFolderPath('MyDocuments')
    return (Join-Path $docs 'maya\modules')
}

function Get-Version {
    $init = Join-Path $Package 'scripts\expression_bridge\__init__.py'
    $line = Select-String -Path $init -Pattern '^__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $line) { throw "Could not read the version from $init" }
    return $line.Matches[0].Groups[1].Value
}

function Find-CodeCli {
    if ($CodeCli) {
        if (-not (Test-Path $CodeCli)) { throw "VS Code command not found: $CodeCli" }
        return $CodeCli
    }
    $onPath = Get-Command 'code.cmd' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

function Install-MayaModule([string]$Dir, [string]$Version) {
    Write-Step "Maya module -> $Dir"
    if (-not (Test-Path $Package)) { throw "Missing $Package. Run this from the unpacked release folder." }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null

    $target = Join-Path $Dir $Name
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse -Path $Package -Destination $target
    Get-ChildItem -Path $target -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

    # Relative paths in a .mod file resolve against the .mod file's own folder.
    $mod = "+ $Name $Version ./$Name`r`nscripts: scripts`r`n"
    [IO.File]::WriteAllText((Join-Path $Dir "$Name.mod"), $mod, (New-Object Text.UTF8Encoding $false))
    Write-Ok "Copied the module and wrote $Name.mod"

    if (Get-Process -Name 'maya' -ErrorAction SilentlyContinue) {
        Write-Note 'Maya is running: restart it to load the new version.'
    }
}

function Uninstall-MayaModule([string]$Dir) {
    Write-Step "Removing the Maya module from $Dir"
    $removed = $false
    foreach ($p in @((Join-Path $Dir "$Name.mod"), (Join-Path $Dir $Name))) {
        if (Test-Path $p) { Remove-Item -Recurse -Force $p; $removed = $true }
    }
    if ($removed) { Write-Ok 'Removed.' } else { Write-Note 'Not installed there.' }
}

function Invoke-Code([string]$Code, [string[]]$Arguments) {
    # code.cmd prints Node deprecation warnings on stderr. Windows PowerShell 5.1 turns
    # redirected native stderr into errors, which 'Stop' would make fatal, so relax it
    # here and judge success by the exit code alone.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Code @Arguments 2>&1 | ForEach-Object { "$_" } |
            Where-Object { $_ -and $_ -notmatch 'DeprecationWarning|trace-deprecation|^\s*$|^At |^\s*\+ |CategoryInfo|FullyQualifiedErrorId' }
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $output | ForEach-Object { Write-Host "    $_" }
    return $exit
}

function Install-VSCodeExtension([string]$Version) {
    $vsix = Join-Path $Root "vscode\maya-expressions-$Version.vsix"
    Write-Step "VS Code extension ($([IO.Path]::GetFileName($vsix)))"
    if (-not (Test-Path $vsix)) { throw "Missing $vsix" }
    $code = Find-CodeCli
    if (-not $code) {
        Write-Note "VS Code's 'code' command was not found. Install the extension by hand:"
        Write-Note "VS Code > Extensions > ... menu > Install from VSIX... > $vsix"
        return $false
    }
    if ((Invoke-Code $code @('--install-extension', $vsix, '--force')) -ne 0) {
        throw 'VS Code could not install the extension (see above).'
    }
    Write-Ok 'Installed. In open VS Code windows, click "Restart Extensions" (or reload the window).'
    return $true
}

function Uninstall-VSCodeExtension {
    Write-Step 'Removing the VS Code extension'
    $code = Find-CodeCli
    if (-not $code) { Write-Note "VS Code's 'code' command was not found; remove 'Maya Expressions' in the Extensions view."; return }
    if ((Invoke-Code $code @('--uninstall-extension', $ExtensionId)) -eq 0) { Write-Ok 'Removed.' }
    else { Write-Note 'It was not installed.' }
}

$dir = Get-ModulesDir
if ($Uninstall) {
    if (-not $SkipMaya) { Uninstall-MayaModule $dir }
    if (-not $SkipVSCode) { Uninstall-VSCodeExtension }
    Write-Host "`nMaya Expression Bridge uninstalled." -ForegroundColor Green
    exit 0
}

$version = Get-Version
Write-Host "Maya Expression Bridge $version" -ForegroundColor White
if (-not $SkipMaya) { Install-MayaModule $dir $version }
if (-not $SkipVSCode) { [void](Install-VSCodeExtension $version) }

Write-Host @"

Done. Next:
  1. Start (or restart) Maya. An "Expression Bridge" menu appears and the bridge starts.
  2. In VS Code, click the "M" icon in the activity bar to see your scene's expressions.
"@ -ForegroundColor Green
exit 0
