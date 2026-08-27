<#
  이력 수집기(#112) 로컬 실행 — 작업 스케줄러가 로그온 때 부르는 진입점.

  Astro node standalone 에는 부팅 훅이 없어 **첫 요청이 들어와야** 미들웨어가
  수집기를 깨운다. 그래서 서버를 띄우는 것만으로는 부족하고, 이 스크립트가
  기동을 기다렸다가 워밍업 요청을 한 번 보낸다. 그 둘을 한 몸으로 묶는 것이
  이 파일의 존재 이유다.

  수동 실행도 같은 방법이다:
      powershell -ExecutionPolicy Bypass -File scripts\start-history-collector.ps1

  로그는 셋으로 나눈다. **Start-Process 의 리디렉션이 대상 파일을 배타적으로
  점유하므로 런처가 같은 파일에 쓸 수 없다.** 한 파일에 몰면 런처가 IOException
  으로 죽는다.
      data\launcher.log      런처 자신의 기록 (누적)
      data\collector.log     서버 stdout — 수집 결과가 여기 (기동마다 새로 씀)
      data\collector.err.log 서버 stderr
#>

$ErrorActionPreference = 'Stop'

$appDir  = (Resolve-Path (Join-Path $PSScriptRoot '..\raddit-astro')).Path
$entry   = Join-Path $appDir 'dist\server\entry.mjs'
$envFile = Join-Path $appDir '.env'
$dataDir = Join-Path $appDir 'data'
$launLog = Join-Path $dataDir 'launcher.log'
$outLog  = Join-Path $dataDir 'collector.log'
$errLog  = Join-Path $dataDir 'collector.err.log'
$port    = 4321

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

function Write-Launcher([string]$msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $launLog
}

# 런처 로그는 누적이므로 크기만 관리한다. 한 세대만 남긴다.
if ((Test-Path $launLog) -and ((Get-Item $launLog).Length -gt 5MB)) {
  Move-Item $launLog "$launLog.1" -Force
}

# node 절대경로. 작업 스케줄러 환경의 PATH 는 로그인 셸과 다르므로 믿지 않는다.
$node = 'C:\nvm4w\nodejs\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    Write-Launcher "[오류] node.exe 를 찾을 수 없습니다. 스크립트의 `$node 경로를 고치십시오."
    exit 1
  }
  $node = $cmd.Source
}

# 빌드 산출물이 없으면 수집기가 아예 없는 것과 같다. 원인을 남기고 멈춘다.
if (-not (Test-Path $entry)) {
  Write-Launcher "[오류] 빌드 산출물이 없습니다: $entry"
  Write-Launcher "       raddit-astro 에서 npm run build 를 먼저 실행하십시오."
  exit 1
}
if (-not (Test-Path $envFile)) {
  Write-Launcher "[오류] .env 가 없습니다: $envFile"
  exit 1
}

# 이미 떠 있으면 두 번 띄우지 않는다 — 포트가 충돌하고 수집이 중복된다.
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($null -ne $busy) {
  Write-Launcher "포트 $port 가 이미 사용 중이라 기동을 건너뜁니다 (PID $($busy.OwningProcess))."
  exit 0
}

# 리디렉션이 대상을 truncate 하므로, 직전 기동분은 한 세대만 밀어 둔다.
foreach ($f in @($outLog, $errLog)) {
  if (Test-Path $f) { Move-Item $f "$f.prev" -Force }
}

Write-Launcher "기동 — $node $entry"

$proc = Start-Process -FilePath $node `
  -ArgumentList @("--env-file=$envFile", $entry) `
  -WorkingDirectory $appDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Write-Launcher "서버 PID $($proc.Id)"

# 기동을 기다렸다가 워밍업. 이 요청이 있어야 수집기가 깨어난다.
$woke = $false
foreach ($i in 1..60) {
  Start-Sleep -Seconds 1
  if ($proc.HasExited) { break }
  try {
    Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 5 | Out-Null
    $woke = $true
    break
  } catch {
    # 아직 리스닝 전 — 다시 시도
  }
}

if ($woke) {
  Write-Launcher "워밍업 완료. 약 10초 뒤 첫 수집이 돕니다 (결과는 collector.log)."
} elseif ($proc.HasExited) {
  Write-Launcher "[오류] 서버가 기동 중 종료했습니다 (exit $($proc.ExitCode)). collector.err.log 확인."
  exit 1
} else {
  Write-Launcher "[오류] 60초 안에 응답이 없습니다. collector.err.log 확인."
}

# 작업 스케줄러가 이 작업을 '실행 중'으로 유지하도록 자식과 수명을 맞춘다.
Wait-Process -Id $proc.Id
Write-Launcher "서버 종료 (exit $($proc.ExitCode))"
