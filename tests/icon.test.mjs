/**
 * 图标链路测试：生成器 → .ico → rcedit 嵌入 exe → 校验器。
 *
 * ## 这条链每一环都在防什么
 *
 *  - 生成器**可复现**：校验器做的是逐字节比较，生成只要有一点不确定，
 *    "重新生成"就会让已嵌进 exe 的图标比对失败 —— 所以可复现必须钉死。
 *  - 校验器**对 electron.exe 的阳性对照**：解析器最危险的失败是安静地返回空集
 *    （见 tools/verify-exe-icon.mjs 文件头）。electron.exe 一定有它自己的图标资源，
 *    断言 group/rt_icon 都非空，才能证明"解析器真的在解析"，而不是空集碰巧让检查变绿。
 *  - **rcedit 真跑一遍**：这是打包流程的核心步骤，在测试里对 electron.exe 的副本
 *    做同样的事，验证"嵌入 → 校验通过"整条链 —— 不依赖"上次打包时碰巧通过"。
 *
 * 零网络、零 API 费用；最重的一步是拷一份 electron.exe（约 170MB）到临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { SIZES, drawIcon, encodePng, buildIco } from '../tools/make-icon.mjs'
import { parseIco, verifyExeIcon } from '../tools/verify-exe-icon.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICO = join(ROOT, 'ui', 'public', 'agenthub.ico')
const RCEDIT = join(ROOT, 'tools', 'vendor', 'rcedit.exe')
const ELECTRON_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

test('ico 产物存在且结构正确（6 个尺寸、PNG 条目、字节数对得上）', () => {
  assert.ok(existsSync(ICO), `图标不存在：${ICO} —— 先跑 node tools/make-icon.mjs`)
  const entries = parseIco(readFileSync(ICO))
  assert.equal(entries.length, SIZES.length)
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 0; i < entries.length; i++) {
    assert.equal(entries[i].width, SIZES[i], `第 ${i} 个条目宽度应为 ${SIZES[i]}`)
    assert.equal(entries[i].height, SIZES[i])
    assert.equal(entries[i].data.length, entries[i].bytes, '目录声明的字节数与实际数据不一致')
    assert.ok(entries[i].data.subarray(0, 8).equals(PNG_SIG), `${SIZES[i]}px 条目不是 PNG（Vista+ 的 ico 应内嵌 PNG）`)
  }
})

test('256px 里必须真的有图形（不能是一张空白/纯色图）', () => {
  // 反假绿：哪怕 ico 结构全对，"图形画歪了变成一整块"也该被抓住。
  //
  // 这版图标是"深色底 + 发光线"，所以判法不是数白像素（线条和节点只有中心
  // 一点点白，还掺着霓虹色），而是数**亮像素**：底色三通道之和不到 100，
  // 外框与符号都在 400 以上，中间没有过渡带，阈值取哪都分得开。
  const entries = parseIco(readFileSync(ICO))
  const big = entries.find((e) => e.width === 256)
  const png = big.data
  // 手头有 drawIcon，直接重新生成同尺寸的像素来算占比，不解析 PNG
  const rgba = drawIcon(256)
  let lit = 0
  let opaque = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue
    opaque++
    if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 360) lit++
  }
  const total = rgba.length / 4
  const litRatio = lit / total
  const opaqueRatio = opaque / total
  // 实测（256px）：亮 0.26、不透明 0.53。两侧都留足余量 ——
  // 图形没画出来 → 亮占比 0；糊成一块纯霓虹 → 亮占比 ≈ 0.53 撞上限；
  // 六边形被画满整张画布 → 不透明占比 ≈ 1。
  assert.ok(litRatio > 0.05 && litRatio < 0.45,
    `亮像素占比 ${litRatio.toFixed(4)} 不在 (0.05, 0.45) —— 图形要么没画出来，要么糊满了整张图`)
  assert.ok(opaqueRatio > 0.30 && opaqueRatio < 0.75,
    `不透明占比 ${opaqueRatio.toFixed(4)} 不在 (0.30, 0.75) —— 六边形轮廓的尺寸不对劲`)
  assert.ok(png.length > 1000, 'PNG 数据异常地小')
})

test('生成器可复现：同一尺寸两次绘制逐字节相同', () => {
  // 逐字节校验的前提。任何随机/时间戳混进来，这条就会红。
  const a = encodePng(drawIcon(64), 64, 64)
  const b = encodePng(drawIcon(64), 64, 64)
  assert.ok(a.equals(b), '同一尺寸两次生成结果不一致 —— 校验器的逐字节比较会因此假红')
})

test('校验器阳性对照：electron.exe 里能解析出它自己的图标资源', () => {
  // 这条不是在验"electron 的图标是我们的"（当然不是），
  // 而是验**解析器没有装死**：资源树解析失败时最可能的形态是"安静地返回空集"，
  // 那"我们的图标不在里面"就永远为真 —— 检查全绿但什么都没查。
  assert.ok(existsSync(ELECTRON_EXE), 'electron 未安装（node_modules/electron/dist 不存在）')
  const r = verifyExeIcon(readFileSync(ELECTRON_EXE), readFileSync(ICO))
  assert.equal(r.ok, false, 'electron.exe 的图标不该被认成我们的')
  assert.ok(r.details.groupCount >= 1, '没解析到 RT_GROUP_ICON —— 解析器可能返回了空集')
  assert.ok(r.details.rtIconCount >= 1, '没解析到 RT_ICON —— 解析器可能返回了空集')
  assert.equal(r.details.matched, 0)
})

test('校验器识别版本资源：electron.exe 的产品名不是 AgentHub', () => {
  const r = verifyExeIcon(readFileSync(ELECTRON_EXE), readFileSync(ICO), { productName: 'AgentHub' })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('AgentHub') && p.includes('产品名')),
    '应当在版本资源上报出产品名不符')
})

test('rcedit 真跑一遍：嵌入后校验器全绿（图标 6/6 + 产品名）', { timeout: 60000 }, (t) => {
  assert.ok(existsSync(RCEDIT), `rcedit 不存在：${RCEDIT}`)

  /*
   * EBUSY 就重试：杀软扫描新拷的 exe 时会短暂持有句柄（真机上也一样）。
   *
   * ★ `stdio` 第一项必须是 'ignore'：默认的 'pipe' 会给 stdin 建管道，
   *   而这个执行环境里"给 stdin 建管道"会让 spawnSync 直接 EBUSY
   *   （实测：默认 pipe → EBUSY；['ignore','pipe','pipe'] → status=0，且输出收得回来）。
   *   以前把这归给"沙箱不让 spawn 子进程"，于是这条测试在沙箱里永远是 skip ——
   *   其实只是 stdio 少写了一个字段，补上就能真跑。
   *
   * 真重试到底还不行，才显式 skip 并说明原因；绝不静默算绿，
   * 也不让环境问题把整个套件染红。
   */
  const spawnRcedit = (args) => {
    let r = null
    for (let i = 0; i < 4; i++) {
      r = spawnSync(RCEDIT, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.status !== null || !r.error) return r
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
    return r
  }

  const tmp = mkdtempSync(join(ROOT, '.tmp-icon-test-'))
  try {
    const exe = join(tmp, 'Test.exe')
    cpSync(ELECTRON_EXE, exe)
    const r1 = spawnRcedit([exe, '--set-icon', ICO,
      '--set-version-string', 'ProductName', 'AgentHub',
      '--set-file-version', '0.1.0.0'])
    if (r1.error && r1.error.code === 'EBUSY') {
      t.skip('spawn rcedit 起不来（EBUSY 重试后仍失败）—— 换台机器/换环境重跑本文件可获得此覆盖')
      return
    }
    assert.equal(r1.status, 0, `rcedit 失败：${r1.stderr || r1.stdout}`)
    const r2 = verifyExeIcon(readFileSync(exe), readFileSync(ICO), { productName: 'AgentHub' })
    assert.equal(r2.ok, true, '嵌入后校验应当全绿：' + r2.problems.join('；'))
    assert.equal(r2.details.matched, r2.details.icoCount)
    assert.equal(r2.details.productFound, 'AgentHub')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('坏输入必须红：垃圾文件让 ico/PE 解析器直接抛错', () => {
  const garbage = Buffer.from('this is not an ico nor a pe file')
  assert.throws(() => parseIco(garbage))
  assert.throws(() => verifyExeIcon(garbage, readFileSync(ICO)))
  // 一个"不是 PE"但足够长的文件（比如文本），也不能被当成解析成功
  const text = Buffer.alloc(4096, 0x41)
  assert.throws(() => verifyExeIcon(text, readFileSync(ICO)))
})
