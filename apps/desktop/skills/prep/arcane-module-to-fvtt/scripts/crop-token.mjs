#!/usr/bin/env node
/**
 * crop-token.mjs — 立绘方形裁切，供 FVTT Token 使用。
 *
 * 用途：模组立绘大多是竖版全身像，直接当 token 会把头切掉或人物过小。
 *       本脚本裁出对焦面部的正方形：
 *         - top:    顶部正方形（头像/半身立绘首选）
 *         - center: 居中正方形（全身怪物插画首选）
 *         - rect:   自定义矩形（-x -y -side，用于抽查发现裁歪后修正）
 *       裁完务必抽查输出图（read 图片），歪了用 rect 修。
 *
 * 平台实现均为系统自带组件，零安装：
 *   - Windows: System.Drawing（经 PowerShell -EncodedCommand 内嵌调用）
 *   - macOS:   sips（先读尺寸再 -c/--cropOffset）
 *
 * 用法（Node 用 ARCANE_FVTT_NODE）：
 *   node crop-token.mjs <src.jpg> <dst.jpg> [top|center]
 *   node crop-token.mjs <src.jpg> <dst.jpg> rect <x> <y> <side>
 *
 * macOS 的 sips 路径按 sips 文档实现，首次在 mac 上用请抽查输出。
 */
import { execFileSync, spawnSync } from 'node:child_process';

const [src, dst, mode = 'top', x = '0', y = '0', side = '0'] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: crop-token.mjs <src> <dst> [top|center] | crop-token.mjs <src> <dst> rect <x> <y> <side>');
  process.exit(2);
}

if (process.platform === 'darwin') {
  const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { encoding: 'utf8' });
  const w = Number(info.match(/pixelWidth:\s*(\d+)/)[1]);
  const h = Number(info.match(/pixelHeight:\s*(\d+)/)[1]);
  let s, cx, cy;
  if (mode === 'rect') {
    s = Number(side); cx = Number(x); cy = Number(y);
    if (!s) { console.error('rect 模式必须给 side'); process.exit(2); }
  } else {
    s = Math.min(w, h);
    cx = Math.floor((w - s) / 2);
    cy = mode === 'top' ? 0 : Math.floor((h - s) / 2);
  }
  const r = spawnSync('sips', ['-c', String(s), String(s), '--cropOffset', String(cy), String(cx), src, '--out', dst], { stdio: 'inherit' });
  console.log(`${dst} ${s}x${s} (from ${cx},${cy})`);
  process.exit(r.status ?? 1);
}

if (process.platform === 'win32') {
  const ps = String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:ARCCROP_SRC)
if ($env:ARCCROP_MODE -eq 'rect') {
  $side = [int]$env:ARCCROP_SIDE; $x = [int]$env:ARCCROP_X; $y = [int]$env:ARCCROP_Y
  if ($side -le 0) { throw 'rect mode requires side > 0' }
} else {
  $side = [Math]::Min($img.Width, $img.Height)
  $x = [int](($img.Width - $side) / 2)
  $y = 0; if ($env:ARCCROP_MODE -eq 'center') { $y = [int](($img.Height - $side) / 2) }
}
$bmp = New-Object System.Drawing.Bitmap $side, $side
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $side, $side), (New-Object System.Drawing.Rectangle $x, $y, $side, $side), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$bmp.Save($env:ARCCROP_DST, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose(); $img.Dispose()
"$($env:ARCCROP_DST) $side x $side (from $x,$y)"
`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', enc], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ARCCROP_SRC: src, ARCCROP_DST: dst, ARCCROP_MODE: mode,
      ARCCROP_X: String(x), ARCCROP_Y: String(y), ARCCROP_SIDE: String(side)
    }
  });
  process.exit(r.status ?? 1);
}

console.error('unsupported platform: ' + process.platform);
process.exit(1);
