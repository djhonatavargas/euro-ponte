# Envia regras, catalogo, fichas, fotos e videos para o servidor da Euro Ponte.
# Rodar no computador do Djhonata: botao direito > Executar com o PowerShell.
# So envia o que mudou. Pode rodar quantas vezes quiser.
$ErrorActionPreference = 'Stop'
$base = 'C:\Users\Public\catalogo'
$cfg = Join-Path $env:USERPROFILE 'euro-ponte.txt'

if (Test-Path $cfg) {
  $linhas = Get-Content $cfg
  $servidor = $linhas[0].Trim(); $token = $linhas[1].Trim()
} else {
  $servidor = Read-Host 'Endereco do servidor (ex.: 5.253.232.176)'
  $token = Read-Host 'Token que apareceu no fim da instalacao'
  if ($servidor -notmatch '^https?://') { $servidor = "http://$($servidor.Trim()):8080" }
  Set-Content -Path $cfg -Value @($servidor, $token.Trim())
}
$token = $token.Trim()

$regras = @('REGRAS-ATENDIMENTO.md','JEITO-DO-DJHONATA.md','ATENDIMENTO-INTELIGENTE.md','BASE-RESPOSTAS.md','APRENDIZADOS.md','combinados-clientes.md','CATALOGO.md')
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

Write-Host "Consultando o servidor $servidor ..."
$man = @{}
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$servidor/manifest?t=$token" -TimeoutSec 60
  $obj = $resp.Content | ConvertFrom-Json
  foreach ($p in $obj.PSObject.Properties) { $man[$p.Name] = $p.Value }
} catch {
  Write-Host "Nao consegui falar com o servidor: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Se o token ou o endereco estiverem errados, apague o arquivo $cfg e rode de novo."
  Read-Host 'Aperte Enter para fechar'; exit 1
}

$epoch = Get-Date '1970-01-01T00:00:00Z'
$enviados = 0; $erros = 0; $i = 0
foreach ($f in $lista) {
  $i++
  $rel = $f.FullName.Substring($base.Length + 1).Replace('\', '/')
  $mt = [int64][math]::Floor(($f.LastWriteTimeUtc - $epoch.ToUniversalTime()).TotalSeconds)
  $atual = $man[$rel]
  if ($atual -and [int64]$atual[0] -eq $f.Length -and [math]::Abs([int64]$atual[1] - $mt) -le 2) { continue }
  Write-Progress -Activity 'Enviando catalogo' -Status $rel -PercentComplete ([int](100 * $i / $lista.Count))
  try {
    $uri = "$servidor/arquivo?t=$token&m=$mt&p=" + [uri]::EscapeDataString($rel)
    Invoke-WebRequest -UseBasicParsing -Method Put -Uri $uri -InFile $f.FullName -ContentType 'application/octet-stream' -TimeoutSec 600 | Out-Null
    $enviados++
  } catch { $erros++; Write-Host "Erro em $rel : $($_.Exception.Message)" -ForegroundColor Yellow }
}
Write-Progress -Activity 'Enviando catalogo' -Completed
Write-Host ""
Write-Host "Pronto. Arquivos enviados: $enviados. Erros: $erros. Total conferido: $($lista.Count)." -ForegroundColor Green
if ($Host.Name -eq 'ConsoleHost' -and -not $env:EURO_PONTE_SILENCIOSO) { Read-Host 'Aperte Enter para fechar' }
