#!/usr/bin/env node
/**
 * 样式覆盖检查：界面用到的每个 class，样式表里到底有没有对应规则？
 *
 * ## 为什么需要它
 *
 * 界面冒烟有 130+ 条断言，但它们**盯的是行为**（点了有没有反应、状态对不对），
 * 一条都不管"这块东西长什么样"。于是改版时最典型的翻车就是这么发生的：
 * 模板里写了个 `class="chat-head"`，样式表里忘了定义 ——
 * 元素照样渲染、功能照样可用、冒烟全绿，只有人眼能看出"这一块没样式"。
 * 反过来也一样：样式表里躺着 `.msg-ai2` 这种早没人用的死规则，
 * 谁也不知道能不能删（于是谁也不敢删，越长越乱）。
 *
 * 这个脚本把两件事都变成可检查的：**用了但没定义** 和 **定义了但没人用**。
 *
 * ## 怎么抽（以及为什么这么抽）
 *
 * 用到的 class 有三个来源，缺一不可：
 *  1. `index.html` 与 `app.js` 里的 `class="..."` 属性（含模板字符串里的）；
 *  2. `classList.add/remove/toggle('x')` —— 动态类名只出现在这里；
 *  3. `classList.toggle('x', cond)` 同理。
 *
 * 样式表这一侧只认「类选择器」，用括号配平的方式扫 CSS 的规则头
 * （`.a, .b:focus {` → a、b），这样 `:hover` / `:not()` / 后代选择器都能处理。
 *
 * ## 方向不平衡：两条都报，但只有一条是红的
 *
 * - **用了但没定义 = 缺陷**（元素裸奔）→ 计入退出码，构建会红。
 * - **定义了但没人用** = 卫生问题 → 只列出来，不红。
 *   因为动态拼接的类名（`class="dot ${st}"`）永远可能有第三种来源漏抽，
 *   拿它当错误会误伤，久了就没人看这个脚本了。
 *
 * 用法：node tools/check-css-coverage.mjs [--verbose]
 */
import { readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v')

const CSS = join(ROOT, 'ui', 'public', 'style.css')
const SOURCES = ['ui/public/index.html', 'ui/public/app.js']

// ────────────────────────────────────────────────── 抽出「用到的 class」

/*
 * 只从 **class 属性内部**抽，不在全文件里瞎找字符串。
 *
 * 第一版是"把源码里所有带引号的短标识符都当类名"，结果 `data-act="del-chat"`、
 * `${act}` 这类**动作名**全被当成 class，一次报 22 个假缺口 —— 假缺口一多，
 * 这个脚本就会被当成噪音，然后没人再看它。所以抽取必须有上下文：
 *
 *   1. `class="..."` 里的**字面量部分** → 直接是类名；
 *   2. `class="..."` 里的 `${...}` 表达式 → 里面的字符串字面量才是类名
 *      （`${active ? ' active' : ''}` → `active`，注意要允许引号里有前导空格）；
 *   3. `classList.add/remove/toggle/contains('x')` —— 动态类名只出现在这里。
 */
const fromClassAttr = (src, add) => {
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const value = m[1]
    // 先摘掉所有 ${...}，剩下的是字面量
    const literals = value.replace(/\$\{[^}]*\}/g, ' ')
    for (const c of literals.split(/\s+/)) add(c)
    // 再回头进每个 ${...} 里找字符串字面量（trim 掉引号里的空格）
    for (const ex of value.matchAll(/\$\{([^}]*)\}/g)) {
      /*
       * ⚠️ 先把**比较表达式**删掉再抽。
       * `class="home-tab${tab === 'solo' ? ' on' : ''}"` 里，`'solo'` 是和 `tab` 比的值，
       * 不是类名 —— 第一版把它当成了类，于是报了一个假缺口 `.solo`。
       * 假缺口比漏报更伤：它会让这个脚本被当成噪音。
       */
      const body = ex[1]
        .replace(/[=!]==?\s*(['"])[^'"]*\1/g, ' ')          // tab === 'solo'
        .replace(/(['"])[^'"]*\1\s*[=!]==?\s*/g, ' ')        // 'solo' === tab
      /*
       * 一个字面量里可以写**多个**类名（`${wide ? 'modal wide' : 'modal'}`）——
       * 必须按空白拆开。第一版直接 `add(q[1])`，于是 `'modal wide'` 因为含空格
       * 被整条丢掉，`.modal.wide` 一直被误报成死样式。
       */
      for (const q of body.matchAll(/['"]([^'"]*)['"]/g)) {
        for (const c of q[1].split(/\s+/)) add(c)
      }
    }
  }
}
const fromClassList = (src, add) => {
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) add(q[1])
  }
}

/*
 * `el.className = ...` —— 也是在设类名，而且是**动态创建**的元素唯一能设类名的途径
 * （`createElement('div')` 没有 `class="..."` 可扫）。
 * 抽取方式与 class 属性一致：先删比较表达式，再取字符串字面量并按空白拆。
 */
const fromClassNameExpr = (src, add) => {
  for (const m of src.matchAll(/\.className\s*=\s*([^\n;]+)/g)) {
    const body = m[1]
      .replace(/[=!]==?\s*(['"])[^'"]*\1/g, ' ')
      .replace(/(['"])[^'"]*\1\s*[=!]==?\s*/g, ' ')
    for (const q of body.matchAll(/['"]([^'"]*)['"]/g)) {
      for (const c of q[1].split(/\s+/)) add(c)
    }
  }
}

const used = new Map()   // className → Set(出现位置)
const addUsed = (where) => (name) => {
  const n = String(name).trim()
  if (!n || n.includes('$') || n.includes('{')) return
  if (!/^[a-zA-Z][\w-]*$/.test(n)) return
  if (!used.has(n)) used.set(n, new Set())
  used.get(n).add(where)
}

for (const rel of SOURCES) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const add = addUsed(rel)
  fromClassAttr(src, add)
  fromClassList(src, add)
  fromClassNameExpr(src, add)
}

// ────────────────────────────────────────────────── 抽出「定义了的 class」

const cssSrc = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')   // 去注释，注释里的例子不算定义

/**
 * 扫出所有规则头里的类选择器。
 *
 * 不用"逐行正则"是因为 CSS 规则头可能跨行、可能带伪类与函数式伪类
 * （`.a:not(.b), .c:hover {`）。这里按 `{` 与 `}` 配平地切出头部，
 * 再在头部里挑 `.xxx` —— 属性选择器里的 `[data-act="x"]` 不会误伤（不匹配 `.` 开头）。
 */
const defined = new Set()
{
  let depth = 0, head = ''
  for (let i = 0; i < cssSrc.length; i++) {
    const ch = cssSrc[i]
    if (ch === '{') {
      if (depth === 0) {
        for (const m of head.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])
      }
      depth++
      head = ''
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
      head = ''
    } else if (depth === 0) {
      head += ch
    }
  }
}

/*
 * 白名单：这些类名在代码里出现，但**故意不给样式**。每一条都要写清为什么 ——
 * 白名单是这种脚本最容易烂掉的地方：只要有人往里塞"暂时过一下"的条目，
 * 这个检查就死了。所以规则是：能给出理由才准进。
 */
/*
 * ★ 2026-09-30：原来的 4 条**已经全部清空**。
 *
 * 清空前它装的是 `.chat-pick` / `.plan-member` / `.plan-role` / `.plan-prompt`，
 * 理由都是"外观由别的类负责，这几个只是 JS 钩子"。那个理由当时站得住，
 * 但白名单的空条目会变成"没人回头看"的垃圾 —— 它让检查器对这几个名字永久闭嘴，
 * 所以这一轮把这四个类该管的事补上了真样式（复选框的勾色、两个下拉的定宽、
 * 指令框的拖拽把手），白名单随之清空。
 *
 * 留着这个 Map（而不是删掉）是为了下一次有真的"故意不设样式"时还有地方放，
 * 但**加之前先问一遍**：它真的不需要样式，还是我一直没给它写？
 */
const ALLOW_UNSTYLED = new Map()

// ────────────────────────────────────────────────── 对照

/*
 * 第二类白名单：**确实被用了，但拼接方式让抽取器看不见**。
 *
 * 和 ALLOW_UNSTYLED 的区别是——那些是"故意不设样式"（不需要在样式表里出现），
 * 这些是"样式表里有、也确实在用，只是静态抽不出来"。
 *
 * ★ 每条必须带 `evidence`：一个在源码里**必须还能搜到**的正则。
 *   搜不到就说明这条白名单已经过期（对应代码被删/改名了）——
 *   那时脚本会把这条当**错误**报出来（见下面），逼着人来删，
 *   而不是让白名单默默烂在那里、越积越像噪音。
 */
const RUNTIME_CLASSES = [
  {
    name: 'run',
    evidence: /run: 'run'/,
    why: "状态后缀：renderCard 的 { run: 'run', … } 映射表注入到 class=\"card ${cls}\"",
  },
]

const allSrc = SOURCES.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n')
const owned = new Set(RUNTIME_CLASSES.map((e) => e.name))
const staleRuntime = RUNTIME_CLASSES.filter((e) => !e.evidence.test(allSrc))

const missing = [...used.keys()]
  .filter((c) => !defined.has(c) && !ALLOW_UNSTYLED.has(c))
  .sort()
const unused = [...defined].filter((c) => !used.has(c) && !owned.has(c)).sort()

console.log('── 样式覆盖检查 ──')
console.log(`  用到的 class：${used.size} 个（来自 ${SOURCES.join(' / ')}）`)
console.log(`  定义的 class：${defined.size} 个（${relative(ROOT, CSS)}）`)

if (missing.length) {
  console.log(`\n  ✗ ${missing.length} 个 class 被用了但样式表里没有定义（元素会裸奔）：`)
  for (const c of missing) console.log(`      .${c}    ← ${[...used.get(c)].join(', ')}`)
} else {
  console.log('  ✓ 用到的 class 全部有样式定义')
}
if (ALLOW_UNSTYLED.size) {
  console.log(`  （白名单 ${ALLOW_UNSTYLED.size} 条，故意不设样式：${[...ALLOW_UNSTYLED.keys()].map((c) => '.' + c).join(' ')}）`)
}

if (RUNTIME_CLASSES.length) {
  console.log(`  （运行时拼出来的 ${RUNTIME_CLASSES.length} 条不计入死样式：${RUNTIME_CLASSES.map((e) => '.' + e.name).join(' ')}）`)
}

if (staleRuntime.length) {
  console.log(`\n  ✗ ${staleRuntime.length} 条「运行时类名」白名单已过期（源码里搜不到它的证据了 → 请删掉这条）：`)
  for (const e of staleRuntime) console.log(`      .${e.name}    ← 证据 ${e.evidence}`)
} else if (!RUNTIME_CLASSES.length) {
  console.log('  ✓ 没有"运行时拼类名"的例外')
}

if (unused.length) {
  console.log(`\n  ! ${unused.length} 个 class 定义了但代码里没人用（死样式，可考虑清掉）：`)
  console.log(`      ${VERBOSE ? unused.join(' ') : unused.slice(0, 40).join(' ') + (unused.length > 40 ? ` …（共 ${unused.length} 个，-v 看全）` : '')}`)
}

if (VERBOSE) {
  console.log(`\n  用到的全部 class（写样式表时照这个清单核）：\n      ${[...used.keys()].sort().join(' ')}`)
}

process.exit(missing.length || staleRuntime.length ? 1 : 0)
