/**
 * exec.js 单元测试 —— 子进程执行层的输出处理
 *
 * 运行：node --test tests/exec.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanStderr, elide, buildCommandLine, execMember } from '../src/adapters/exec.js'

// ------------------------------------------------------------ elide：截断必须保留头尾
//
// 这一组来自真跑协同任务的一次失败：trae 挂掉时产出是一段 Python traceback，
// 关键信息（异常类型、最后一行）在**末尾**，而原代码是 slice(0, 500) 只留开头，
// 结果只剩一串 `File "<frozen runpy>", line 198` —— 完全无法定位原因。

test('elide：短于上限时原样返回', () => {
  assert.equal(elide('abc', 10), 'abc')
  assert.equal(elide('', 10), '')
})

test('elide：刚好等于上限时也不动它', () => {
  const s = 'x'.repeat(500)
  assert.equal(elide(s, 500), s)
})

test('elide：超长时同时保留开头和结尾', () => {
  const s = 'A'.repeat(300) + 'B'.repeat(400) + 'C'.repeat(300) // 1000 字符
  const out = elide(s, 500)
  assert.ok(out.startsWith('A'), '要保留开头')
  assert.ok(out.endsWith('C'), '★ 尾部必须保留 —— traceback 的异常类型在末尾')
  assert.match(out, /省略/)
})

test('elide：★ Python traceback 的最后一行不会丢', () => {
  // 这正是实测里被切掉的那一行
  const lines = []
  for (let i = 0; i < 40; i++) lines.push(`  File "<frozen runpy>", line ${i}, in _run_code`)
  lines.push('ValueError: DOUBAO_API_KEY is not set, provider=doubao')
  const tb = lines.join('\n')
  assert.ok(tb.length > 500)

  const out = elide(tb, 500)
  assert.match(out, /ValueError: DOUBAO_API_KEY is not set/, '异常类型与消息必须在，否则等于没报错')
})

test('elide：结果长度不会超过上限太多（省略标记的开销要可控）', () => {
  const out = elide('z'.repeat(10000), 500)
  assert.ok(out.length < 500 + 40, `实际 ${out.length}`)
})

test('elide：null / undefined 不炸', () => {
  assert.equal(elide(null, 10), '')
  assert.equal(elide(undefined, 10), '')
})

test('elide：非字符串输入转成字符串', () => {
  assert.equal(elide(12345, 10), '12345')
})

// ------------------------------------------------------------ cleanStderr：滤掉沙箱噪音

test('cleanStderr：滤掉 reg.exe / Program Blacklist 这类本机安全策略噪音', () => {
  const s = [
    'PROGRAM BLOCKED BY SECURITY POLICY - The sandbox prevented a program on the configured Program Blacklist from starting: reg.exe',
    'ValueError: 真正的错误在这行',
  ].join('\n')
  const out = cleanStderr(s)
  assert.equal(out.includes('reg.exe'), false)
  assert.match(out, /真正的错误/)
})

test('cleanStderr：正常内容原样保留（含首尾空白修剪）', () => {
  assert.equal(cleanStderr('  hello\nworld  '), 'hello\nworld')
})

test('cleanStderr：空输入返回空串', () => {
  assert.equal(cleanStderr(''), '')
  assert.equal(cleanStderr(undefined), '')
})

// ------------------------------------------------------------ buildCommandLine

test('buildCommandLine：Windows 上要前置 chcp 65001（否则中文输出乱码）', () => {
  const line = buildCommandLine('node', ['a.js'])
  if (process.platform === 'win32') assert.match(line, /^chcp 65001 >nul &/)
  assert.match(line, /node/)
})

test('buildCommandLine：带空格的参数要加引号', () => {
  const line = buildCommandLine('cmd', ['--add-dir', 'D:/my dir'])
  assert.match(line, /"D:\/my dir"/)
})

test('buildCommandLine：不含空格的参数不加多余引号', () => {
  const line = buildCommandLine('cmd', ['--version'])
  assert.match(line, /--version$/)
})

// ------------------------------------------------------------ stopWhen：答完即收工
//
// 这一组对着一个真实痛点：实测 codex 答完一轮之后，进程还要再挂约 10 秒才自己退出，
// 而成员调用是串在用户等待路径上的 —— 那 10 秒是用户实打实等掉的。
// 收工必须按**进程树**（shell:true 起的 child 是 cmd.exe，kill 它带不走真正的 CLI）。
//
// 这里用 node 自己当"成员"：零成本、行为可控，不用真去跑一次 codex。

test('★ stopWhen：命中即收工，不干等进程自己退出', async () => {
  const t0 = Date.now()
  const r = await execMember(process.execPath, ['-e', "console.log('READY');setTimeout(()=>{}, 60000)"], {
    timeoutMs: 30000,
    stopWhen: (line) => line.trim() === 'READY',
  })
  const ms = Date.now() - t0
  assert.equal(r.stoppedEarly, true, '必须报出"是我们主动收的工"')
  assert.ok(ms < 15000, '不该等它自己退出（那要 60s），实际 ' + ms + 'ms')
  assert.match(r.stdout, /READY/)
})

test('★★ stopWhen：按进程树收工，不留孤儿进程', async () => {
  const r = await execMember(process.execPath, ['-e', "console.log('PID=' + process.pid);setTimeout(()=>{}, 60000)"], {
    timeoutMs: 30000,
    stopWhen: (line) => line.includes('PID='),
  })
  assert.equal(r.stoppedEarly, true)

  const pid = Number((r.stdout.match(/PID=(\d+)/) || [])[1])
  assert.ok(pid > 0, '拿不到子进程 pid，样本没跑起来：' + r.stdout)

  await new Promise((res) => setTimeout(res, 500))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, '★ 子进程必须跟着 cmd.exe 一起被收掉，否则会一直挂在后台')
})

test('★ stopWhen 只吃整行：同一行被分批写出来时必须拼齐后再判', async () => {
  // 半行判定 = 判定函数永远解析失败 = 优化安静地不生效，是最难发现的那种坏
  const seen = []
  const script = "process.stdout.write('AB');" +
    "setTimeout(() => { console.log('C'); setTimeout(()=>{}, 60000) }, 150)"
  const r = await execMember(process.execPath, ['-e', script], {
    timeoutMs: 30000,
    stopWhen: (line) => { seen.push(line); return line.trim() === 'ABC' },
  })
  assert.equal(r.stoppedEarly, true, '拼齐成 ABC 之后才该命中')
  assert.deepEqual(seen, ['ABC'])
})

test('没配 stopWhen 时行为不变：跑完整、stoppedEarly 为 false', async () => {
  const r = await execMember(process.execPath, ['-e', "console.log('A');console.log('B')"], { timeoutMs: 30000 })
  assert.equal(r.exitCode, 0)
  assert.equal(r.stoppedEarly, false)
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['A', 'B'])
})
