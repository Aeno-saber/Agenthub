/**
 * 零依赖浏览器驱动（CDP 直连 Edge/Chrome）
 *
 * 为什么不用 Playwright：本机装了火绒实时防护，带浏览器二进制下载的依赖会被拖到几十分钟，
 * 还容易半装留下坏 node_modules。验证"界面能不能用"只需要三样东西，Node 22 全自带：
 *   系统里的 Edge + CDP（就是 WebSocket 上的 JSON-RPC）+ 内置的全局 WebSocket
 *
 * 这个文件是 `tests/ui-smoke.mjs` 和 `tests/real-run.mjs` 的公共底座 —— 那些参数
 * （`--remote-allow-origins` 少了就 403、`--no-proxy-server` 少了就被系统代理截走）
 * 都是踩出来的，散在两处早晚会改一处忘一处，所以收在这里。
 *
 * 端口：**不要再传固定端口**。`launchBrowser()` 默认让浏览器自己挑（`=0`），
 * 起完从私有配置目录的 `DevToolsActivePort` 读回真实端口，`newPage(browser.port, url)` 用它。
 * 原因见 `launchBrowser` 上面的长注释 —— 固定端口 + 残留进程会静默连到旧浏览器上。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取片段的前几行做报错回显。
 * 为什么只取头几行：真正拼坏的地方往往就在开头（调用方的注释、未闭合的括号），
 * 而且冒烟的片段动辄上百行，全印出来会把报错本身淹掉。
 */
function preview(src, lines = 3) {
  return String(src)
    .split('\n')
    .slice(0, lines)
    .map((l) => '    │ ' + l)
    .join('\n')
}

const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

export function findBrowser() {
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) || null
}

/**
 * 起一个 headless 浏览器。
 *
 * ★★ 2026-09-30 修掉的严重问题：**固定端口 + 进程泄漏 = 静默连错浏览器**。
 *
 * 原来写死 `--remote-debugging-port=9333`。Edge 的启动器进程是**分离**的，
 * `child.kill()` 只杀掉那个已经退出的壳，真正的 broker 继续活着占着 9333。
 * 于是下一次跑：`/json/version` 探测**旧浏览器**也照样通，`newPage` 就在旧实例上开页 ——
 * 那个实例带着**上一轮的 localStorage**，恢复出上次停的会话，首页整个不渲染。
 * 表现出来是"页面没渲染 / 卡片 0 张"这种**和真实回归长得一模一样**的假红。
 * 实测泄漏了 6 个浏览器实例、52 个 msedge 进程、7 个临时配置目录。
 *
 * 两道防线（都要，缺一不可）：
 *  ① **让浏览器自己挑端口**（`--remote-debugging-port=0`）：两个浏览器不可能再抢同一个端口，
 *     并发跑多个测试也从"靠约定错开端口"变成天然安全。
 *  ② **认端口归属**：端口不靠猜，读我们自己私有配置目录里的 `DevToolsActivePort`
 *     （这是 Chromium 自己写的权威来源），再拿 `/json/version` 回给我们的
 *     `webSocketDebuggerUrl` 跟它对账 —— 对不上就是连到别人家去了，**当场报错**，
 *     绝不"看着能用就继续跑"。
 *
 * @param {{port?:number, width?:number, height?:number}} opts
 *   `port` 省略（或 0）= 自动挑端口，推荐。显式指定只在调试时需要，且同样过归属校验。
 * @returns {Promise<{child:import('node:child_process').ChildProcess, profileDir:string,
 *                    port:number, browserWsUrl:string, wsPath:string, pid:number}>}
 */
export async function launchBrowser({ port = 0, width = 1440, height = 900 } = {}) {
  const bin = findBrowser()
  if (!bin) throw new Error('找不到 Edge/Chrome，可用 EDGE_PATH 指定')

  const profileDir = mkdtempSync(join(tmpdir(), 'agenthub-browser-'))
  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    `--window-size=${width},${height}`,  // 默认 800x600，截图会挤成一团，看不出真实布局
    '--no-proxy-server',                 // 不加：本机服务被系统代理截走，报 502 upstream connect failed
    '--remote-allow-origins=*',          // 不加：连 CDP 的 WebSocket 直接被 403
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profileDir,     // 一次性配置目录，别污染用户真实浏览器
    `--remote-debugging-port=${port}`,   // 0 = 让浏览器自己挑（见上面 ①）
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  // 等 Chromium 把 DevToolsActivePort 写进配置目录。文件两行：端口 / 浏览器级 ws 路径
  const portFile = join(profileDir, 'DevToolsActivePort')
  const t0 = Date.now()
  let realPort = 0
  let wsPath = ''
  for (;;) {
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, 'utf8').split('\n').map((s) => s.trim())
      if (lines[0] && lines[1]) { realPort = Number(lines[0]); wsPath = lines[1]; break }
    }
    if (Date.now() - t0 > 30000) {
      await closeBrowser({ child, profileDir, port: 0 })
      throw new Error('浏览器调试端口没起来（DevToolsActivePort 一直没写出来）')
    }
    await sleep(100)
  }

  // ② 归属对账：端口通了不代表是我们的
  let version
  try {
    version = await getJson(realPort, '/json/version')
  } catch (e) {
    await closeBrowser({ child, profileDir, port: realPort })
    throw new Error(`调试端口 ${realPort} 连不上：${e.message}`)
  }
  const wsUrl = String(version.webSocketDebuggerUrl || '')
  if (!wsUrl.endsWith(wsPath)) {
    await closeBrowser({ child, profileDir, port: realPort })
    throw new Error(
      `调试端口 ${realPort} 上的浏览器**不是我们起的那个**（归属校验没过）。\n` +
      `  我们配置目录写的 ws 路径：${wsPath}\n` +
      `  端口实际返回的 ws 地址：${wsUrl}\n` +
      `  这通常意味着有上一次跑崩后残留的浏览器还占着端口。先清掉再跑。`,
    )
  }

  return { child, profileDir, port: realPort, browserWsUrl: wsUrl, wsPath, pid: child.pid }
}

/** 调试端点还在不在 —— 这才是"浏览器还活着吗"的正确判据（比起看端口 bind 状态，避开 TIME_WAIT 干扰） */
async function devtoolsAlive(port) {
  if (!port) return false
  try { await getJson(port, '/json/version'); return true } catch { return false }
}

async function waitDevtoolsGone(port, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await devtoolsAlive(port))) return true
    await sleep(150)
  }
  return false
}

/**
 * 关掉浏览器。
 *
 * 顺序是有讲究的：先用 `Browser.close` **让浏览器自己关** —— 它会把随它一起起来的
 * 子进程（渲染器、GPU、网络进程）整棵树带走，这正是 `child.kill()` 做不到的事。
 * 关不掉才退回按 PID 杀树。最后删自己的配置目录（只删 mkdtemp 给我们的那一个）。
 */
export async function closeBrowser(h) {
  if (!h) return
  try {
    if (h.browserWsUrl) {
      const cdp = await CDP.attach(h.browserWsUrl)
      await cdp.send('Browser.close')
      try { cdp.ws.close() } catch {}
    }
  } catch { /* 已经关了 / 连不上，都算正常 */ }

  if (h.port && !(await waitDevtoolsGone(h.port, 5000))) {
    const pid = h.pid || h.child?.pid
    if (pid) {
      // /T = 连子进程一起杀，/F = 强制。Windows 上光靠 child.kill() 收不掉分离出去的子进程
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    }
    await waitDevtoolsGone(h.port, 3000)
  }

  await removeProfileDir(h.profileDir)
}

/**
 * 删掉这次自己建的配置目录。
 *
 * 要重试：`Browser.close` 之后调试端点立刻消失，但浏览器进程还在收尾、**文件句柄还没放**，
 * 这时候 `rmSync` 会抛 EBUSY/EPERM。原来只试一次，于是每次跑都静默留下一个几十 MB 的临时目录
 * （实测攒了 7 个）。删不掉不算致命，所以重试几次仍失败就放过。
 */
async function removeProfileDir(dir) {
  if (!dir) return
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch {
      await sleep(300)
    }
  }
}

async function getJson(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  return res.json()
}

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')), { once: true })
    })
    return new CDP(ws)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)) }
      }, 60000)
    })
  }

  on(fn) { this.listeners.push(fn) }

  /**
   * 在页面里求值。表达式会被包进 async IIFE，所以可以直接写 `return` 和 `await`。
   * ⚠️ returnByValue 只能取回可序列化的值 —— NodeList 一律改成 `.length` 或 `[...x].map(...)`。
   *
   * ★★ 2026-09-29 踩到的坑，两道防线都留在这儿：
   *
   * ① **闭合括号必须换行**。原来是 `(async () => { ${expression} })()` —— 全在同一行。
   *    于是只要传进来的片段**以行注释结尾**（`// 说点什么`），闭合的 `})()` 就被注释吃掉，
   *    页面收到一个没闭合的片段。测出来是一句前言不搭后语的报错，离真正的病因十万八千里。
   *    加了 `\n` 之后，片段末尾的 `//` 只注释掉它自己那一行的剩余部分，闭合照样成立。
   *
   * ② **报错必须带上"你让我跑的是什么"**。只印 `api is not defined` 的话，
   *    根本看不出是哪一步挂的 —— 那次花了不少时间才定位到是**调用方文件里注释中的反引号**
   *    把外层模板字符串提前闭合、payload 被拼坏。所以这里先本地语法预检、异常时回显片段。
   */
  async evaluate(expression) {
    // 本地预检：payload 若不是合法 JS，在这里就报，别等浏览器甩一句莫名其妙的 ReferenceError
    let expression_
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (async () => {\n${expression}\n})()`)
      expression_ = expression
    } catch (e) {
      throw new Error(
        `[CDP] 传给页面的片段不是合法 JS（${e.message}）—— 多半是调用方模板字符串被拼坏了。\n` +
        `片段前 3 行：\n${preview(expression)}`,
      )
    }

    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => {\n${expression_}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error(`[CDP] ${desc}\n  片段前 3 行：\n${preview(expression_)}`)
    }
    return r.result.value
  }

  /** `evaluate` 的短别名 —— 测试脚本里这个调用会写几十次，名字短一点好读 */
  eval(expression) { return this.evaluate(expression) }
}

/**
 * 开一个页面并把控制台观测打开。
 *
 * ★ 顺序很关键：先 about:blank 建 target → 开 CDP 域 → 最后才导航。
 * 反过来（`/json/new?url=...` 直接带地址）页面会在你 Runtime.enable 之前就跑完脚本，
 * **启动期的未捕获异常全部漏掉** —— 而"一打开就白页"恰恰就发生在启动期。
 */
export async function newPage(cdpPort, url, { width = 1440, height = 900 } = {}) {
  const target = await getJson(cdpPort, '/json/new?about:blank', { method: 'PUT' })   // 注意是 PUT
  const cdp = await CDP.attach(target.webSocketDebuggerUrl)

  const page = {
    cdp,
    errors: [],
    exceptions: [],
    close: () => { try { cdp.ws.close() } catch {} },

    eval: (expr) => cdp.evaluate(expr),

    async shot(dir, name) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
      mkdirSync(dir, { recursive: true })
      const p = join(dir, `${name}.png`)
      writeFileSync(p, Buffer.from(r.data, 'base64'))
      console.log('  📷 ' + name + '.png')
      return p
    },

    /** 轮询一个表达式，直到它为真。返回是否等到。 */
    async waitFor(expr, { tries = 100, interval = 250, label = '' } = {}) {
      for (let i = 0; i < tries; i++) {
        const ok = await cdp.evaluate(expr).catch(() => false)
        if (ok) return true
        await sleep(interval)
      }
      if (label) console.log(`  （等待超时：${label}）`)
      return false
    },

    async goto(target = url) {
      await cdp.send('Page.navigate', { url: target })
      for (let i = 0; i < 150; i++) {
        const st = await cdp.evaluate('return document.readyState').catch(() => '')
        if (st === 'complete') break
        await sleep(100)
      }
    },
  }

  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      page.exceptions.push(d.exception?.description || d.text || '未知异常')
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
      page.errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const en = msg.params.entry
      // ★ 必须把 url 拼进来：text 只有 "Failed to load resource: 404"，看不出是谁 404，
      //    于是 favicon 这种无害噪音会伪装成真错误
      const t = [en.text, en.url].filter(Boolean).join(' ')
      if (!/favicon|net::ERR_|ERR_PROXY/i.test(t)) page.errors.push(t)
    }
  })

  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  // headless 下窗口尺寸不一定反映到视口，显式钉死，否则截图和媒体查询都对不上
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  })
  await page.goto(url)
  return page
}
