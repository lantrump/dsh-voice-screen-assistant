# Run the test suites.
#   (default)  quiet: one line per suite, full detail goes to tests/last-run.log
#   -Verbose   print every PASS line too (for debugging a specific failure)
#   -Hardware  also run the desktop_ctl test (moves the mouse, overwrites the clipboard)
#   -Live      also run the live vision-grounding test (needs $env:DEEPSEEK_API_KEY, costs credit)
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# BOM-less UTF-8 scripts as ANSI, so any CJK text here would break parsing
# whenever the file is edited by a tool that drops the BOM.
param([switch]$Hardware, [switch]$Live, [switch]$Verbose)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$py = if ($env:PYTHON) { $env:PYTHON }
      elseif (Test-Path 'F:\miniconda3\python.exe') { 'F:\miniconda3\python.exe' }
      else { 'python' }

$results = @()
$full = New-Object System.Collections.ArrayList

function Record([string]$rel, [string]$out, [int]$code) {
  [void]$full.Add("`n================ $rel  (exit $code) ================`n$out")
  $lines = $out -split "`r?`n"
  $summary = ($lines | Where-Object { $_ -match '^\d+ passed' } | Select-Object -Last 1)
  if (-not $summary) { $summary = '' } else { $summary = $summary.Trim() }
  $fails = @($lines | Where-Object { $_ -match '^FAIL' })
  $script:results += [pscustomobject]@{ Suite = $rel; Exit = $code; Summary = $summary }

  if ($code -eq 0) {
    Write-Host ("[ ok ] {0,-34} {1}" -f $rel, $summary)
  } else {
    Write-Host ("[FAIL] {0,-34} {1}" -f $rel, $summary) -ForegroundColor Red
    foreach ($f in $fails) { Write-Host ("       " + $f.Trim()) -ForegroundColor Red }
  }
}

function Run-Node([string]$rel) {
  $out = & node (Join-Path $root $rel) 2>&1 | Out-String
  Record $rel $out $LASTEXITCODE
  if ($Verbose) { Write-Host $out }
}

function Run-Py([string]$rel) {
  $out = & $py (Join-Path $root $rel) 2>&1 | Out-String
  Record $rel $out $LASTEXITCODE
  if ($Verbose) { Write-Host $out }
}

Write-Host "=== tests ===" -ForegroundColor Cyan
Run-Node 'test-speech-queue.mjs'
Run-Node 'test-agent-input-wiring.mjs'
Run-Node 'test-model-dropdown.mjs'
Run-Node 'test-startmenu.mjs'
Run-Node 'test-action-layer.mjs'
Run-Node 'test-agent-loop.mjs'
Run-Node 'test-crop-annotate.mjs'
Run-Py 'test_type_line_by_line.py'

if ($Hardware) { Run-Py 'test_desktop_ctl.py' }
else { Write-Host "[skip] test_desktop_ctl.py (moves the mouse) - rerun with -Hardware" -ForegroundColor DarkGray }

if ($Live) {
  Run-Node 'live/test-vision-grounding.mjs'
  Run-Node 'live/score-answers.mjs'
}
else { Write-Host "[skip] live tests (need a key, cost credit) - rerun with -Live" -ForegroundColor DarkGray }

$logPath = Join-Path $root 'last-run.log'
[System.IO.File]::WriteAllText($logPath, ($full -join "`n"), [System.Text.UTF8Encoding]::new($false))

$bad = @($results | Where-Object { $_.Exit -ne 0 })
Write-Host ("`nfull detail -> " + $logPath) -ForegroundColor DarkGray
if ($bad.Count -gt 0) {
  Write-Host ("FAILED: " + ($bad.Suite -join ', ')) -ForegroundColor Red
  exit 1
}
Write-Host ("ALL PASSED (" + $results.Count + " suites)") -ForegroundColor Green
exit 0
