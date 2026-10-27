$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$hostName = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }

function Test-PortOpen {
  param([int]$Port)
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect("127.0.0.1", $Port)
    $true
  } catch {
    $false
  } finally {
    $client.Close()
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js。请先安装 Node.js，或把文件夹放到已安装 Node.js 的电脑/服务器上。"
}

if (-not (Test-PortOpen -Port $port)) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$root'; `$env:PORT='$port'; `$env:HOST='$hostName'; node server.js") -WorkingDirectory $root
}

Start-Sleep -Milliseconds 900
Start-Process "http://127.0.0.1:$port/english-dictation-review.html?shared=1"
