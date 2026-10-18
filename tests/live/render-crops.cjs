// 实测用的"落点放大图"生成器。走【真 nativeImage】，也就是产品里那条一模一样的链路
// （crop -> resize -> 在落点画准星 -> toJPEG），所以测出来的东西和用户看到的是同一套像素。
//
// 用法：electron tests/live/render-crops.cjs <requests.json> <outdir>
//   requests.json: { "image": "target.png",
//                    "jobs": [ { "name":"aim-A-r1", "point":[x,y], "marked":true, "select":false, "w":320, "h":200, "scale":3 } ] }
//   · point  落点（源图像素）；裁图窗口以它为中心
//   · marked 是否画准星（默认 true）
//   · select 是否把该控件合成成"选中"态（默认 false）——用来测"模型能不能从图里读出选中状态"
// 输出：<outdir>/<name>.jpg + <outdir>/manifest.json
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const annotate = require('../../lib/annotate');

const argv = process.argv.slice(process.argv.findIndex(a => a.endsWith('render-crops.cjs')) + 1);
const inPath = argv[0];
const outDir = argv[1];

app.whenReady().then(() => {
  if (!inPath || !outDir) { console.error('用法：electron render-crops.cjs <requests.json> <outdir>'); app.exit(2); return; }
  const req = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const FIX = path.resolve(__dirname, '..', 'fixtures');
  const png = fs.readFileSync(path.join(FIX, req.image));
  const img = nativeImage.createFromDataURL('data:image/png;base64,' + png.toString('base64'));
  const src = img.getSize();
  if (img.isEmpty()) { console.error('源图解码失败'); app.exit(1); return; }

  const jobs = [];
  for (const j of req.jobs) {
    const scale = j.scale || 3;
    const w = j.w || 320, h = j.h || 200;
    const rect = annotate.clampRect(
      { x: Math.round(j.point[0] - w / 2), y: Math.round(j.point[1] - h / 2), w: w, h: h },
      src.width, src.height, 16, 16);
    const out = { width: rect.w * scale, height: rect.h * scale };
    const bmp = img.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }).resize(out).toBitmap();
    const cx = Math.round((j.point[0] - rect.x) * scale);
    const cy = Math.round((j.point[1] - rect.y) * scale);

    if (j.select) {
      // 合成的"选中"态：在圆心画一个实心圆盘。
      // 颜色不瞎猜——沿半径方向扫一圈，取最暗的那个像素（就是圆点自己的描边色），
      // 这样合成出来的样子和真控件是同一个色，不会让人一眼看出是 P 的。
      let fill = null, darkest = 999;
      for (let r = 6; r <= 20; r++) {
        const sx = cx + r * scale, sy = cy;
        if (sx < 0 || sx >= out.width) continue;
        const i = (sy * out.width + sx) * 4;
        const lum = bmp[i] + bmp[i + 1] + bmp[i + 2];
        if (lum < darkest) { darkest = lum; fill = [bmp[i], bmp[i + 1], bmp[i + 2]]; }
      }
      if (!fill) fill = [80, 80, 80];
      const R = 6 * scale;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue;
          const i = (y * out.width + x) * 4;
          bmp[i] = fill[0]; bmp[i + 1] = fill[1]; bmp[i + 2] = fill[2]; bmp[i + 3] = 255;
        }
      }
    }

    if (j.marked !== false) annotate.paintCrosshair(bmp, out.width, out.height, cx, cy, { scale: scale });

    const jpeg = nativeImage.createFromBuffer(bmp, { width: out.width, height: out.height }).toJPEG(85);
    const file = j.name + '.jpg';
    fs.writeFileSync(path.join(outDir, file), jpeg);
    jobs.push({ name: j.name, file: file, point: j.point, rect: rect, scale: scale,
                marked: j.marked !== false, select: !!j.select, bytes: jpeg.length });
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(
    { image: req.image, width: src.width, height: src.height, jobs: jobs, at: new Date().toISOString() }, null, 2));
  console.log('[render-crops] 写出 ' + jobs.length + ' 张裁图 → ' + outDir);
  for (const j of jobs) console.log(`  ${j.file}  ${j.bytes}B  rect=${JSON.stringify(j.rect)} marked=${j.marked} select=${j.select}`);
  app.quit();
}).catch(e => { console.error('render-crops 失败：' + (e && e.message)); app.exit(1); });
