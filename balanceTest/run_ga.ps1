# 연쇄 시스템 GA (3단계 심연의 옥좌). 처음부터: .\balanceTest\run_ga.ps1   이어 하기: .\balanceTest\run_ga.ps1 -Resume
param([switch]$Resume, [int]$Population = 30, [int]$Generations = 100, [int]$EvalSeeds = 3, [double]$Immigrants = 0.2)
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
$a = @('balanceTest/slot_balance_test.py', '--mode', 'ga', '--population', $Population, '--generations', $Generations,
       '--eval-seeds', $EvalSeeds, '--immigrants', $Immigrants)
if ($Resume) { $a += '--resume' }
python @a 2>&1 | Tee-Object -FilePath balanceTest/results/abyss_run.log -Append
