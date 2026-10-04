#!/usr/bin/env node
/**
 * 把一对一对的 before / after 截图拼成**一张自包含的 HTML 对照页**。
 *
 * 为什么不用 `<img src="shots/xxx.png">` 相对路径：这份页面是拿去给别人看的，
 * 常常是"单独打开一个文件"（甚至是从别处打开）——只要图片是外链，就有一半概率裂图。
 * 所以图片一律转成 data URI 内嵌，页面离开这些 png 也能看。
 *
 * 用法：
 *   node tools/make-compare-page.mjs --dir .tmp-shots --out docs/shots/界面重做-2026-09-30.html \
 *        --title "AgentHub 界面重做（2026-09-30）"
 *
 * 命名约定（shot-redesign.mjs 就是这么产出的）：
 *   `<tag>-<序号>-<标题>.png`，同一序号的两张即一对。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const DIR = argOf('dir', '.tmp-shots')
const OUT = argOf('out', join(DIR, 'compare.html'))
const TITLE = argOf('title', '界面 before / after')
const BEFORE_TAG = argOf('before', 'before')
const AFTER_TAG = argOf('after', 'after')

// 解析 `tag-N-标题.png`
const items = new Map()
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.png'))) {
  const m = f.match(/^([^-]+)-(\d+)-(.+)\.png$/)
  if (!m) continue
  const [, tag, no, label] = m
  if (tag !== BEFORE_TAG && tag !== AFTER_TAG) continue
  if (!items.has(no)) items.set(no, { no, label })
  items.get(no)[tag] = f
}

const rows = [...items.values()].sort((a, b) => Number(a.no) - Number(b.no))
if (!rows.length) {
  console.error(`在 ${DIR} 里没找到 \`${BEFORE_TAG}-N-*.png\` / \`${AFTER_TAG}-N-*.png\``)
  process.exit(1)
}
const uri = (f) => 'data:image/png;base64,' + readFileSync(join(DIR, f)).toString('base64')

const body = rows.map((r) => `
  <section>
    <h2><span class="no">${r.no}</span>${r.label}</h2>
    <div class="pair">
      <figure>
        <figcaption><span class="tag before">改版前</span></figcaption>
        ${r[BEFORE_TAG] ? `<img src="${uri(r[BEFORE_TAG])}" alt="before ${r.label}">` : '<div class="missing">缺图</div>'}
      </figure>
      <figure>
        <figcaption><span class="tag after">改版后</span></figcaption>
        ${r[AFTER_TAG] ? `<img src="${uri(r[AFTER_TAG])}" alt="after ${r.label}">` : '<div class="missing">缺图</div>'}
      </figure>
    </div>
  </section>`).join('\n')

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${TITLE}</title>
<style>
  :root { --line:#e7e7ee; --text:#17171c; --text-2:#55555f; --text-3:#8b8b97; --bg:#f6f6f9;
          --brand:#22d3ee; --brand-ink:#0b7285; --grad:linear-gradient(120deg,#22d3ee,#4d6bfe 52%,#7c5cfc); }
  * { box-sizing:border-box; }
  body { margin:0; padding:40px 32px 64px; background:var(--bg); color:var(--text);
         font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { max-width:1600px; margin:0 auto 28px; }
  h1 { margin:0 0 8px; font-size:23px; font-weight:680;
       background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .lead { color:var(--text-2); max-width:900px; }
  .lead code { background:#fff; border:1px solid var(--line); border-radius:5px; padding:0 4px; }
  section { max-width:1600px; margin:0 auto 36px; }
  h2 { display:flex; align-items:center; gap:12px; margin:0 0 14px; font-size:15px; font-weight:600; color:var(--text-2); }
  h2::after { content:''; flex:1; height:1px; background:var(--line); }
  .no { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center;
        border-radius:50%; background:#ececf2; color:var(--text-3); font-size:11px; font-weight:650; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  @media (max-width:1100px) { .pair { grid-template-columns:1fr; } }
  figure { margin:0; background:#fff; border:1px solid var(--line); border-radius:14px; overflow:hidden;
           box-shadow:0 1px 2px rgba(20,20,34,.05); }
  figcaption { padding:8px 14px; border-bottom:1px solid var(--line); }
  .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; }
  .tag.before { background:#ececf2; color:var(--text-3); }
  .tag.after { background:rgba(34,211,238,.12); color:var(--brand-ink); font-weight:600; }
  img { display:block; width:100%; }
  .missing { padding:60px; text-align:center; color:var(--text-3); }
  footer { max-width:1600px; margin:0 auto; color:var(--text-3); font-size:12px; }
</style></head>
<body>
<header>
  <h1>${TITLE}</h1>
  <p class="lead">左「改版前」取自上一份打包产物（<code>release/AgentHub/resources/app/ui/public/</code>），
     右「改版后」是当前工作区。两边的窗口尺寸、成员探活结果、注入的假数据完全一致 ——
     差别只来自版式本身。截图工具：<code>tests/shot-redesign.mjs</code>。</p>
</header>
${body}
<footer>共 ${rows.length} 组对照。图片以 data URI 内嵌在本文件里，可单独分发。</footer>
</body></html>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
const kb = Math.round(Buffer.byteLength(html) / 1024)
console.log(`✓ ${OUT}   ${rows.length} 组对照 · ${kb} KB`)
