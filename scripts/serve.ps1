# СКАМ — простой локальный сервер для собранной версии (папка dist).
# Node.js не нужен: запускается двойным щелчком по start-skam.cmd (он читает этот файл как UTF-8).
# Открывает http://localhost:5173 — именно этот адрес должен быть в Supabase → Authentication → URL Configuration.
param(
  [int]$Port = 5173,
  [string]$Root = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Root 'index.html'))) {
  Write-Host "Не нашёл собранный сайт в папке: $Root" -ForegroundColor Red
  Write-Host 'Соберите его командой  npm run build  (нужен Node.js) и запустите снова.'
  if (-not $NoBrowser) { Read-Host 'Нажмите Enter, чтобы закрыть' }
  exit 1
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.webmanifest' = 'application/manifest+json'; '.json' = 'application/json'
  '.ico' = 'image/x-icon'; '.txt' = 'text/plain; charset=utf-8'; '.woff2' = 'font/woff2'
}
$rootFull = [System.IO.Path]::GetFullPath($Root)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Порт $Port занят — возможно, СКАМ уже запущен в другом окне." -ForegroundColor Yellow
  if (-not $NoBrowser) { Start-Process "http://localhost:$Port/"; Read-Host 'Нажмите Enter, чтобы закрыть' }
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  СКАМ запущен: $url" -ForegroundColor Green
Write-Host '  Не закрывайте это окно, пока пользуетесь мессенджером.'
Write-Host ''
if (-not $NoBrowser) { try { Start-Process $url } catch { } }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))
    $inside = $file.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $inside -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      if ([System.IO.Path]::HasExtension($rel)) {
        $res.StatusCode = 404
        $res.Close()
        continue
      }
      $file = Join-Path $rootFull 'index.html'   # адреса без файла отдаём приложению
    }
    $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
    if ($rel.StartsWith('assets/')) { $res.AddHeader('Cache-Control', 'public, max-age=31536000, immutable') }
    else { $res.AddHeader('Cache-Control', 'no-cache') }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $res.ContentLength64 = $bytes.Length
    if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
