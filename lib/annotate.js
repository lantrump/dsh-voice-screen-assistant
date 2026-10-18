// lib/annotate.js —— 裁块、放大、在落点画十字的纯像素数学。
//
// 为什么要单独一个模块：主进程的 nativeImage 没有画图能力
// （只有 createFromDataURL / crop / resize / getSize / toBitmap / toJPEG / createFromBuffer），
// 所以十字得自己往裸 BGRA 缓冲上写。而 main.js 是被 Module._load 劫持加载的、不 export 任何东西，
// 像素数学放在里面就测不动——放这里才能直接 import 单测。

/**
 * 把裁图窗口夹进源图范围内。
 * 尺寸不够就缩到源图大小；位置越界就【平移】回来（而不是缩小），
 * 这样贴边时仍然尽量看得到落点周围的一整块，代价是落点会偏心——
 * 所以 crosshairIndex 必须按源点算，不能拿裁图的几何中心。
 *
 * @param {{x:number,y:number,w:number,h:number}} rect 想要的窗口（源像素）
 * @param {number} srcW 源图宽
 * @param {number} srcH 源图高
 * @param {number} [minW] w 的下限（默认 1）
 * @param {number} [minH] h 的下限（默认 1）
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function clampRect(rect, srcW, srcH, minW, minH) {
  const r = rect || {};
  const W = Math.max(1, Math.round(Number(srcW) || 0));
  const H = Math.max(1, Math.round(Number(srcH) || 0));
  const mw = Math.max(1, Math.round(Number(minW) || 1));
  const mh = Math.max(1, Math.round(Number(minH) || 1));
  const w = Math.min(W, Math.max(mw, Math.round(Number(r.w) || 0)));
  const h = Math.min(H, Math.max(mh, Math.round(Number(r.h) || 0)));
  const x = Math.max(0, Math.min(W - w, Math.round(Number(r.x) || 0)));
  const y = Math.max(0, Math.min(H - h, Math.round(Number(r.y) || 0)));
  return { x: x, y: y, w: w, h: h };
}

/**
 * 落点在【放大后】的裁图里的像素下标。
 * 按源点算，不是拿裁图中心算：贴边时 clampRect 会把窗口平移，落点是偏心的。
 *
 * @param {{x:number,y:number}} point 落点（源像素）
 * @param {{x:number,y:number}} rect 已夹好的窗口（源像素）
 * @param {number} scale 放大倍数
 * @returns {{cx:number,cy:number}}
 */
function crosshairIndex(point, rect, scale) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const px = Number(point && point.x) || 0;
  const py = Number(point && point.y) || 0;
  return {
    cx: Math.round((px - Number(rect && rect.x || 0)) * s),
    cy: Math.round((py - Number(rect && rect.y || 0)) * s),
  };
}

/**
 * 在 BGRA 位图上原地画一个"空心圆环 + 四条臂"的准星。
 *
 * 用洋红 (255,0,255)：toBitmap() 在 Windows 上给的是 BGRA 序，写纯红会渲染成蓝；
 * 洋红在 R↔B 互换下不变，免掉一整类"标记颜色不对"的平台 bug。
 *
 * 为什么是空心环 + 断开的臂，而不是实心十字：
 * 落点正下方就是要看的那个控件（单选圆点之类），实心块会正好把它盖住。
 * 所以中心留出 hole 半径的空洞，臂也从 gap 处才起步。
 *
 * 【单位】hole/ring/gap/arm 都是【源像素】，内部乘 scale。
 * 这样准星相对屏幕元素的大小与放大倍数无关——不然放大 3 倍后准星会缩成比它指的那个圆点还小，
 * 一眼看不出"落点偏了多少"，而"看清偏了多少"正是这张图存在的全部理由。
 *
 * @param {Buffer|Uint8Array} bitmap BGRA 裸像素，长度 = outW*outH*4
 * @param {number} outW 放大后宽
 * @param {number} outH 放大后高
 * @param {number} cx 准星中心 x（放大后像素）
 * @param {number} cy 准星中心 y
 * @param {{scale?:number,hole?:number,ring?:number,gap?:number,arm?:number}} [opts]
 * @returns {Buffer|Uint8Array} 同一个 bitmap（原地改）
 */
function paintCrosshair(bitmap, outW, outH, cx, cy, opts) {
  const o = opts || {};
  const s = Number(o.scale) > 0 ? Number(o.scale) : 1;
  const at = (v, dft) => Math.round((v == null ? dft : v) * s);
  const hole = Math.max(0, at(o.hole, 5));
  const ring = Math.max(hole, at(o.ring, 7));
  const gap = Math.max(0, at(o.gap, 9));
  const arm = Math.max(0, at(o.arm, 10));
  const thick = Math.max(1, Math.round(s));      // 臂的粗细也跟着走：1px 的线在 960 宽的图上太细，压完 JPEG 就糊了
  const half = Math.floor(thick / 2);

  function put(x, y) {
    if (x < 0 || y < 0 || x >= outW || y >= outH) return;
    const i = (y * outW + x) * 4;
    if (i + 3 >= bitmap.length) return;
    bitmap[i] = 255;        // B
    bitmap[i + 1] = 0;      // G
    bitmap[i + 2] = 255;    // R
    bitmap[i + 3] = 255;    // A
  }

  // 圆环：半径 hole..ring 这一圈。中心 hole 以内是空的。
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= hole || d > ring) continue;
      put(cx + dx, cy + dy);
    }
  }
  // 四条臂：从 gap 画到 gap+arm，中间那截留空，不遮住要看的控件。
  for (let k = gap; k <= gap + arm; k++) {
    for (let t = -half; t < thick - half; t++) {
      put(cx - k, cy + t);
      put(cx + k, cy + t);
      put(cx + t, cy - k);
      put(cx + t, cy + k);
    }
  }
  return bitmap;
}

/**
 * 在整屏截图上标出鼠标指针。
 *
 * 为什么要画：用户说"点这个"时，模型看到的只有静态画面，不知道鼠标在哪。
 * 系统截屏 API 本身不包含指针（Windows 的抓屏拿不到光标图层），
 * 所以只能自己按屏幕坐标画一个标准的白色描边黑色箭头。
 *
 * 形状是一支指向左上、箭头尖在 (cx,cy) 的经典指针。
 * 先按"多边形内部 = 黑"，"离多边形 r 像素以内 = 白"画出描边，
 * 这样凹口内侧也有均匀的描边，比按顶点缩放更稳。
 *
 * @param {Buffer|Uint8Array} bitmap BGRA 裸像素
 * @param {number} outW 图宽（物理像素）
 * @param {number} outH 图高
 * @param {number} cx 指针尖 x
 * @param {number} cy 指针尖 y
 * @param {{scale?:number}} [opts] scale：指针整体放大倍数（高 DPI 截图传 2 等），默认 1
 * @returns {Buffer|Uint8Array} 同一个 bitmap（原地改）
 */
const CURSOR_SHAPE = [
  [0, 0], [0, 18], [4.6, 13.6], [7.6, 20.4], [10.4, 19], [7.6, 12.2], [13, 12.2],
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function paintCursor(bitmap, outW, outH, cx, cy, opts) {
  const s = Number(opts && opts.scale) > 0 ? Number(opts.scale) : 1;
  const ox = Math.round(Number(cx) || 0);
  const oy = Math.round(Number(cy) || 0);
  const poly = CURSOR_SHAPE.map(([x, y]) => [ox + x * s, oy + y * s]);
  const outline = Math.max(1, Math.round(s));      // 描边宽度（像素）

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX = Math.max(0, Math.floor(minX - outline));
  minY = Math.max(0, Math.floor(minY - outline));
  maxX = Math.min(outW - 1, Math.ceil(maxX + outline));
  maxY = Math.min(outH - 1, Math.ceil(maxY + outline));

  const inside = (x, y) => pointInPolygon(x, y, poly);
  const near = (x, y) => {
    for (let dy = -outline; dy <= outline; dy++) {
      for (let dx = -outline; dx <= outline; dx++) {
        if (dx * dx + dy * dy > outline * outline) continue;
        if (inside(x + dx + 0.5, y + dy + 0.5)) return true;
      }
    }
    return false;
  };

  function put(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= outW || y >= outH) return;
    const i = (y * outW + x) * 4;
    if (i + 3 >= bitmap.length) return;
    bitmap[i] = b; bitmap[i + 1] = g; bitmap[i + 2] = r; bitmap[i + 3] = 255;
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (inside(x + 0.5, y + 0.5)) put(x, y, 0, 0, 0);
      else if (near(x, y)) put(x, y, 255, 255, 255);
    }
  }
  return bitmap;
}

module.exports = { clampRect, crosshairIndex, paintCrosshair, paintCursor };
