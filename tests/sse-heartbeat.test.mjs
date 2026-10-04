/**
 * SSE 心跳：任务跑动期间通道不许静默。
 *
 * 运行：node --test tests/sse-heartbeat.test.mjs
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么这个文件值得存在：
 *
 * 成员调用一次动辄几十秒（有的成员默认超时 10 分钟），这段期间 SSE 通道上
 * **一个字节都没有**。通道被中途掐掉的失败方式是最坏的一种：
 * 连接没了，任务其实还在服务端跑，界面停在半路 —— 用户要么以为跑完了、
 * 要么以为卡死了，两种判断都是错的。
 *
 * 修法是在通道上定期写一条 **SSE 注释行**（':' 开头）。协议规定客户端必须忽略它，
 * 所以它顶得住空闲超时，又不可能混进事件里。
 *
 * 这个测试钉的就是后半句 —— "不可能混进事件里" 不能靠读代码保证：
 * 把心跳压到 3ms，真跑一次，然后**逐行看原始响应**。
 *
 * ── 两个刻意的设计 ──
 *
 * 1. **用假成员，不用真成员。** 真成员要么花钱（claude/codex），
 *    要么依赖本机装没装（trae/dsh）—— 一个会被"环境变了"影响的断言，
 *    迟早变成假绿或假红。所以这里通过 AGENTHUB_MEMBERS 指到一份临时配置，
 *    里面只有一个"睡 1.2 秒再回一句 ok"的假成员：零成本、时序可控。
 * 2. **同时断言"窗口真的存在"。** 如果假成员哪次瞬间就挂了，
 *    心跳断言会因为"没机会触发"而失败 —— 但也可能是间歇性的。
 *    所以这里还要求整个运行确实花了 ≥1 秒：
 *    窗口不存在时，报的是"这次压根没跑够久"，而不是含糊的"没看到心跳"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 让内核挑一个空闲端口 —— 别去撞 8787 上可能正开着的那个实例 */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

test('SSE 通道有心跳，且心跳不打断正常事件', async (t) => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-sse-'))

  // 假成员配置：命令行就是本机的 node，跑一段"睡 1.2 秒再输出 ok"的脚本。
  // promptMode=stdin —— 指令写进它的 stdin，它不读，照样按自己的节奏退出。
  const membersPath = join(dir, 'members.json')
  writeFileSync(membersPath, JSON.stringify({
    _comment: 'SSE 心跳测试用的假成员配置：不碰真配置，也不花任何钱',
    orchestrator: { id: 'workbuddy', name: 'WorkBuddy', note: '测试占位' },
    members: [{
      id: 'slowpoke',
      name: '慢速假成员',
      adapter: 'generic',
      billing: 'tokens',
      enabled: true,
      command: process.execPath,
      promptMode: 'stdin',
      argsTemplate: ['-e', "setTimeout(() => { process.stdout.write('ok') }, 1200)"],
      probeArgs: ['-e', "process.stdout.write('1.0.0')"],
      outputFormat: 'text',
      defaultPermission: 'plan',
      timeoutMs: 60000,
      capabilities: ['code'],
      permissionArgs: { readonly: [], plan: [], execute: [], full: [] },
    }],
  }, null, 2), 'utf8')

  const child = spawn(process.execPath, [join(ROOT, 'ui', 'server.js'), '--workdir', ROOT], {
    env: {
      ...process.env,
      AGENTHUB_PORT: String(port),
      AGENTHUB_STATE_FILE: join(dir, 'state.json'),
      AGENTHUB_MEMBERS: membersPath,
      // 压到 3ms：一次两秒的运行里能看到几百条
      AGENTHUB_SSE_PING_MS: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childLog = ''
  child.stdout.on('data', (d) => { childLog += d })
  child.stderr.on('data', (d) => { childLog += d })
  t.after(() => {
    try { child.kill() } catch { /* 已经退了 */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 文件被占用就算了 */ }
  })

  const base = `http://127.0.0.1:${port}`
  let up = false
  let why = '（一次都没探到）'
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`${base}/`)
      if (r.ok) up = true
      else { why = `HTTP ${r.status}`; await sleep(100) }
    } catch (e) {
      why = e.message
      await sleep(100)
    }
  }
  assert.ok(up, `服务没起来（${why}）—— 后面的断言都无从谈起\n子进程输出：\n${childLog.slice(0, 800)}`)

  const started = Date.now()
  const res = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan: { goal: '心跳冒烟', subtasks: [{ id: 's1', memberId: 'slowpoke', prompt: '说一句 ok', title: '慢速一步' }] },
      permission: 'plan',
      onFailure: 'skip-blocked',
      workdir: ROOT,
    }),
  })
  assert.equal(res.status, 200, '通道一建立就该返回 200 响应头')
  const raw = await res.text()
  const elapsed = Date.now() - started

  const lines = raw.split('\n')
  const pings = lines.filter((l) => l === ': ping').length
  const frames = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => {
      const payload = l.slice(5).trim()
      try { return JSON.parse(payload) } catch { return { __bad: payload.slice(0, 80) } }
    })

  // 先把"窗口"钉死：窗口不存在的话，下面那条心跳断言毫无意义
  assert.ok(elapsed >= 1000, `这次运行只花了 ${elapsed}ms —— 窗口根本不存在，心跳断言会变成一句空话`)

  assert.ok(pings > 0, `一条心跳都没看到（跑了 ${elapsed}ms）—— 通道静默了。响应前 200 字：${raw.slice(0, 200)}`)
  assert.ok(frames.some((f) => f && f.type === 'open'), '连 open 帧都没收到')
  const bad = frames.filter((f) => f && f.__bad)
  assert.equal(bad.length, 0, `有 data 帧解析不了（心跳把它们弄坏了）：${JSON.stringify(bad.slice(0, 2))}`)
  assert.ok(
    frames.some((f) => f && f.type === 'plan-finish'),
    `没等到收尾事件 —— 通道被提前关掉了。收到的事件类型：${frames.map((f) => f && f.type).join(' / ')}`,
  )
})