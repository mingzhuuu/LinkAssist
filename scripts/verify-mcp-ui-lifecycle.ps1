[CmdletBinding()]
param(
    [string]$Exe = '.\src-tauri\target\release\linkassist.exe',
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$exePath = (Resolve-Path -LiteralPath $Exe).ProviderPath
$testRoot = Join-Path ([IO.Path]::GetTempPath()) (
    'linkassist-runtime-' + [guid]::NewGuid().ToString('N')
)
$localData = Join-Path $testRoot 'Local'
$roamingData = Join-Path $testRoot 'Roaming'
$webViewData = Join-Path $testRoot 'WebView2'
$discoveryPath = Join-Path $localData 'LinkAssist\core-discovery.json'
$explicitShutdownPath = Join-Path $localData 'LinkAssist\explicit-shutdown.json'
$configPath = Join-Path $roamingData 'com.linkassist.desktop\config.json'
$ownedProcesses = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$coreProcessId = $null

[void](New-Item -ItemType Directory -Path $localData, $roamingData, $webViewData -Force)

if (-not ('LinkAssistWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LinkAssistWindowProbe
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static bool HasVisibleWindow(uint targetProcessId)
    {
        return CountVisibleWindows(targetProcessId) > 0;
    }

    public static int CountVisibleWindows(uint targetProcessId)
    {
        int count = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == targetProcessId && IsWindowVisible(hwnd)) {
                Rect rect;
                if (GetWindowRect(hwnd, out rect) &&
                    rect.Right - rect.Left >= 100 &&
                    rect.Bottom - rect.Top >= 100) {
                    count++;
                }
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }

    public static string[] DescribeVisibleWindows(uint targetProcessId)
    {
        List<string> windows = new List<string>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == targetProcessId && IsWindowVisible(hwnd)) {
                StringBuilder title = new StringBuilder(512);
                StringBuilder className = new StringBuilder(256);
                Rect rect;
                GetWindowText(hwnd, title, title.Capacity);
                GetClassName(hwnd, className, className.Capacity);
                GetWindowRect(hwnd, out rect);
                windows.Add(String.Format(
                    "hwnd=0x{0:X}; class={1}; title={2}; rect={3},{4},{5},{6}",
                    hwnd.ToInt64(),
                    className,
                    title,
                    rect.Left,
                    rect.Top,
                    rect.Right,
                    rect.Bottom
                ));
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
"@
}

function Assert-Check {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Start-IsolatedLinkAssist {
    param(
        [string]$Arguments,
        [bool]$RedirectIo
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $exePath
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = Split-Path -Parent $exePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $RedirectIo
    $startInfo.RedirectStandardInput = $RedirectIo
    $startInfo.RedirectStandardOutput = $RedirectIo
    $startInfo.RedirectStandardError = $RedirectIo
    $startInfo.EnvironmentVariables['LOCALAPPDATA'] = $localData
    $startInfo.EnvironmentVariables['APPDATA'] = $roamingData
    $startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = $webViewData

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $process.Start()
    Assert-Check $started "Could not start LinkAssist $Arguments"
    if ($RedirectIo) {
        [void]$process.StandardError.ReadToEndAsync()
    }
    [void]$ownedProcesses.Add($process)
    return $process
}

function Send-McpRequest {
    param(
        [System.Diagnostics.Process]$Bridge,
        [string]$Request
    )

    $readTask = $Bridge.StandardOutput.ReadLineAsync()
    $Bridge.StandardInput.WriteLine($Request)
    $Bridge.StandardInput.Flush()
    Assert-Check ($readTask.Wait($TimeoutSeconds * 1000)) (
        "MCP response timed out for PID $($Bridge.Id)"
    )
    Assert-Check (-not [string]::IsNullOrWhiteSpace($readTask.Result)) (
        "MCP response was empty for PID $($Bridge.Id)"
    )
    return $readTask.Result | ConvertFrom-Json
}

function Wait-DiscoveryMode {
    param(
        [ValidateSet('headless', 'ui')]
        [string]$Mode
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -LiteralPath $discoveryPath) {
            try {
                $discovery = Get-Content -LiteralPath $discoveryPath -Raw |
                    ConvertFrom-Json
            } catch {
                $discovery = $null
            }
            if ($null -ne $discovery -and $discovery.mode -eq $Mode) {
                return $discovery
            }
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for discovery mode '$Mode'"
}

function Get-IsolatedCoreProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='linkassist.exe'" |
        Where-Object {
            $_.ExecutablePath -and
            [string]::Equals(
                [IO.Path]::GetFullPath([string]$_.ExecutablePath),
                $exePath,
                [StringComparison]::OrdinalIgnoreCase
            ) -and
            $_.CommandLine -match '--core-headless'
        })
}

function Wait-VisibleWindow {
    param([int]$ProcessId)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Assert-Check (
            $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
        ) "Core $ProcessId exited before its UI became visible"
        if ([LinkAssistWindowProbe]::HasVisibleWindow([uint32]$ProcessId)) {
            return
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)

    $windows = @(
        [LinkAssistWindowProbe]::DescribeVisibleWindows([uint32]$ProcessId)
    )
    if ($windows.Count -gt 0) {
        Write-Host "Visible windows reported for Core ${ProcessId}:"
        $windows | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "No visible top-level windows reported for Core ${ProcessId}."
    }
    throw "Timed out waiting for Core $ProcessId to show its UI"
}

function Wait-FrontendReady {
    param([object]$Discovery)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod `
                -Method Post `
                -Uri "http://127.0.0.1:$($Discovery.port)/ui/show" `
                -Headers @{ Authorization = "Bearer $($Discovery.token)" } `
                -TimeoutSec 5
            if ([bool]$response.frontendReady) {
                return
            }
        } catch {}
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Timed out waiting for the promoted UI frontend to finish loading'
}

function Close-Bridge {
    param([System.Diagnostics.Process]$Bridge)

    if (-not $Bridge.HasExited) {
        $Bridge.StandardInput.Close()
        Assert-Check ($Bridge.WaitForExit($TimeoutSeconds * 1000)) (
            "Bridge $($Bridge.Id) did not exit after stdin EOF"
        )
    }
    Assert-Check ($Bridge.ExitCode -eq 0) (
        "Bridge $($Bridge.Id) exited with code $($Bridge.ExitCode)"
    )
}

function Write-McpEnabledConfig {
    param([bool]$Enabled)

    $configDirectory = Split-Path -Parent $configPath
    [void](New-Item -ItemType Directory -Path $configDirectory -Force)
    $config = @{
        channels = @()
        ui = @{
            left_panel_width = 40
            right_panel_width = 360
            data_view_mode = 'text'
        }
        protocol = @{
            mode = 'Passthrough'
            field_definitions = @()
            lua_script = ''
        }
        mcp_tools = @{
            enabled = $Enabled
            scripts = @()
        }
    } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($configPath, $config)
}

$initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize",' +
    '"params":{"protocolVersion":"2025-11-25","capabilities":{},' +
    '"clientInfo":{"name":"runtime-probe","version":"1"}}}'
$toolsList = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
$toolCall = '{"jsonrpc":"2.0","id":3,"method":"tools/call",' +
    '"params":{"name":"greet","arguments":{"name":"runtime-probe"}}}'

try {
    Write-Host "Executable: $exePath"
    Write-Host "Sandbox:    $testRoot"

    Write-McpEnabledConfig $false
    $disabledBridge = Start-IsolatedLinkAssist '--mcp-bridge' $true
    Assert-Check ((Send-McpRequest $disabledBridge $initialize).id -eq 1) (
        'Disabled bridge initialize failed'
    )
    $disabledList = Send-McpRequest $disabledBridge $toolsList
    Assert-Check ($disabledList.result.tools.Count -eq 0) (
        'Disabled bridge unexpectedly exposed MCP tools'
    )
    $disabledCall = Send-McpRequest $disabledBridge $toolCall
    Assert-Check ($disabledCall.result.isError -eq $true) (
        'Disabled bridge unexpectedly accepted an MCP tool call'
    )
    Start-Sleep -Milliseconds 300
    Assert-Check (-not (Test-Path -LiteralPath $discoveryPath)) (
        'Disabled bridge unexpectedly created Core discovery state'
    )
    Assert-Check (@(Get-IsolatedCoreProcesses).Count -eq 0) (
        'Disabled bridge unexpectedly started a Core process'
    )
    Close-Bridge $disabledBridge
    Write-Host 'PASS: disabled MCP Bridge exposed no tools and started no Core'

    Write-McpEnabledConfig $true

    $bridgeA = Start-IsolatedLinkAssist '--mcp-bridge' $true
    $bridgeB = Start-IsolatedLinkAssist '--mcp-bridge' $true
    Assert-Check ((Send-McpRequest $bridgeA $initialize).id -eq 1) (
        'Bridge A initialize failed'
    )
    Assert-Check ((Send-McpRequest $bridgeB $initialize).id -eq 1) (
        'Bridge B initialize failed'
    )
    Assert-Check (-not (Test-Path -LiteralPath $discoveryPath)) (
        'initialize unexpectedly started a Core'
    )

    $readA = $bridgeA.StandardOutput.ReadLineAsync()
    $readB = $bridgeB.StandardOutput.ReadLineAsync()
    $bridgeA.StandardInput.WriteLine($toolsList)
    $bridgeB.StandardInput.WriteLine($toolsList)
    $bridgeA.StandardInput.Flush()
    $bridgeB.StandardInput.Flush()
    Assert-Check ($readA.Wait($TimeoutSeconds * 1000)) 'Bridge A tools/list timed out'
    Assert-Check ($readB.Wait($TimeoutSeconds * 1000)) 'Bridge B tools/list timed out'
    $listA = $readA.Result | ConvertFrom-Json
    $listB = $readB.Result | ConvertFrom-Json
    Assert-Check ($listA.result.tools.Count -gt 0) 'Bridge A returned no tools'
    Assert-Check ($listB.result.tools.Count -gt 0) 'Bridge B returned no tools'

    $headless = Wait-DiscoveryMode 'headless'
    $coreProcessId = [int]$headless.pid
    $startedAt = [long]$headless.startedAt
    Start-Sleep -Seconds 3
    Assert-Check (@(Get-IsolatedCoreProcesses).Count -eq 1) (
        'Concurrent bridges created more than one Core'
    )
    $headlessVisibleWindows = @(
        [LinkAssistWindowProbe]::DescribeVisibleWindows([uint32]$coreProcessId)
    )
    $headlessUiVisible = [LinkAssistWindowProbe]::HasVisibleWindow(
        [uint32]$coreProcessId
    )
    if ($headlessUiVisible) {
        Write-Host 'Visible windows reported for the headless Core:'
        $headlessVisibleWindows | ForEach-Object { Write-Host "  $_" }
    }
    Assert-Check (
        -not $headlessUiVisible
    ) 'The headless Core exposed a visible UI'
    Write-Host "PASS: one hidden Core, PID $coreProcessId"

    $launcher = Start-IsolatedLinkAssist '' $false
    Assert-Check ($launcher.WaitForExit($TimeoutSeconds * 1000)) (
        'The no-argument launcher did not exit'
    )
    $ui = Wait-DiscoveryMode 'ui'
    Assert-Check ([int]$ui.pid -eq $coreProcessId) (
        'Showing the UI replaced the existing Core PID'
    )
    Assert-Check ([long]$ui.startedAt -eq $startedAt) (
        'Showing the UI replaced the existing discovery record'
    )
    Wait-VisibleWindow $coreProcessId
    Wait-FrontendReady $ui
    Assert-Check (
        [LinkAssistWindowProbe]::CountVisibleWindows([uint32]$coreProcessId) -eq 1
    ) 'Showing the UI created more than one visible application window'
    Assert-Check (@(Get-IsolatedCoreProcesses).Count -eq 1) (
        'Showing the UI created another Core'
    )
    Write-Host 'PASS: no-argument launch promoted the existing Core'

    $bridgeC = Start-IsolatedLinkAssist '--mcp-bridge' $true
    [void](Send-McpRequest $bridgeC $initialize)
    $listC = Send-McpRequest $bridgeC $toolsList
    Assert-Check ($listC.result.tools.Count -gt 0) 'Bridge C returned no tools'
    Assert-Check (@(Get-IsolatedCoreProcesses).Count -eq 1) (
        'MCP loading with the UI open created another Core'
    )
    Assert-Check (
        [LinkAssistWindowProbe]::HasVisibleWindow([uint32]$coreProcessId)
    ) 'MCP loading hid the existing UI'
    Write-Host 'PASS: MCP loading adopted and preserved the existing UI'

    Close-Bridge $bridgeA
    Close-Bridge $bridgeB
    Close-Bridge $bridgeC
    Start-Sleep -Seconds 1
    Assert-Check (
        $null -ne (Get-Process -Id $coreProcessId -ErrorAction SilentlyContinue)
    ) 'The promoted UI/Core exited with the MCP bridges'
    Assert-Check (
        [LinkAssistWindowProbe]::HasVisibleWindow([uint32]$coreProcessId)
    ) 'The promoted UI disappeared with the MCP bridges'
    Write-Host 'PASS: promoted UI survived all bridge EOF events'

    $shutdownBridge = Start-IsolatedLinkAssist '--mcp-bridge' $true
    [void](Send-McpRequest $shutdownBridge $initialize)
    [void](Send-McpRequest $shutdownBridge $toolsList)
    $shutdownMarker = @{
        corePid = $coreProcessId
        requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    } | ConvertTo-Json
    [IO.File]::WriteAllText($explicitShutdownPath, $shutdownMarker)
    Assert-Check ($shutdownBridge.WaitForExit($TimeoutSeconds * 1000)) (
        'MCP Bridge did not exit after the explicit shutdown marker'
    )
    Assert-Check ($shutdownBridge.ExitCode -eq 0) (
        "MCP Bridge exited with code $($shutdownBridge.ExitCode) after explicit shutdown"
    )
    Assert-Check (
        $null -ne (Get-Process -Id $coreProcessId -ErrorAction SilentlyContinue)
    ) 'The bridge shutdown probe unexpectedly exited the UI/Core'
    Write-Host 'PASS: explicit tray-shutdown signal closed the active MCP Bridge'
    Write-Host 'ALL RUNTIME CHECKS PASSED' -ForegroundColor Green
} finally {
    foreach ($process in $ownedProcesses) {
        try {
            if (-not $process.HasExited) {
                $process.Kill()
                [void]$process.WaitForExit(5000)
            }
        } catch {}
    }

    if ($null -ne $coreProcessId) {
        try {
            $record = Get-CimInstance Win32_Process -Filter "ProcessId=$coreProcessId"
            $sameExecutable = $record -and $record.ExecutablePath -and [string]::Equals(
                [IO.Path]::GetFullPath([string]$record.ExecutablePath),
                $exePath,
                [StringComparison]::OrdinalIgnoreCase
            )
            if ($sameExecutable) {
                $coreProcess = [Diagnostics.Process]::GetProcessById($coreProcessId)
                $coreProcess.Kill()
                [void]$coreProcess.WaitForExit(5000)
            }
        } catch {}
    }

    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $safeToRemove = $resolvedTestRoot.StartsWith(
        $tempRoot,
        [StringComparison]::OrdinalIgnoreCase
    ) -and (
        [IO.Path]::GetFileName($resolvedTestRoot) -like 'linkassist-runtime-*'
    )
    if ($safeToRemove -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        # WebView2 helper processes may release cache handles just after the
        # owning Core exits. Retry briefly so successful and failed probes do
        # not leave isolated test profiles behind.
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Remove-Item -LiteralPath $resolvedTestRoot `
                -Recurse -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $resolvedTestRoot)) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
    }
}
