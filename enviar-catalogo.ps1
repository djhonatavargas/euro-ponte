# Envia regras, catalogo, fichas, fotos e videos para o servidor da Euro Ponte.
# Uso: duplo clique em "Ligar envio do catalogo.bat" (liga o envio automatico a cada 30 min e ja faz o primeiro).
# So envia o que mudou. Pode rodar quantas vezes quiser.
param([switch]$Silencioso)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = 'C:\Users\Public\catalogo'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$logArq = Join-Path $pasta 'ultimo-envio.txt'
try { if ((Test-Path $logArq) -and (Get-Item $logArq).Length -gt 200KB) { $ult = Get-Content $logArq -Tail 300; Set-Content -Path $logArq -Value $ult } } catch {}
function Anotar($t, $cor = 'Gray') {
  try { Add-Content -Path $logArq -Value ((Get-Date -Format 'dd/MM/yyyy HH:mm:ss') + '  ' + $t) } catch {}
  if (-not $Silencioso) { Write-Host $t -ForegroundColor $cor }
}
function Fim($codigo) {
  if ($lock) { try { $lock.Close() } catch {} }
  if (-not $Silencioso -and $Host.Name -eq 'ConsoleHost') { Read-Host 'Aperte Enter para fechar' | Out-Null }
  exit $codigo
}

# um envio por vez (o automatico nao atropela o manual)
$lock = $null
try { $lock = [System.IO.File]::Open((Join-Path $pasta 'enviando.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Anotar 'Outro envio ainda esta rodando; este fica para a proxima.'; exit 0 }

$cfg = Join-Path $env:USERPROFILE 'euro-ponte.txt'
if (Test-Path $cfg) {
  $linhas = Get-Content $cfg
  $servidor = $linhas[0].Trim(); $token = $linhas[1].Trim()
} elseif ($Silencioso) {
  Anotar "Falta a configuracao em $cfg. Rode o 'Ligar envio do catalogo.bat'."; Fim 1
} else {
  $servidor = Read-Host 'Endereco do servidor (ex.: 5.253.232.176)'
  $token = Read-Host 'Token que apareceu no fim da instalacao'
  if ($servidor -notmatch '^https?://') { $servidor = "http://$($servidor.Trim()):8080" }
  Set-Content -Path $cfg -Value @($servidor, $token.Trim())
}
$token = $token.Trim()

$regras = @('AGENTS.md','REGRAS-ATENDIMENTO.md','JEITO-DO-DJHONATA.md','ATENDIMENTO-INTELIGENTE.md','BASE-RESPOSTAS.md','APRENDIZADOS.md','combinados-clientes.md','CATALOGO.md')
$fora = @('conversas','_sync-crm','_tmp-claude','CRM-Euro','_fora-do-catalogo')
$lista = New-Object System.Collections.Generic.List[object]
foreach ($r in $regras) { $f = Join-Path $base $r; if (Test-Path $f) { $lista.Add((Get-Item $f)) } }
foreach ($f in (Get-ChildItem -Path (Join-Path $base '_ponte') -File -ErrorAction SilentlyContinue)) { $lista.Add($f) }
foreach ($f in (Get-ChildItem -Path (Join-Path $base 'escritorio') -File -ErrorAction SilentlyContinue)) { if ($f.Extension -match '^\.(jpe?g|png|webp|mp4)$') { $lista.Add($f) } }
foreach ($d in (Get-ChildItem -Path $base -Directory)) {
  if ($fora -contains $d.Name -or $d.Name -eq 'escritorio' -or $d.Name -eq '_ponte' -or $d.Name.StartsWith('_')) { continue }
  foreach ($f in (Get-ChildItem -Path $d.FullName -File)) {
    if ($f.Name -eq 'ficha.md' -or $f.Name -eq 'video-whatsapp.mp4' -or $f.Extension -match '^\.(jpe?g|png|webp)$') { $lista.Add($f) }
  }
}

if (-not $Silencioso) { Write-Host "Consultando o servidor $servidor ..." }
$man = @{}
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$servidor/manifest?t=$token" -TimeoutSec 60
  $obj = $resp.Content | ConvertFrom-Json
  foreach ($p in $obj.PSObject.Properties) { $man[$p.Name] = $p.Value }
} catch {
  Anotar "Nao consegui falar com o servidor: $($_.Exception.Message)" 'Red'
  if (-not $Silencioso) { Write-Host "Se o token ou o endereco estiverem errados, apague o arquivo $cfg e rode de novo." }
  Fim 1
}

$epoch = Get-Date '1970-01-01T00:00:00Z'
$enviados = 0; $erros = 0; $i = 0; $mantidos = 0
foreach ($f in $lista) {
  $i++
  $rel = $f.FullName.Substring($base.Length + 1).Replace('\', '/')
  $mt = [int64][math]::Floor(($f.LastWriteTimeUtc - $epoch.ToUniversalTime()).TotalSeconds)
  $atual = $man[$rel]
  if ($atual -and [int64]$atual[0] -eq $f.Length -and [math]::Abs([int64]$atual[1] - $mt) -le 2) { continue }
  if ($atual -and ($regras -contains $rel) -and ([int64]$atual[1] -gt ($mt + 2))) { $mantidos++; continue }   # editado pelo CRM, mais novo no servidor
  if (-not $Silencioso) { Write-Host ("Enviando {0}/{1}: {2}" -f $i, $lista.Count, $rel) }
  try {
    $uri = "$servidor/arquivo?t=$token&m=$mt&p=" + [uri]::EscapeDataString($rel)
    Invoke-WebRequest -UseBasicParsing -Method Put -Uri $uri -InFile $f.FullName -ContentType 'application/octet-stream' -TimeoutSec 600 | Out-Null
    $enviados++
  } catch { $erros++; Anotar "Erro em $rel : $($_.Exception.Message)" 'Yellow' }
}
$msg = "Pronto. Enviados: $enviados. Erros: $erros. Conferidos: $($lista.Count)." + $(if ($mantidos) { " Mantidos no servidor (editados pelo CRM): $mantidos." } else { '' })
Anotar $msg 'Green'
Fim 0
