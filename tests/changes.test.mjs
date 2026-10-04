/**
 * changes.js 单元测试 —— 文件改动采集
 *
 * 运行：node --test tests/changes.test.mjs
 *
 * 这个模块的产物**直接用来给成员定罪**（claimed-edit-no-change），
 * 所以测试的重点不是"能不能采到"，而是 **"采不到的时候会不会假装采到了"**。
 * 后者才是危险的：把"没看完"报成"零改动"，会让一条本来正确的规则开始误报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { snapshotTree, diffSnapshots, collectChanges } from '../src/engine/changes.js'

/** 造一个临时工作目录；Windows 的 tmpdir 可能是 8.3 短名，realpath 一下保证相对路径干净 */
const mkTmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'agenthub-chg-')))

const made = []
const newTmp = () => {
  const d = mkTmp()
  made.push(d)
  return d
}

test.after(() => {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  }
})

const write = (root, relPath, content = 'x') => {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

// ------------------------------------------------------------ 基本快照

test('snapshotTree：列出文件，路径用相对路径 + 正斜杠', () => {
  const root = newTmp()
  write(root, 'a.txt', 'aaa')
  write(root, 'sub/deep/b.txt', 'bbb')

  const snap = snapshotTree(root)
  assert.equal(snap.truncated, false)
  assert.ok(snap.files.has('a.txt'))
  assert.ok(snap.files.has('sub/deep/b.txt'), 'Windows 上也必须是正斜杠，否则两个平台对不上')
})

test('snapshotTree：忽略 node_modules / venv / .git / __pycache__', () => {
  const root = newTmp()
  write(root, 'src/keep.js')
  write(root, 'node_modules/pkg/index.js')
  write(root, '.git/HEAD')
  write(root, '__pycache__/x.pyc')
  write(root, 'tools/trae-venv312/lib/foo.py')   // ← 本仓库真实存在的形态，笔数 8498
  write(root, '.venv/lib/foo.py')

  const snap = snapshotTree(root)
  assert.ok(snap.files.has('src/keep.js'))
  for (const p of ['node_modules/pkg/index.js', '.git/HEAD', 'tools/trae-venv312/lib/foo.py', '.venv/lib/foo.py']) {
    assert.equal(snap.files.has(p), false, `${p} 不该被计入改动面`)
  }
})

test('snapshotTree：忽略 .log / .pyc 这类生成物', () => {
  const root = newTmp()
  write(root, 'app.log')
  write(root, 'mod.pyc')
  write(root, 'real.js')

  const snap = snapshotTree(root)
  assert.ok(snap.files.has('real.js'))
  assert.equal(snap.files.has('app.log'), false)
  assert.equal(snap.files.has('mod.pyc'), false)
})

// ------------------------------------------------------------ ★ 采不全必须自曝

test('★ snapshotTree：文件数超上限 → truncated，不能当"只有这些文件"', () => {
  const root = newTmp()
  for (let i = 0; i < 8; i++) write(root, `f${i}.txt`)

  const snap = snapshotTree(root, { maxFiles: 3 })
  assert.equal(snap.truncated, true)
  assert.match(snap.reason, /上限/)
})

test('★ snapshotTree：目录根本不存在 → truncated（不是"空目录"）', () => {
  // 「目录读不到」和「目录是空的」差别巨大：前者我们什么都没看，后者我们看全了
  const snap = snapshotTree(join(tmpdir(), 'agenthub-绝对不存在的目录-' + Date.now()))
  assert.equal(snap.truncated, true)
  assert.match(snap.reason, /不可读/)
  assert.equal(snap.files.size, 0)
})

test('snapshotTree：预算已耗尽时立即自曝，不硬撑', () => {
  /*
   * 用负数而不是 0：`Date.now()` 只有 1ms 精度，maxMs=0 时
   * `Date.now() > deadline` 在同一毫秒内仍是假，会溜过去。
   * 负数才真正落在"预算已用完"的分支上 —— 测的是真代码路径，不是退化值。
   */
  const root = newTmp()
  write(root, 'a.txt')
  const snap = snapshotTree(root, { maxMs: -1 })
  assert.equal(snap.truncated, true)
  assert.match(snap.reason, /时间预算/)
})

// ------------------------------------------------------------ diff

test('diffSnapshots：新增 / 内容变化 / 删除 都能识别', () => {
  const root = newTmp()
  write(root, 'keep.txt', 'same')
  write(root, 'edit.txt', 'before')
  write(root, 'gone.txt', 'bye')

  const before = snapshotTree(root)

  write(root, 'edit.txt', 'after-changed!')
  write(root, 'new.txt', 'hi')
  rmSync(join(root, 'gone.txt'))

  const after = snapshotTree(root)
  const changed = diffSnapshots(before, after)

  assert.deepEqual(changed, ['edit.txt', 'gone.txt', 'new.txt'])
})

test('diffSnapshots：毫无改动时返回空数组', () => {
  const root = newTmp()
  write(root, 'a.txt')
  const before = snapshotTree(root)
  const after = snapshotTree(root)
  assert.deepEqual(diffSnapshots(before, after), [])
})

test('diffSnapshots：同尺寸覆盖写靠时间戳识别 —— size 一样时，签名得看 mtime/ctime', () => {
  const root = newTmp()
  const full = write(root, 'same-size.txt', 'AAAA')
  const before = snapshotTree(root)

  write(root, 'same-size.txt', 'BBBB')  // 长度一模一样

  /*
   * 不能指望"刚写完时间戳就一定变"：Windows 会把同一个时间片里的多次写入合并成
   * 一个时间戳（实测 30 次里 18 次 mtime / ctime 一个都没动，见 src/engine/changes.js
   * 文件头那段边界说明）。所以这里**显式**把时间戳推后 —— 要测的是"签名里确实带了
   * 时间戳、不是只看 size"这件事本身，而不是碰运气等系统赏一个新时间戳。
   */
  const later = new Date(Date.now() + 5000)
  utimesSync(full, later, later)

  const after = snapshotTree(root)
  assert.deepEqual(diffSnapshots(before, after), ['same-size.txt'])
})

// ------------------------------------------------------------ ★★ collectChanges：宁可说不知道

test('★★ collectChanges：任一快照 truncated → null，绝不返回 []', () => {
  /*
   * 这是整个模块最重要的一条断言。
   *
   * 返回 `[]` 是宣称"我完整看过磁盘了，一个文件都没变"；
   * 而事实是"我没看完"。判定层对这两者的反应**正好相反**：
   *   null → 不判（拿没数据去定罪就是误报）
   *   []   → 判（写档下声称改了却零改动）
   * 一旦退化，这条规则立刻变成恒定误报。
   */
  const root = newTmp()
  write(root, 'a.txt')
  const ok = snapshotTree(root)
  const bad = snapshotTree(root, { maxFiles: 0 })

  assert.equal(collectChanges(ok, bad), null, '跑后采不全 → 未采集')
  assert.equal(collectChanges(bad, ok), null, '跑前采不全 → 未采集')
})

test('★ collectChanges：before/after 缺失 → null', () => {
  const root = newTmp()
  write(root, 'a.txt')
  const ok = snapshotTree(root)
  assert.equal(collectChanges(null, ok), null)
  assert.equal(collectChanges(ok, null), null)
  assert.equal(collectChanges(null, null), null)
})

test('★★ collectChanges：完整采集且确实零改动 → []（这才是能定罪的那个值）', () => {
  const root = newTmp()
  write(root, 'a.txt')
  const before = snapshotTree(root)
  const after = snapshotTree(root)
  assert.deepEqual(collectChanges(before, after), [])
})

// ------------------------------------------------------------ 真实场景：跑一次任务

test('★★ 端到端：拍快照 → 成员写了文件 → 能采出来（这就是规则的数据来源）', () => {
  const root = newTmp()
  write(root, 'src/existing.js', 'old')

  // 跑之前
  const before = snapshotTree(root)

  // 成员干活：新增一个测试文件、改掉一个已有文件（模拟 claude 写测试）
  write(root, 'tests/new.test.mjs', 'assert...')
  write(root, 'src/existing.js', 'old + patched')

  const changed = collectChanges(before, snapshotTree(root))
  assert.deepEqual(changed, ['src/existing.js', 'tests/new.test.mjs'])
  assert.ok(changed.length > 0, '这就是 claimed-edit-no-change 用来判"确实改了"的证据')
})

test('★★ 端到端：成员光说不动 → 采到 []（规则才会判可疑）', () => {
  const root = newTmp()
  write(root, 'src/existing.js', 'old')

  const before = snapshotTree(root)
  // 成员什么也没写，只在产出里声称"测试文件已写好"
  const changed = collectChanges(before, snapshotTree(root))

  assert.deepEqual(changed, [])
  assert.equal(Array.isArray(changed), true, '必须是数组（=确实采集过），规则才敢用它定罪')
})
