#!/usr/bin/env node
/**
 * render-pdf-map.mjs — 把 PDF 地图（首页）渲染成 JPG，供 Foundry 场景背景使用。
 *
 * 用途：模组作者给的地图常是 PDF（印刷用），Foundry 场景背景只接受图片，
 *       必须先栅格化。本脚本两端都用系统自带组件，零安装：
 *         - Windows: WinRT Windows.Data.Pdf.PdfDocument（经 PowerShell -EncodedCommand 内嵌调用）
 *         - macOS:   sips（系统自带图像工具）
 *
 * 用法（Node 一律用 ArcaneDesk 注入的 ARCANE_FVTT_NODE 绝对路径，PATH 里也有）：
 *   "%ARCANE_FVTT_NODE%" render-pdf-map.mjs <in.pdf> <out.jpg> [longEdge=5000]
 *   "$ARCANE_FVTT_NODE"  render-pdf-map.mjs <in.pdf> <out.jpg> [longEdge=5000]
 *
 * 实测（Windows/WinRT）：请求 longEdge=5000 实际输出约 7500px（WinRT 有约 1.5x 系数），
 * 做 FVTT 背景完全够用。macOS 的 sips 路径按 sips 文档实现，首次在 mac 上用请抽查输出尺寸。
 */
import { spawnSync } from 'node:child_process';

const [pdfPath, outPath, longEdge = '5000'] = process.argv.slice(2);
if (!pdfPath || !outPath) {
  console.error('usage: render-pdf-map.mjs <in.pdf> <out.jpg> [longEdge=5000]');
  process.exit(2);
}

if (process.platform === 'darwin') {
  const r = spawnSync('sips', [
    '-s', 'format', 'jpeg', '-s', 'formatOptions', '85',
    '--resampleHeightWidthMax', String(longEdge),
    pdfPath, '--out', outPath
  ], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (process.platform === 'win32') {
  // WinRT 渲染脚本。中文注释无碍：经 -EncodedCommand (UTF-16LE base64) 传入，
  // 不存在 .ps1 文件的编码问题。
  const ps = String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$PdfPath = $env:ARCPDF_IN; $OutPath = $env:ARCPDF_OUT
$LongEdge = [int]$env:ARCPDF_LONGEDGE
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
function Await-Op($op, [Type]$resultType) {
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 }
  $m = $methods[0].MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op)); $task.Wait(); return $task.Result
}
function Await-Action($op) {
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 }
  $task = $m[0].Invoke($null, @($op)); $task.Wait()
}
$file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$pdf = Await-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
"pages: $($pdf.PageCount)"
$page = $pdf.GetPage(0)
$w = $page.Size.Width; $h = $page.Size.Height
$scale = $LongEdge / [Math]::Max($w, $h)
$dw = [uint32][Math]::Round($w * $scale); $dh = [uint32][Math]::Round($h * $scale)
"render: $dw x $dh"
$opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opts.DestinationWidth = $dw; $opts.DestinationHeight = $dh
$mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
Await-Action ($page.RenderToStreamAsync($mem, $opts))
$mem.Seek(0)
$decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($mem)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
# GetFileFromPathAsync 要求目标已存在,先建空文件再覆盖;中途失败清掉残骸,不留 0 字节文件。
try {
  [System.IO.File]::WriteAllBytes($OutPath, [byte[]]@())
  $outFile = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($OutPath)) ([Windows.Storage.StorageFile])
  $ras = Await-Op ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  $encoder = Await-Op ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::JpegEncoderId, $ras)) ([Windows.Graphics.Imaging.BitmapEncoder])
  $encoder.SetSoftwareBitmap($bmp)
  Await-Action ($encoder.FlushAsync())
  $ras.Dispose()
} catch {
  try { $ras.Dispose() } catch {}
  if (Test-Path $OutPath) { Remove-Item $OutPath -Force -ErrorAction SilentlyContinue }
  throw
}
"out: $OutPath ({0:N1} MB)" -f ((Get-Item $OutPath).Length/1MB)
`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', enc], {
    stdio: 'inherit',
    env: { ...process.env, ARCPDF_IN: pdfPath, ARCPDF_OUT: outPath, ARCPDF_LONGEDGE: String(longEdge) }
  });
  process.exit(r.status ?? 1);
}

console.error('unsupported platform: ' + process.platform);
process.exit(1);
