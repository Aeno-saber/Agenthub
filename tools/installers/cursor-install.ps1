$downloadUrl = 'https://downloads.cursor.com/lab/2026.09.28-64d2043/'
$version = '2026.09.28-64d2043'
function Get-Architecture {
    # NB: We do it this way to protect against WOW64 redirection - i.e.
    # if the user accidentally is in 32-bit or 64-bit Intel Powershell,
    # we don't want to be fibbed to
    $systemType = (Get-WmiObject Win32_ComputerSystem).SystemType
    if ($systemType -like "*ARM64*") { return "arm64" } else { return "x64" }
}
function Download-InstallPackage {
    param(
        [string]$UrlPrefix,
        [string]$TargetPath,
        [string]$Version
    )

    $tempFile = "$TargetPath\$([System.Guid]::NewGuid().ToString()).zip"
    $architecture = Get-Architecture
    $fullUrl = $UrlPrefix + "windows/$architecture/agent-cli-package.zip"

    try {
        Invoke-WebRequest -Uri $fullUrl -OutFile $tempFile
        Expand-Archive -Path $tempFile -DestinationPath $TargetPath -Force
        Rename-Item -Path "$TargetPath\dist-package" -NewName $Version

        # Copy all files that begin with 'cursor-agent' to the root dir
        Get-ChildItem -Path "$TargetPath\$Version" -Filter 'cursor-agent*' | Copy-Item -Destination "$TargetPath\.."

        # Create agent alias (primary command) for cursor-agent
        $rootDir = "$TargetPath\.."
        if (Test-Path "$rootDir\cursor-agent.exe") {
            Copy-Item -Path "$rootDir\cursor-agent.exe" -Destination "$rootDir\agent.exe" -Force
        }
        if (Test-Path "$rootDir\cursor-agent.cmd") {
            Copy-Item -Path "$rootDir\cursor-agent.cmd" -Destination "$rootDir\agent.cmd" -Force
        }
        if (Test-Path "$rootDir\cursor-agent.ps1") {
            Copy-Item -Path "$rootDir\cursor-agent.ps1" -Destination "$rootDir\agent.ps1" -Force
        }
    }
    finally {
        if (Test-Path $tempFile) {
            Remove-Item $tempFile
        }
    }
}
function Initialize-CursorAgent {
    ## initially set up the cursor-agent directory
    ## Create %LocalAppData%\cursor-agent\versions
    ## Add %LocalAppData%\cursor-agent to PATH
    $agentPath = "$env:LOCALAPPDATA\cursor-agent"
    $versionsPath = "$agentPath\versions"

    # If $agentPath exists, delete it
    if (Test-Path $agentPath) {
        Remove-Item -Recurse -Force $agentPath
    }

    New-Item -ItemType Directory -Path $agentPath -Force | Out-Null
    New-Item -ItemType Directory -Path $versionsPath -Force | Out-Null

    # Add to PATH
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -notlike "*$agentPath*") {
        [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$agentPath", "User")
    }

    # Add to current shell PATH
    if ($env:PATH -notlike "*$agentPath*") {
        $env:PATH = "$env:PATH;$agentPath"
    }
}
function Print-CursorAgentInstructions {
    Write-Host "Start using Cursor Agent:"
    Write-Host "   agent"
    Write-Host ""
    Write-Host ""
    Write-Host "Happy coding!"
    Write-Host ""
}

Initialize-CursorAgent
Download-InstallPackage -UrlPrefix $downloadUrl -TargetPath "$env:LOCALAPPDATA\cursor-agent\versions" -Version $version
Print-CursorAgentInstructions