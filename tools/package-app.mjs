#!/usr/bin/env node
/**
 * 把 AgentHub 打包成一个**可双击的便携版**（不需要安装、不需要 electron-builder）。
 *
 * ## 为什么不 electron-builder
 *
 * 本机装了火绒实时防护，npm 系打包工具会去下 nsig/wincodesign 那一堆东西，
 * 动辄几十分钟还会中途报 `os error 5`。而 Electron 的官方发行包**本身就是便携的**：
 * 把 `resources/app` 换成我们的代码、把 exe 改个名就是成品。
 * 所以这里只做四件事：拷贝 → 改名 → 放代码 → 自证。
 *
 * ## 自证到什么程度（每一条都是被坑出来的）
 *
 * | 关卡 | 证明什么 | 抓过什么 |
 * |---|---|---|
 * | 依赖闭包检查 | **该拷的都拷了** | 新加模块忘了进白名单 → 产物一启动就崩 |
 * | 哈希比对 | **拷进去的对不对** | 删除被安全策略拦掉 → 产物里还是上一版代码，而冒烟照样全绿 |
 * | 图标自证 | **exe 里嵌的图标是我们的** | rcedit 静默失败 / 图标文件没拷进产物 —— 一切"正常"，只有用户看得见 |
 * | 产物跑 --smoke | 接线有没有接错 | argv 位置和开发时不同，只有真跑才知道 |
 * | 文件计数 | 有没有残留/多拷 | 套了一层产物（`release/` 自己也被拷进去） |
 *
 * > **哈希只证明"拷进去的对不对"，不证明"该拷的都拷了"。**
 * > 所以闭包检查是单独一道，不能靠哈希替代。
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
/*
 * ★ 图标自证**直接 import，不 spawn 子进程**。
 *   原来是 `spawnSync(node, [verify-exe-icon.mjs, …])`；这个脚本本来就已经
 *   导出了 `verifyExeIcon()`（tests/icon.test.mjs 一直在 import 它）。
 *   走子进程没有任何好处、只多一层"被环境掐掉"的机会：一旦那次 spawn 失败，
 *   关卡会被报成"exe 里的图标不是我们的"——一句彻底的假话，
 *   会让人拿着它去查 .ico 或 rcedit，查半天才发现是子进程根本没起来。
 *   进程内调用没有这一层，而且读的是同一个 Buffer，证据一样硬。
 */
import { verifyExeIcon } from './verify-exe-icon.mjs'
/*
 * ★ 进程内做 **ESM** 语法检查的兜底。
 *   产物里 `package.json` 带 `"type": "module"`，所以 17 个文件里有 16 个是 ESM，
 *   而 `new vm.Script` 只认 CJS 语法（碰到顶层 `import` 直接报错）。
 *   `vm.SourceTextModule` 是对的 API，但它是**条件导出**，没有
 *   `--experimental-vm-modules` 就是 undefined；打包脚本没理由为了
 *   一次语法检查去要求调用方改 node 的启动参数。
 *   `stripTypeScriptTypes` 是 Node 22 起内置的：它本来是剥 TS 类型注解的，
 *   但干活前必须把整份源码**解析一遍**，语法错当场抛（实测 `const a = (1`
 *   → `Expected ',', got '<eof>'`）。TS 语法是 JS 的超集、认 import/export，
 *   拿来当 ESM 的语法检查器够用。代价：stderr 会有一行 ExperimentalWarning。
 */
import { stripTypeScriptTypes } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'node_modules', 'electron', 'dist')
const OUT = join(ROOT, 'release', 'AgentHub')
const APP = join(OUT, 'resources', 'app')

/*
 * ★ 白名单按**目录**给，不按文件列举。
 * 按文件列举时，"新加了一个模块但忘了写进名单"会让产物缺文件，
 * 而缺文件不是"哈希不一致"——循环里根本没有这一项，所有关卡全绿，最后用户点开崩。
 * 按目录给 + 下面的闭包检查，这类问题会变成"构建当场红"。
 */
const APP_DIRS = ['electron', 'ui', 'src']
const APP_FILES = ['package.json']

const log = (s) => console.log(s)
let fail = 0
const bad = (s) => { fail++; console.log(`  ✗ ${s}`) }
const ok = (s) => console.log(`  ✓ ${s}`)

// ────────────────────────────────────────────────── 0. 前置检查

log('── 打包 AgentHub 便携版 ──')

if (!existsSync(join(DIST, 'electron.exe'))) {
  console.error('找不到 node_modules/electron/dist/electron.exe —— 先跑 npm install')
  process.exit(1)
}

// ────────────────────────────────────────────────── 1. 重建输出目录

/*
 * 删除可能被沙箱的"批量删除保护"拦掉（electron dist 有两百多个文件）。
 * 拦掉时**不能直接崩、也不能静默继续** —— 打警告后走"覆盖式重建"，
 * 最后由哈希比对来兜底：如果覆盖没生效，哈希会当场红。
 */
let wiped = true
try { rmSync(OUT, { recursive: true, force: true }) } catch {
  wiped = false
  console.log('  ! 旧产物没能整体删除（可能有文件被占用），改为覆盖式重建 —— 最后用哈希兜底')
}
mkdirSync(APP, { recursive: true })
ok(`输出目录 ${relative(ROOT, OUT)}${wiped ? '（已清空）' : '（覆盖式）'}`)

// ────────────────────────────────────────────────── 2. 拷 Electron 运行时

const distEntries = readdirSync(DIST)
let skippedExe = 0, skippedRes = 0
for (const name of distEntries) {
  if (name === 'electron.exe') { skippedExe++; continue }          // 要改名，单独拷
  if (name === 'resources') { skippedRes++; continue }             // 里面有 default_app.asar，留着可能被 Electron 抢先加载
  cpSync(join(DIST, name), join(OUT, name), { recursive: true, force: true })
}
cpSync(join(DIST, 'electron.exe'), join(OUT, 'AgentHub.exe'), { force: true })
ok(`Electron 运行时已拷贝（跳过 electron.exe×${skippedExe}、resources/×${skippedRes}）`)

// ────────────────────────────────────────────────── 2.5 给 exe 嵌图标与版本信息

/*
 * 官方发行包里的 exe 是 **Electron 自己的图标、Electron 自己的版本信息** ——
 * 不改的话资源管理器里就是一个 Electron 图标，属性面板写着 "Electron"。
 *
 * 用 rcedit（electron 生态在用的那个资源编辑器，MIT）。它**不参与** npm 依赖：
 * 本机装火绒，为一个 150KB 的 exe 去跑 npm install 不划算，而且 electron-winstaller
 * 本来就带了一份，拷进 tools/vendor 之后这个仓库自给自足、离线可打包。
 *
 * ★ 顺序要紧：必须在跑产物冒烟**之前**。rcedit 重写的是 PE 资源节，
 * 万一改坏了 exe，得让后面那道冒烟来发现 —— 而不是等用户双击才发现。
 */
const ICON = join(ROOT, 'ui', 'public', 'agenthub.ico')
const RCEDIT = join(ROOT, 'tools', 'vendor', 'rcedit.exe')
const EXE = join(OUT, 'AgentHub.exe')

function readPkg() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

/**
 * 带重试的同步 spawn。
 *
 * ## ★★ `stdio` 第一项必须是 'ignore' —— 这是被实测纠正过的结论
 *
 * `spawnSync` 默认 `stdio: 'pipe'`，会给 stdin / stdout / stderr **各建一个管道**。
 * 在这个执行环境里，**给 stdin 建管道**会让 spawn 直接以 `EBUSY` 挂掉。
 * 实测四种写法（同一个 `node --version`）：
 *
 * | stdio | 结果 |
 * |---|---|
 * | 默认（三个都 pipe） | `error=EBUSY, status=null` |
 * | `'inherit'` / `'ignore'` | `status=0` |
 * | `['ignore','pipe','pipe']` | `status=0`，**且 stdout 收得回来** |
 *
 * 也就是说 stdout/stderr 走管道没问题，唯独 stdin 不行。
 * 这一条以前是**误判成"杀软占用句柄"**的：报错文案写着"杀软长期占用"，
 * 于是每次打包都去查一个根本不存在的原因。真正要改的是这一行 stdio。
 *
 * ## 为什么还保留重试
 *
 * rcedit 是刚被拷进来的第三方 exe，火绒扫新文件时确实会短暂持有句柄 ——
 * 那一类 EBUSY 是**过一会儿就好**，重试仍然值得。
 * 同步 sleep 用 Atomics.wait（spawnSync 的世界里没有 setTimeout 可用）。
 */
function spawnRetry(cmd, args, { tries = 8, gapMs = 500, ...opts } = {}) {
  let r = null
  for (let i = 0; i < tries; i++) {
    r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    if (r.status !== null || !r.error) return r   // 真跑起来了（成败另说）就不再重试
    /*
     * 递增等待（0.5s → 1s → 1.5s …，共约 18s）。
     * 固定 400ms×4 等不到：这一步要改的是**刚拷出来、200MB 的 AgentHub.exe**，
     * 火绒会先把它整份扫一遍，那期间它一直被占用（Windows 表现为 EBUSY）。
     * 实测 4 次 ×400ms 全失败，而同一台机器上隔一会儿手动跑 rcedit 就成功。
     */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, gapMs * (i + 1))
  }
  return r
}

if (!existsSync(ICON)) {
  bad(`图标不存在：${relative(ROOT, ICON)} —— 先跑 node tools/make-icon.mjs`)
} else if (!existsSync(RCEDIT)) {
  bad(`rcedit 不存在：${relative(ROOT, RCEDIT)}（MIT 许可，可 electron-winstaller 的 vendor 目录里拷一份）`)
} else {
  const pkg = readPkg()
  const semver = `${pkg.version}.0`   // Windows 的文件版本要四段
  const r = spawnRetry(RCEDIT, [
    EXE,
    '--set-icon', ICON,
    '--set-version-string', 'ProductName', 'AgentHub',
    '--set-version-string', 'FileDescription', 'AgentHub —— 多 agent 协同工作台',
    '--set-version-string', 'OriginalFilename', 'AgentHub.exe',
    '--set-version-string', 'LegalCopyright', '',
    '--set-product-version', pkg.version,
    '--set-file-version', semver,
  ], { encoding: 'utf8' })
  const rceditOk = r.status === 0
  if (!rceditOk) {
    const errKind = r.error ? `${r.error.code}（递增重试 8 次、共约 18s 仍失败）` : `status=${r.status}`
    bad(`rcedit 失败：${errKind} ${(r.stderr || r.stdout || '').split('\n')[0]}`)
  } else {
    ok(`图标与版本信息已写入 AgentHub.exe（ProductName/FileDescription/${pkg.version}）`)
  }

  /*
   * ★ 新关卡：**exe 里到底嵌没嵌上**。
   *
   * rcedit 退出码 0 证明不了图标进了 exe，而"图标没嵌上"最坏的表现形式是
   * 你双击出来的东西一切正常、只是图标是 Electron 的 —— 没有关卡会红，
   * 只有用户能看见。所以这里解析 exe 的 PE 资源目录，拿**实际使用的**
   * RT_GROUP_ICON 清单逐字节比对 .ico（见 tools/verify-exe-icon.mjs 文件头）。
   *
   * ★ 进程内调用（不是 spawn 子进程）—— 理由见顶部 import 处那段注释。
   */
  try {
    const v = verifyExeIcon(readFileSync(EXE), readFileSync(ICON), { productName: 'AgentHub' })
    const d = v.details
    if (v.ok) {
      ok(`图标自证：exe 实际使用 ${d.usedCount} 条，逐字节匹配 ${d.matched}/${d.icoCount}（ico 尺寸 ${d.sizes.join('/')}）`)
      ok(`版本自证：产品名 = ${d.productFound}`)
    } else {
      /*
       * ★ 前置 rcedit 没跑成时，这里标一句"不匹配是预期的"。
       *   否则"rcedit 失败 + 图标自证失败"两条红并排，读的人会以为
       *   ico 文件本身有问题，去查一个根本没坏的东西。
       */
      bad(`图标自证未通过 —— exe 里的图标/版本不是我们的${rceditOk ? '' : '（前置的 rcedit 没跑成，这条不匹配是预期的）'}`)
      for (const p of v.problems) console.log(`      ✗ ${p}`)
    }
  } catch (e) {
    // 解析失败（exe 读不了 / PE 结构异常）—— 这也不是"图标不是我们的"，分开报
    bad(`图标自证无法进行：${e.message}`)
  }
}

// ────────────────────────────────────────────────── 3. 拷我们的代码

/** 相对路径 → sha256，用于最后自证 */
const manifest = []
const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 递归列出目录下所有文件（相对 `base`，正斜杠） */
function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, base, acc)
    // 跳过测试：它们在包里没用，只会让产物变大
    else if (!/\.test\.mjs$/.test(e.name)) acc.push(relative(base, full).split(sep).join('/'))
  }
  return acc
}

for (const d of APP_DIRS) {
  const src = join(ROOT, d)
  if (!existsSync(src)) { bad(`白名单里的目录不存在：${d}`); continue }
  cpSync(src, join(APP, d), { recursive: true, force: true })
}
for (const f of APP_FILES) {
  const src = join(ROOT, f)
  if (!existsSync(src)) { bad(`白名单里的文件不存在：${f}`); continue }
  cpSync(src, join(APP, f), { force: true })
}
// .env：本机个人工具，成员密钥通常就写在里面。有就带上，但要明说。
if (existsSync(join(ROOT, '.env'))) {
  cpSync(join(ROOT, '.env'), join(APP, '.env'), { force: true })
  console.log('  ! 已把 .env 一起打进产物 —— 里面有 API 密钥，不要把这个包发给别人')
}
ok('代码已拷入 resources/app')

/*
 * base 必须传 `APP`：walk 默认把路径算成"相对它自己扫的那个目录"，
 * 那样拼出来的 `join(APP, 'main.js')` 是不存在的路径，整份 manifest 会悄悄变成空表 ——
 * 于是"哈希比对通过"和"闭包检查 0 处引用"都是**什么都没查**的假绿。
 */
for (const rel of [...APP_DIRS.flatMap((d) => walk(join(APP, d), APP)), ...APP_FILES]) {
  const abs = join(APP, rel)
  if (existsSync(abs) && statSync(abs).isFile()) manifest.push({ file: rel, sha256: hashOf(abs) })
}

/*
 * ★ 防假绿：manifest 太小说明**上面那个循环根本没匹配上任何文件** ——
 * 那样"哈希比对通过"和"闭包检查 0 处引用"就都是什么都没查的假绿。
 * （这个坑我刚踩过：walk 返回的是相对子目录的路径，拼出来的路径全不存在。）
 * 能被"空集合"满足的检查等于没写，所以这里必须自己卡一个下界。
 */
if (manifest.length < 10) {
  bad(`manifest 只有 ${manifest.length} 个文件 —— 显然没匹配上，后面的检查都是假绿`)
} else {
  ok(`manifest：${manifest.length} 个代码文件`)
}

// ────────────────────────────────────────────────── 4. 依赖闭包检查

/*
 * ★ 哈希证明不了"该拷的都拷了"。这里把相对引用抽出来，逐个确认目标在包里。
 *
 * 只读 .js/.mjs —— 图片等二进制按 utf-8 读会直接抛。
 * 三类规则各自能抓到不同的漏项（都实测过）：
 *   import/require  → 漏掉一个模块
 *   path.join(__dirname, ...) → 漏掉一个模板/静态页
 *   路径字面量      → 漏掉一张图/一个 css
 */
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g
const DIRNAME_JOIN_RE = /join\(\s*__dirname\s*,\s*['"]([^'"]+)['"]/g
const LITERAL_RE = /['"](\.[^'"]*\.(?:js|mjs|html|css|json|png|ico|svg))['"]/g

const codeFiles = manifest.map((m) => m.file).filter((f) => /\.(js|mjs)$/.test(f))

/**
 * 这个相对引用在产物里存在吗？
 *
 * ⚠️ **必须按文件系统真实判断，不能只查"在不在 manifest 里"**：
 * `join(__dirname, 'public')` 指向的是一个**目录**（静态资源目录），
 * `join(__dirname, '..')` 指向的是上一级 —— 两者都不会出现在文件清单里，
 * 只认文件清单会把它们全报成"缺失"，而这个检查一旦开始误报，就会被当成噪音忽略掉。
 */
function existsInPkg(relFile, spec) {
  const p = join(APP, dirname(relFile), spec)
  if (existsSync(p)) return true
  for (const c of ['.js', '.mjs', '.json', '/index.js']) if (existsSync(p + c)) return true
  return false
}

let refChecked = 0
const missing = []
for (const f of codeFiles) {
  let src
  try { src = readFileSync(join(APP, f), 'utf8') } catch { continue }
  const scan = (re) => {
    for (const m of src.matchAll(re)) {
      refChecked++
      if (!existsInPkg(f, m[1])) missing.push(`${f} → ${m[1]}`)
    }
  }
  scan(IMPORT_RE)
  scan(DIRNAME_JOIN_RE)
  scan(LITERAL_RE)
}
if (missing.length) {
  bad(`依赖闭包检查：${missing.length} 个被引用的文件不在产物里`)
  for (const m of missing.slice(0, 10)) console.log(`      ${m}`)
} else {
  ok(`依赖闭包检查：${refChecked} 处引用，全部能在产物里找到`)
}

// ────────────────────────────────────────────────── 5. 产物自证

for (const m of manifest) {
  const h = hashOf(join(APP, m.file))
  if (h !== m.sha256) bad(`哈希不一致：${m.file}`)
}
if (!missing.length) ok(`哈希比对：${manifest.length} 个代码文件逐一核对通过`)

/*
 * 语法检查（比"文件在不在"强，比"能跑起来"便宜）。
 *
 * ★ 必须把两种失败分开，否则会给出**假诊断**：
 *   - `r.error` 非空 = `node --check` 这个子进程压根没起来；
 *   - `r.status !== 0` = 真的跑了，报语法错。
 * 第一版把两者都塞进"语法检查失败 N 个"，而 spawn 失败时 stderr 是空的 ——
 * 于是输出是 17 行 `electron/main.js: `（冒号后面什么都没有）。
 * 那不是"17 个文件有语法错"，是"这个检查没跑成"。照着它去改代码只会白改。
 *
 * （顺带：当初让 `r.error` 必然出现的原因，是 spawnSync 的 stdin 管道 ——
 *  见 spawnRetry 的注释。修掉那个之后这条 spawn 正常跑；下面的进程内
 *  兜底留着当二次保险，换一个环境（别人的机器、CI）仍可能用上。）
 *
 * ★ 而且"没跑成"不该是终点：spawn 起不来时退回**进程内编译**。
 *   `node --check` 干的事就是"解析一遍"，`new vm.Script` 在同一个进程里
 *   干的是同一件事，只是不经过 argv[0]。CJS 完全等价；
 *   ESM（.mjs / 含顶层 import|export）优先 `vm.SourceTextModule`，
 *   没有 flag 就退到 Node 内置的 `stripTypeScriptTypes`（见顶部 import 注释），
 *   两条路都够不着才如实报"这几个没验"，不假装通过 ——
 *   最多让**这一种**文件降级，而不是让整道关卡消失。
 */
function checkSyntaxInProcess(src, filename) {
  const isEsm = filename.endsWith('.mjs') || /^\s*(?:import|export)[\s{*]/m.test(src)
  try {
    if (isEsm) {
      if (typeof vm.SourceTextModule === 'function') {
        new vm.SourceTextModule(src, { identifier: filename })   // 只构造，不 link / 不执行
        return { ok: true, how: 'vm' }
      }
      if (typeof stripTypeScriptTypes === 'function') {
        stripTypeScriptTypes(src, { mode: 'strip' })             // 只取"能不能解析"，不要返回值
        return { ok: true, how: 'strip' }
      }
      return { ok: false, skip: 'ESM：既没有 --experimental-vm-modules，本机 Node 也没有 stripTypeScriptTypes' }
    }
    new vm.Script(src, { filename })
    return { ok: true, how: 'vm' }
  } catch (e) {
    return { ok: false, msg: String(e.message || e).split('\n')[0] }
  }
}

const syntaxFail = []
const spawnBlocked = []
const inProcOk = []
const inProcSkip = []
for (const f of codeFiles) {
  const r = spawnSync(process.execPath, ['--check', join(APP, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!r.error) {
    // 真跑起来了：成就是成，败就是败
    if (r.status !== 0) syntaxFail.push(`${f}: ${(r.stderr || '').split('\n')[0]}`)
    continue
  }
  // spawn 被环境拦了 —— 退回进程内编译（比直接放弃强，且结论一样硬）
  spawnBlocked.push(`${f}: ${r.error.code}`)
  const c = checkSyntaxInProcess(readFileSync(join(APP, f), 'utf8'), f)
  if (c.ok) inProcOk.push(c.how)
  else if (c.skip) inProcSkip.push(`${f}（${c.skip}）`)
  else syntaxFail.push(`${f}: ${c.msg}`)
}
if (syntaxFail.length) {
  bad(`语法检查失败 ${syntaxFail.length} 个`)
  syntaxFail.slice(0, 5).forEach((s) => console.log(`      ${s}`))
} else if (inProcSkip.length) {
  /*
   * ★ 这里**不能说"全部通过"** —— 有文件真的没被解析过。
   *   （第一版就是这样：上一行说"17 个全部通过"、下一行说"16 个没能验证"，
   *   两句话同时出现，读的人不知道该信哪句。）
   */
  bad(`语法检查：${codeFiles.length - inProcSkip.length}/${codeFiles.length} 个已确认通过，${inProcSkip.length} 个没验证`)
  inProcSkip.slice(0, 3).forEach((s) => console.log(`      ${s}`))
} else if (spawnBlocked.length) {
  const nVm = inProcOk.filter((h) => h === 'vm').length
  const nStrip = inProcOk.filter((h) => h === 'strip').length
  ok(`语法检查：${codeFiles.length} 个 JS 文件全部通过`)
  console.log(`      —— spawn 起不来（${spawnBlocked.length} 个，${spawnBlocked[0].split(': ')[1]}），改用进程内编译验证：vm.Script ${nVm} 个 + 内置 ESM 解析器 ${nStrip} 个`)
} else {
  ok(`语法检查：${codeFiles.length} 个 JS 文件全部通过`)
}

const total = walk(OUT).length
ok(`产物文件总数：${total}`)

log(`\n产物：${OUT}`)
log(`入口：${join(OUT, 'AgentHub.exe')}`)

// ────────────────────────────────────────────────── 6. 用产物自己跑一遍冒烟

/*
 * ★ 这是"打包有没有接错线"最硬的证据。
 * 打包后 `process.defaultApp === undefined`，argv 的位置和开发时**不一样** ——
 * 只有真跑才知道。旧代码本身是好的，所以"用过期产物跑冒烟"也会全绿；
 * 因此前面几道关卡不能省，这里只是最后一道。
 */
if (!process.argv.includes('--no-smoke')) {
  log('\n── 用产物自己跑一遍冒烟 ──')
  /*
   * `stdio: 'inherit'` 而不是抓 stdout：
   * 抓的时候冒烟的输出（那一大行 JSON + 逐行日志）会被缓冲区接管，
   * 实测出现过子进程被信号掐掉、`status` 是 null、stdout 空 —— 而且报不出原因。
   * 直接继承流就没有这回事，还能看到实时输出。
   */
  const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'electron-smoke.mjs'), '--exe', join(OUT, 'AgentHub.exe')], {
    stdio: 'inherit', cwd: ROOT, env: { ...process.env },
  })
  if (r.status !== 0) bad(`产物冒烟未通过（status=${r.status}${r.error ? ' error=' + r.error.message : ''}）`)
  else ok('产物冒烟通过 —— 便携版自己能起来、能截图')
}

log(`\n${fail === 0 ? '打包成功' : `打包有问题：${fail} 项`}`)
process.exit(fail === 0 ? 0 : 1)
