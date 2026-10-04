#!/usr/bin/env node
/**
 * 生成 AgentHub 的图标（多尺寸 .ico + 一张 PNG 预览）。
 *
 * ## 为什么手写，不用图像库
 *
 * 本机装火绒实时防护，`npm install sharp / jimp / png-to-ico` 那一类会拖很久、
 * 还可能在中途被拦成半装（见 docs/05 里记的 os error 5）。
 * 而这里要的东西**标准库就够**：
 *
 *   - PNG 编码 = zlib 压缩 + 每块一个 CRC32（Node 自带 `node:zlib`）
 *   - ICO 容器 = 6 字节头 + N×16 字节目录 + 各尺寸的 PNG 原样塞进去
 *     （Vista 以后 ICO 允许条目直接是 PNG 数据，不必用老的 BMP+AND 掩码格式）
 *   - 画图 = 有符号距离场（SDF）逐像素判定，4 倍超采样后降采样当抗锯齿
 *
 * 所以这个文件零依赖、离线可跑、结果**逐字节可复现**（没有任何随机数）。
 * 可复现这点很重要：校验器要拿"图标文件里的字节"和"exe 里嵌的字节"做相等比较，
 * 生成过程只要有一点不确定，那条断言就永远是假红。
 *
 * ## 图形
 *
 * 六边形（"芯片"）轮廓 + 赛博霓虹（青 → 紫 → 品红），中间是**枢纽符号**：
 * 几个发光节点连成一张网 —— 一个中枢带着若干成员。
 *
 * 这不是装饰：AgentHub 做的事就是"一个主 Agent 编排若干子 Agent"，
 * 节点 + 连线就是它的字面样子。
 *
 * ★ 2026-10-01 改了三版，每一版都是被"小尺寸"逼出来的：
 *
 *   1. 最初的"主脑 + 三个成员"：32px / 16px 下四个点加三条线只剩一个白团，
 *      看不出画的是什么；
 *   2. 换成"六边形 + 白色字母 A"：字形轮廓在同样的像素预算里信息量大得多，
 *      大小尺寸都认得出 —— 但 A 只是首字母，不表达"这件事本身"；
 *   3. 现在这版：回到节点 / 网络的语意，改成**深色底 + 发光线**。
 *      亮线自己就是轮廓（不靠字形，也不靠实心色块），16px 下看到的是几个
 *      亮点而不是一坨糊；线条粗细和节点大小还能各自调，比字形好"喂"给像素。
 *
 * 外轮廓始终是六边形：周长比圆角方块短、顶点更少，抗锯齿要磨的边少，
 * 小尺寸反而更实；而且一眼就是"芯片 / 元件"。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 出图尺寸：Windows 资源管理器/任务栏/Alt-Tab 会各取所需，16 和 256 都不能少 */
export const SIZES = [256, 128, 64, 48, 32, 16]

/** 4 倍超采样 —— 抗锯齿靠降采样，不靠画线算法 */
const SS = 4

/**
 * 霓虹色的三段。色相与界面同源（青 --brand #22d3ee → 紫 --brand-2 #a78bfa，
 * 见 ui/public/style.css），但饱和度和亮度都拉满：图标是"深色底上的一束光"，
 * 界面里那组偏柔和的品牌色直接当光用会发灰。末端补一段品红，
 * 只有青→紫的话整个图标偏冷，右下角压不住。
 */
const NEON = [
  [0, 240, 255],    // #00f0ff 青
  [128, 92, 255],   // #805cff 紫
  [255, 44, 190],   // #ff2cbe 品红
]

/** 六边形内部的底色：不是纯黑，是一层很暗的蓝紫渐变，好让光晕有落点 */
const BASE = [
  [7, 10, 22],      // #070a16
  [20, 24, 48],     // #141830
]

// ────────────────────────────────────────────────── PNG 编码

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 一个 PNG 块：长度 + 类型 + 数据 + CRC（CRC 覆盖类型和数据） */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * RGBA 像素缓冲 → PNG 字节。
 *
 * 每行前置一个 filter 字节（0 = None）。用过滤器 0 而不是"挑最优过滤器"：
 * 图标是大色块 + 硬边，0 的压缩率已经够好，而选过滤器会引入额外的不确定性。
 */
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8        // 位深
  ihdr[9] = 6        // 颜色类型 6 = RGBA
  ihdr[10] = 0       // 压缩方法
  ihdr[11] = 0       // 过滤方法
  ihdr[12] = 0       // 隔行扫描：关
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ────────────────────────────────────────────────── 画图（SDF）

/**
 * 六边形外接圆半径（占整图的百分比）。
 *
 * 取 0.452 而不是 0.5：六边形是**尖顶**的（上下是顶点、左右是边），
 * 上下顶点天然比左右更靠外，用 0.452 才能让上下留白与左右留白看起来一样宽，
 * 任务栏上不至于顶边。
 */
const OUTER_R = 0.452

/**
 * 到六边形六条边的**有符号距离**（正数 = 在内部，数值就是离边多远）。
 *
 * 不去逐条描那六条边：六边形可以看成**三组平行边各夹出一个带状区域**，
 * 三者里最紧的那条就决定到边的距离（法线取 0° / 60° / 120°，每条边到中心的
 * 距离是内切半径 = 外接圆半径 × cos30°）。判定于是退化成三次绝对值比较，
 * 不引入额外的边界情况。
 *
 * 这里给的是**有符号距离**而不是布尔判定：外框要画成"一圈实心霓虹 + 往外漏
 * 一点光"，光晕得靠"离边多远"这个连续量才画得出来（抗锯齿仍然归超采样管）。
 */
function hexIn(x, y, size) {
  const dx = x - size / 2
  const dy = y - size / 2
  const ap = size * OUTER_R * Math.cos(Math.PI / 6)   // 内切半径（边到中心）
  const s = Math.sin(Math.PI / 3)
  return ap - Math.max(Math.abs(dx), Math.abs(dx * 0.5 + dy * s), Math.abs(dx * 0.5 - dy * s))
}

/** 点到线段的距离 —— 连线用胶囊形（线段 + 半径）画，粗细才均匀 */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay
  const wx = px - ax, wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
}

/** 线性混色（f=0 取 a，f=1 取 b）。取整留到最后写像素时做，中间过程保住精度 */
function mix(a, b, f) {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** 在一组色标上按 t∈[0,1] 取色，色标之间线性插值 */
function ramp(stops, t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  const s = c * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(s))
  return mix(stops[i], stops[i + 1], s - i)
}

/** 线条与节点的心儿要往白里提，白是常量，单独拎出来省得随手写错 */
const WHITE = [255, 255, 255]

/**
 * 画一个尺寸的图标，返回 RGBA 缓冲。
 *
 * 逐像素在**超采样网格**上判定，再 4×4 求平均 —— 边缘因此有 16 级过渡。
 * 平均按**预乘 alpha**算（颜色先乘 alpha 再加权），否则边缘会混进透明像素的黑色，
 * 出现一圈脏边（这个坑用图像库时是库帮你处理的，手写就得自己记着）。
 */
export function drawIcon(size) {
  const S = size * SS
  const out = Buffer.alloc(size * size * 4)

  /*
   * ★ ≤20px：图形不变，只做三件事 —— 线加粗、节点放大、**光晕全关**。
   *
   * 光晕在 16px 上只有 1 个像素宽，渲染出来是一圈灰边，把本来就不多的对比度
   * 吃掉；关掉它，亮的就是亮的、暗的就是暗的。
   * 节点从 6 个减到 3 个是同一个理由：6 个点在 16px 上会挤成一片。
   */
  const tiny = size <= 20

  // 枢纽符号的几何：节点 = (x, y, r)，都是占整图的百分比；edges = 哪两个节点相连
  const nodes = tiny
    ? [[0.50, 0.46, 0.150], [0.30, 0.30, 0.100], [0.70, 0.62, 0.110]]
    : [[0.50, 0.46, 0.115], [0.30, 0.28, 0.085], [0.63, 0.22, 0.065],
       [0.74, 0.56, 0.085], [0.42, 0.72, 0.075], [0.28, 0.52, 0.060]]
  const edges = tiny
    ? [[0, 1], [0, 2], [1, 2]]
    : [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 5], [2, 3], [3, 4], [1, 4]]

  const lineW = S * (tiny ? 0.028 : 0.015)   // 连线的半宽
  const rimW = S * (tiny ? 0.048 : 0.030)    // 外框的宽度
  const rimGlow = tiny ? 0 : S * 0.045       // 外框往外漏的光

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5
          const py = y * SS + sy + 0.5
          const dOut = hexIn(px, py, S)
          if (dOut < 0) continue   // 六边形外：透明

          // 光从左上打到右下：沿对角线取色，整张图才有"一个光源"的感觉
          const t = Math.min(1, Math.max(0, (px + py) / (2 * S)))
          const neon = ramp(NEON, t)
          let [cr, cg, cb] = ramp(BASE, t)

          // 外框：一圈实心霓虹，再往外漏一点光
          if (dOut <= rimW) {
            cr = neon[0]; cg = neon[1]; cb = neon[2]
          } else if (rimGlow > 0 && dOut <= rimW + rimGlow) {
            const f = 1 - (dOut - rimW) / rimGlow
            const k = f * f * 0.5
            cr += (neon[0] - cr) * k; cg += (neon[1] - cg) * k; cb += (neon[2] - cb) * k
          }

          /*
           * 枢纽符号：连线和节点各算一个"到边缘的有符号距离"，**取最小的那个**
           * 来画，而不是逐个叠加。
           *
           * 叠加的话，节点压在连线上的地方会先被连线染色、再被节点盖一次，
           * 交界处出现一圈颜色不对的镶边。取最小值等价于距离场的并集，
           * 交接处干干净净 —— 这也是"先算距离、后上色"的全部好处。
           */
          let sd = Infinity, white = 0, glow = 0
          for (const [i, j] of edges) {
            const d = distToSegment(
              px, py,
              nodes[i][0] * S, nodes[i][1] * S,
              nodes[j][0] * S, nodes[j][1] * S,
            ) - lineW
            if (d < sd) { sd = d; white = 0.40; glow = 0.040 }
          }
          for (let i = 0; i < nodes.length; i++) {
            const d = Math.hypot(px - nodes[i][0] * S, py - nodes[i][1] * S) - nodes[i][2] * S
            if (d < sd) { sd = d; white = i === 0 ? 0.90 : 0.70; glow = 0.065 }
          }

          if (sd <= 0) {
            // 线条和节点都往白里提，中心那个节点提得最多：小尺寸下这点白就是辨识度
            cr = neon[0] + (WHITE[0] - neon[0]) * white
            cg = neon[1] + (WHITE[1] - neon[1]) * white
            cb = neon[2] + (WHITE[2] - neon[2]) * white
          } else if (!tiny && sd <= S * glow) {
            const f = 1 - sd / (S * glow)
            const k = Math.min(1, f * f * 0.85)
            cr += (neon[0] - cr) * k; cg += (neon[1] - cg) * k; cb += (neon[2] - cb) * k
          }

          r += cr; g += cg; b += cb; a += 255
        }
      }
      const n = SS * SS
      const av = a / n
      const i = (y * size + x) * 4
      if (av <= 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue }
      // 预乘平均 → 反预乘回直通 alpha
      out[i] = Math.min(255, Math.round(r / n * 255 / av))
      out[i + 1] = Math.min(255, Math.round(g / n * 255 / av))
      out[i + 2] = Math.min(255, Math.round(b / n * 255 / av))
      out[i + 3] = Math.round(av)
    }
  }
  return out
}

// ────────────────────────────────────────────────── ICO 容器

/**
 * 把若干个 PNG 打成 .ico。
 *
 * 目录项里的宽高字段是**字节**：256 写 0（一个字节装不下 256），其余写实际值。
 * 这一条不写对的话，256×256 那张会被系统当成 0×0 忽略掉 —— 大图标就没了。
 */
export function buildIco(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // 保留位
  header.writeUInt16LE(1, 2)   // 1 = 图标（2 是光标）
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0                                   // 调色板数（真彩无调色板）
    dir[o + 3] = 0                                   // 保留位
    dir.writeUInt16LE(1, o + 4)                      // 色彩平面
    dir.writeUInt16LE(32, o + 6)                     // 位深
    dir.writeUInt32LE(e.png.length, o + 8)           // 该条目字节数
    dir.writeUInt32LE(offset, o + 12)                // 数据起点
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ────────────────────────────────────────────────── 主流程（直接运行才执行）

/** 被直接运行（而不是被测试 import）时才写文件 —— 用规范 URL 比较，别猜 argv */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
const entries = SIZES.map((size) => ({ size, png: encodePng(drawIcon(size), size, size) }))
const ico = buildIco(entries)

const icoPath = join(ROOT, 'ui', 'public', 'agenthub.ico')
mkdirSync(dirname(icoPath), { recursive: true })
writeFileSync(icoPath, ico)

// 预览图给人和文档看（.ico 在浏览器里不好直接展示）
const previewArg = process.argv.indexOf('--preview')
if (previewArg !== -1 && process.argv[previewArg + 1]) {
  const p = resolve(process.argv[previewArg + 1])
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, entries.find((e) => e.size === 256).png)
  console.log(`预览图：${p}`)
}

/**
 * 对照图：每个尺寸**原大小**排一行，同尺寸**放大 4 倍**（最近邻）排一行。
 *
 * 为什么要这个东西：图标"在 256px 下好看"是最没信息量的一句评价 ——
 * 真正决定成败的是 16px（资源管理器列表、任务栏小图标）糊不糊。
 * 放大 4 倍是为了让人眼**看得见** 16px 里那 1~2 个像素到底画成了什么，
 * 否则只能是"看着还行"这种没法验证的话。
 */
const sheetArg = process.argv.indexOf('--sheet')
if (sheetArg !== -1 && process.argv[sheetArg + 1]) {
  const p = resolve(process.argv[sheetArg + 1])
  const pad = 12
  const zoom = 4
  const rowNat = Math.max(...SIZES)          // 原大小行的行高
  const rowZoom = 16 * zoom + pad            // 放大行：拿 16px 放大
  const W = pad + SIZES.reduce((s, x) => s + x + pad, 0)
  const H = pad + rowNat + pad + rowZoom
  const canvas = Buffer.alloc(W * H * 4)
  // 背景：浅灰（图标是彩色的，浅底更能看出边缘有没有脏）
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = 244; canvas[i * 4 + 1] = 244; canvas[i * 4 + 2] = 242; canvas[i * 4 + 3] = 255
  }
  const blit = (src, sw, sh, dx, dy, scale) => {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const a = src[(y * sw + x) * 4 + 3]
        if (a === 0) continue
        // 只处理不透明像素：图标本体没有半透明区（边缘 alpha 由降采样生成，这里取整即可）
        const alpha = a / 255
        for (let yy = 0; yy < scale; yy++) {
          for (let xx = 0; xx < scale; xx++) {
            const tx = dx + x * scale + xx, ty = dy + y * scale + yy
            if (tx >= W || ty >= H) continue
            const o = (ty * W + tx) * 4
            for (let c = 0; c < 3; c++) {
              canvas[o + c] = Math.round(src[(y * sw + x) * 4 + c] * alpha + canvas[o + c] * (1 - alpha))
            }
          }
        }
      }
    }
  }
  let x = pad
  for (const e of entries) {                     // 原大小行：底对齐
    const px = drawIcon(e.size)
    blit(px, e.size, e.size, x, pad + rowNat - e.size, 1)
    x += e.size + pad
  }
  x = pad
  const small = drawIcon(16)
  for (const e of entries) {                     // 放大行：同一个 16px 图标放大 4 倍看细节
    blit(small, 16, 16, x, pad + rowNat + pad, zoom)
    x += 16 * zoom + pad
  }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, encodePng(canvas, W, H))
  console.log(`对照图：${p}（${W}×${H}）`)
}

console.log(`图标已生成：${icoPath}`)
console.log(`  ${entries.length} 个尺寸：${SIZES.join(' / ')}，共 ${ico.length} 字节`)
}
