/**
 * 启动横幅的端口必须等于**真正绑上的**那个端口。
 *
 * 运行：node --test tests/listen-banner.test.mjs
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么这个文件值得存在：
 *
 * 2026-09-30，用户报"快捷方式打不开"。真凶有两个，这是第二个 ——
 * 而它比第一个（老存档缺 `cards` 导致白屏）更难查，因为它**时好时坏**。
 *
 * `ui/server.js` 原来把启动横幅写在 `server.listen(port, host, cb)` 的回调里，
 * 那个回调本质上是 `once('listening')`。EADDRINUSE 的那次尝试不会触发 listening，
 * 但它的回调**已经注册上去、不会因为失败被摘掉**；等顺延后的那次真的绑上时，
 * listening 只派发一次，却把攒下来的**所有**回调都跑一遍，每个闭包里装着它自己
 * 那一次的 port。于是日志里出现了同一台服务"报"出来的好几个端口，而只有最后
 * 一个是真的。
 *
 * 后果不是"日志难看"。`electron/main.js` 只在日志里认**第一个** `http://` 就把窗口
 * 指过去，所以只要 8787 被占（上一次的残留实例占着它是最常见的启动场景），
 * 壳就百分之百导航到那个**别人的**端口：
 *   - 那里是残留的旧实例 → 窗口显示旧实例的界面
 *   - 那里什么都没了   → 空白 / 失败页，也就是用户说的"打不开"
 * 而且"把残留进程关掉再点一次就好了"，所以这个 bug 靠手点永远复现不出来。
 *
 * 所以断言必须盯着**事实**，而不是盯着那句话：横幅报出来的端口，得真的有人在听。
 * 下面把"报出来的端口"和"我占住的端口"两边对起来看 —— 报错的那个端口，
 * 恰恰是**我自己占着的**那个，一条断言就能把它钉死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'ui', 'server.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 占住一个端口（让内核随便挑，挑到的就是我们确实持有的），返回端口号和停手函数 */
async function occupyPort() {
  // 顺延是往 +1 走的，挑到 65535 就没地方可顺了 —— 换一个再挑。
  for (;;) {
    const got = await new Promise((resolve) => {
      const s = createServer((_req, res) => { res.writeHead(200); res.end('占位') })
      s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, release: () => new Promise((r) => s.close(r)) }))
    })
    if (got.port < 60000) return got
    await got.release()
  }
}

/** 探一下这个端口上有没有真的在服务 —— "有人听"和"服务能应答"是两件事 */
async function serves(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch { return false }
}

/** 起一个真的服务进程，把 stdout 收齐，直到它把横幅打完（或超时） */
async function startServer(port, workdir) {
  const env = { ...process.env, AGENTHUB_STATE_FILE: join(workdir, 'last-workdir.txt') }
  // `AGENTHUB_PORT` 会盖过 `--port`（见 server.js 顶上那行解析），所以必须**删掉**而不是设空串
  delete env.AGENTHUB_PORT
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--workdir', workdir], {
    cwd: ROOT,
    // `AGENTHUB_STATE_FILE` 不给的话，它会往用户真实的 Documents 里写"上次的目录"
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (b) => { out += b.toString() })
  child.stderr.on('data', (b) => { out += b.toString() })

  /*
   * 收尾必须**确定地**把这个子进程收掉。
   *
   * 光 `child.kill()` 不够：万一它没退，被它抱着的 pipe 会一直吊着事件循环，
   * `node --test` 就永远不结束 —— 表现是"测试卡住"，而不是"测试失败"，最难查。
   * 所以按 PID 杀进程树（`/T`）+ 强制（`/F`），再显式销毁两条管道，最后 unref 兜底。
   */
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    const t1 = Date.now()
    while (child.exitCode === null && child.signalCode === null && Date.now() - t1 < 3000) await sleep(100)
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await sleep(300)
    }
    try { child.stdout.destroy() } catch {}
    try { child.stderr.destroy() } catch {}
    child.unref()
  }

  const t0 = Date.now()
  while (!/只监听 127\.0\.0\.1/.test(out) && Date.now() - t0 < 15000) await sleep(150)
  return { child, out: () => out, stop }
}

test('端口被占用而顺延时，横幅只会报出**一个**端口，而且报的就是真正绑上的那个', async () => {
  const hole = await occupyPort()
  const workdir = mkdtempSync(join(tmpdir(), 'agenthub-banner-wd-'))
  let srv
  try {
    srv = await startServer(hole.port, workdir)
    const text = srv.out()

    // 前提先站稳：确实走了顺延那条路，否则下面等于什么都没测
    assert.match(text, /被占用，试/, '本来要测的就是顺延，但它没有顺延 —— 这个测试失去意义了')

    const banners = [...text.matchAll(/→ http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]))
    assert.equal(
      banners.length, 1,
      `横幅印了 ${banners.length} 份（${banners.join('、')}）—— 只有最后一份是真的，` +
      '而壳认的是第一份，于是窗口会被指到一个不属于这台服务的端口上',
    )

    const reported = banners[0]
    assert.notEqual(reported, hole.port, `横幅报的是 ${hole.port} —— 那是**我占着的**端口，不是服务绑的`)
    assert.ok(reported > hole.port, `顺延应当往后走，报出来的却是 ${reported}`)

    // 最要紧的一条：报出来的那个端口上，**真的**是它在服务
    assert.ok(await serves(reported), `横幅报 ${reported}，但那个端口上没有服务能应答`)
    assert.ok(await serves(hole.port), '占位服务不该被顶掉')
  } finally {
    if (srv) await srv.stop()
    await hole.release()
    for (let i = 0; i < 10; i++) {
      try { rmSync(workdir, { recursive: true, force: true }); break } catch { await sleep(200) }
    }
  }
})
