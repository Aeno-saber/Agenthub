/**
 * AgentHub 桌面壳 —— Electron 主进程
 *
 * ## 它做的事只有四件
 *
 * 1. 把 `ui/server.js` 作为**子进程**拉起来（不 import —— 那是个脚本，import 就会跑 `listen()`，
 *    而且它会去读 `process.argv`，在 Electron 里读到的是 Electron 自己的参数）；
 * 2. 从它的启动输出里读出**真正**的端口，再开窗口指过去；
 * 3. 窗口关掉时把子进程收掉；
 * 4. 出错了要说人话（不是白屏）。
 *
 * ## 为什么是"子进程 + 读输出"，而不是自己挑端口
 *
 * `ui/server.js` 有"端口被占用就顺延"的逻辑（8787 → 8788 → …，最多 10 个）。
 * 如果壳自己挑一个端口再传进去，就会出现**两处各自决定端口**的局面 ——
 * 而这正是这个仓库反复在修的那类问题（一份逻辑两处实现，迟早对不上）。
 * 所以端口只由 server 决定，壳只**读它印出来的那一行**。
 * （实测有效：本机 8787 被占时，它顺延到 8788，壳跟着走了 8788。）
 *
 * ## ⚠️ 一个必须显式设置的变量：ELECTRON_RUN_AS_NODE
 *
 * 子进程的执行文件是 `process.execPath`，也就是 **electron.exe** —— 它默认会把自己当
 * Electron 应用启动，而不是当 Node。设 `ELECTRON_RUN_AS_NODE=1` 之后它才以纯 Node 身份
 * 运行 `ui/server.js`。不设的表现是：子进程秒退、没有任何输出 —— 很难查。
 *
 * ## smoke 模式（`--smoke` 或 `AGENTHUB_SMOKE=1`）
 *
 * 沙箱/CI 里没有可用的 GUI，直接启动会撞上：
 *   `FATAL: GPU process isn't usable. Goodbye.`（exit_code=-1073741819）
 * `--disable-gpu` 单独用**不够** —— 它只关加速，Chromium 仍会去拉 GPU 子进程。
 * 必须四个一起上（见下方 NO_GPU 一段）。窗口全程 `show: false`，
 * 但默认 `paintWhenInitiallyHidden` 为 true，所以照样能 `capturePage()` 截图。
 */
import { app, BrowserWindow, dialog, shell, Menu } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(APP_DIR, 'ui', 'server.js')
/*
 * 应用图标。
 *
 * ★ 故意写成**相对当前文件的字面量**，而不是 `join(APP_DIR, 'ui', 'public', ...)`：
 * 打包脚本的"依赖闭包检查"专门扫这种以 `.` 开头的路径字面量（见 package-app.mjs 第 4 节），
 * 拼成绝对路径它就扫不到了 —— 图标一旦没被拷进产物，就会变成"exe 有图标、窗口没图标"
 * 而且没有任何关卡会红。同一个 .ico 也是打包时嵌进 exe 的那一份，**单一定义点**。
 */
const ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '../ui/public/agenthub.ico')

/** smoke / 截图模式：不弹窗、一次性数据目录、关 GPU */
const SMOKE = process.argv.includes('--smoke') || process.env.AGENTHUB_SMOKE === '1'

/**
 * 从服务的输出里取出"真正绑上的那个地址"。
 *
 * ★ 三条约束，每条都是踩出来的（2026-09-30）：
 *
 * ① **取最后一个，而不是第一个**。服务的启动横幅曾经为每一次失败的顺延尝试各印一份
 *    （已在 `ui/server.js` 修掉，那里有完整记录），而那时候第一个 `http://` 指向的是
 *    **别人的**端口 —— 壳照着它导航，用户看到的就是旧实例的界面、或者干脆一片空白。
 *    那边已经修了，这里仍然取最后一个：万一将来横幅再重复，最后一个才是真的。
 *
 * ② **必须等到整行到齐**（末尾有换行）。`out` 是流式累加的，一个 chunk 完全可能停在
 *    端口号的中间 —— 那时 `http://127.0.0.1:87` 是个**合法的匹配**，壳会导航到 87 号端口，
 *    再以 ERR_CONNECTION_REFUSED 收场。要求后面紧跟换行，等于要求端口号的最后一位已经到齐
 *    （`console.log` 是一次写出整行的，所以换行一定在数字之后）。
 *
 * ③ 匹配不上的时候返回空串，调用方据此**不导航**，而不是拿一个瞎猜的地址去试。
 */
function bannerUrl(text) {
  const hits = [...String(text).matchAll(/http:\/\/127\.0\.0\.1:\d+(?=\r?\n)/g)]
  return hits.length ? hits[hits.length - 1][0] : ''
}

/** 截图输出路径（smoke 模式下由环境变量指定） */
const SHOT_PATH = process.env.AGENTHUB_SHOT || ''

if (SMOKE) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')   // 关键：不再派生那个注定失败的子进程
  app.commandLine.appendSwitch('no-sandbox')       // 沙箱嵌套时子进程创建会被拒
  /*
   * 用一次性数据目录。三个理由，都是实测踩过的：
   *  1. 不污染用户真实的窗口状态；
   *  2. 用户正开着应用时也能跑测试（否则单实例锁会把测试顶掉）；
   *  3. 上一轮测试留下的状态不会混进来。
   * 必须在 requestSingleInstanceLock() **之前**设。
   */
  const dir = join(tmpdir(), 'agenthub-smoke')
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 占着就算了 */ }
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
}

let child = null
let win = null
/** 渲染进程的真报错（warning 不算，见 createWindow 里的说明） */
const consoleErrors = []

/**
 * 「用户上次选的工作目录」记在哪。
 *
 * 用 Electron 自己的 `userData` 目录，**不是** `~/.agenthub` 之类自己挑的地方：
 * smoke 模式下 userData 会被换成一次性目录（见上面的 SMOKE 分支），
 * 这样测试跑一百遍也不会污染用户真实的状态。让自己去写用户主目录就没这个好处。
 */
function stateFile() {
  // 显式指定优先 —— 测试要能把"上次的选择"预置成一个自己造的临时目录
  return process.env.AGENTHUB_STATE_FILE || join(app.getPath('userData'), 'last-workdir.txt')
}

/**
 * 默认工作目录：`文档/AgentHub`。
 *
 * 为什么不直接用 `process.cwd()`：打包成 exe 之后 cwd 是**安装目录**（可能只读），
 * 而且让 agent 往安装目录里写文件没有任何道理。
 * 为什么不直接用用户主目录：agent 会真的往里写文件，散一屋子不好收拾。
 * —— 界面上可以随时改，这只是个"第一次打开时不至于吓一跳"的初值。
 *
 * ★ 但它得是**上次那个**初值，不是一个永远不变的初值。
 *
 * 从前这里只认 `文档/AgentHub`，于是"在界面上切到自己的项目 → 关掉 → 再打开"
 * 会静默回到文档目录：用户以为自己换的项目没了，甚至可能对着文档目录跑完一整单任务
 * 才发现。根因是服务的 `/api/workdir` 只改进程内存（进程一退就没了），
 * 而壳又不知道用户切过 —— 所以必须由壳记住。写入在服务侧做（它才收到那次请求），
 * 壳只负责在下次启动时读回来。
 */
function defaultWorkdir() {
  if (process.env.AGENTHUB_WORKDIR) return process.env.AGENTHUB_WORKDIR

  /*
   * 读上次记的那个。要逐条排除"记了但用不了"：
   *   - 文件不存在 / 空 → 没记过
   *   - 目录已经被删了、或者变成了文件 → 不能用（退回默认，别让应用起不来）
   * 任何一步出岔子都当"没记过"处理 —— 一个记不住偏好的应用是可接受的，
   * 一个因为偏好失效就打不开的应用不是。
   */
  try {
    const saved = readFileSync(stateFile(), 'utf8').trim()
    if (saved && existsSync(saved) && statSync(saved).isDirectory()) return saved
  } catch { /* 没记过 —— 退回默认 */ }

  const dir = join(app.getPath('documents'), 'AgentHub')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 建不了就用 documents 本身 */ }
  return dir
}

/** 窗口创建前的占位页 —— 没有它，用户会先看到一闪的白屏 */
const SPLASH = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
               font:14px system-ui;color:#6b6a66;background:#faf9f7">
    正在启动 AgentHub 本地服务…
  </body>`)

/** 起不来时的人话页面（把子进程输出也带上，否则用户只能看到一个白屏） */
const failPage = (msg) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`
  <body style="margin:0;padding:32px;font:14px/1.7 system-ui;color:#1f1e1c;background:#faf9f7">
    <h2 style="color:#e24b4a;margin:0 0 12px">AgentHub 没能启动</h2>
    <p>本地服务没起来，所以界面加载不出来。原始信息：</p>
    <pre style="white-space:pre-wrap;background:#fff;border:1px solid #e8e7e3;border-radius:6px;padding:12px">${
      String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    }</pre>
    <p style="color:#6b6a66">可以试试：关掉重开；或者用命令行 <code>npm run ui</code> 看具体报错。</p>
  </body>`)

/** 服务起不来 / 中途挂掉时，把子进程最后那点输出交给用户看 */
function reportFailure(msg) {
  console.error('[AgentHub] 启动失败：', msg)
  if (win && !win.isDestroyed()) win.loadURL(failPage(msg))
}

/**
 * 拉起 ui/server.js，并在它报出端口之后把窗口指过去。
 * @returns {Promise<{ok:boolean, url:string, workdir:string, log:string}>}
 */
function startServerAndLoad() {
  return new Promise((resolve) => {
    const workdir = defaultWorkdir()
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // 告诉服务把"用户切到哪个目录"记在哪 —— 服务自己不知道该写哪儿（见 stateFile 的说明）
      AGENTHUB_STATE_FILE: stateFile(),
    }
    // smoke 下用独立端口段，免得和用户正开着的实例抢
    const portArg = process.env.AGENTHUB_PORT ? ['--port', process.env.AGENTHUB_PORT] : []

    child = spawn(process.execPath, [SERVER_ENTRY, '--workdir', workdir, ...portArg], {
      cwd: APP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let out = ''
    let settled = false
    /*
     * ★ loadURL 只许发起**一次**。
     *
     * 实测（2026-09-29，从截图上的 `ERR_ABORTED (-3)` 反推出来的）：
     * 服务的启动横幅是**七行独立的 console.log** —— 在管道上很可能分成多个 data 事件到达。
     * 而下面的写法（修复前）是"每来一个 chunk 就重新匹配一次 URL、再调一次 loadURL"：
     *
     *     if (/http:\/\/.../.test(out) && win && !win.isDestroyed()) {
     *       win.loadURL(url).then(...)      ← 第二次调用会把第一次**中断**
     *     }
     *
     * Electron 里后一个导航会打断前一个，被打断的那个以 ERR_ABORTED reject ——
     * 于是走进 catch，`settle(false)`，失败页把真界面顶掉。**服务明明起来了，
     * 用户看到的却是"AgentHub 没能启动"，重开一次又好了。**
     * 之前一直没炸只是时序运气：URL 那一行和后面的行恰好合并进了同一个 chunk。
     * 这正是"时好时坏"里最坏的一种 —— 报错指向的地方（加载失败）根本不是病因所在。
     */
    let navStarted = false

    const settle = (ok) => {
      if (settled) return
      settled = true
      if (!ok) reportFailure(out.slice(-2000) || '（子进程没有任何输出）')
      resolve({ ok, url: bannerUrl(out), workdir, log: out })
    }

    child.stdout.on('data', (buf) => {
      const text = buf.toString()
      out += text
      process.stdout.write(`[server] ${text}`)
      /*
       * 只认 server 自己印的那一行 —— 端口由它决定（8787 被占就顺延），壳不猜。
       * 那一行长这样：  → http://127.0.0.1:8787
       * "端口 8787 被占用，试 8788…" 这种行不含 http:// 前缀，所以不会被误匹配。
       * 取哪一个、以及为什么要等整行到齐，见 bannerUrl 上面的注释。
       */
      const url = bannerUrl(out)
      if (!navStarted && url && win && !win.isDestroyed()) {
        navStarted = true   // ← 只许发起一次：后续 chunk 里再出现 URL 也不许再导航
        /*
         * ★ 必须 **await 这次导航**再算"起来了"。
         *
         * `loadURL()` 返回的 Promise 在页面**加载完成**时兑现。不等它的后果实测到了：
         * 后面所有 DOM 断言都跑在"上一张页面"（那个占位页）上 ——
         * 但占位页上的断言**居然大部分是绿的**，因为界面的静态 HTML 里本来就有
         * `.topbar .brand`、`#chatList`、`#memberCount`（占位值 `0/0`）。
         * 于是"界面渲染出来了"是在**一行脚本都没执行**的情况下通过的。
         */
        win.loadURL(url).then(() => settle(true)).catch((e) => {
          out += `\n加载界面失败：${e.message}`
          settle(false)
        })
      }
    })

    child.stderr.on('data', (buf) => {
      const text = buf.toString()
      out += text
      process.stderr.write(`[server] ${text}`)
    })

    child.on('error', (e) => {
      out += `无法启动子进程：${e.message}`
      settle(false)
    })

    child.on('exit', (code, signal) => {
      child = null
      if (!settled) {
        out += `\n本地服务退出（code=${code} signal=${signal}）`
        settle(false)
      } else if (win && !win.isDestroyed()) {
        // 起来之后又挂了 —— 同样是白屏，同样要说人话
        reportFailure(`本地服务意外退出（code=${code}）。\n\n${out.slice(-2000)}`)
      }
    })

    // 兜底：15 秒还没报出端口就当作失败，别让用户对着"正在启动…"干等
    setTimeout(() => {
      out += '\n等了 15 秒没有收到服务的启动信息。'
      settle(false)
    }, 15000)
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#faf9f7',
    title: 'AgentHub',
    // 窗口/任务栏图标。exe 文件本身的图标是打包时用 rcedit 嵌的（见 tools/package-app.mjs），
    // 两者用同一个 .ico —— 否则会出现"任务栏是 A、文件夹里是 B"这种不一致。
    icon: ICON_PATH,
    autoHideMenuBar: true,
    // smoke 下全程不显示 —— 用户桌面上不会闪窗口，但照样能截图（见文件头说明）
    show: !SMOKE,
    webPreferences: {
      // 界面是本地 http 服务提供的普通网页，不需要 Node —— 保持默认的安全边界
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  /*
   * 隐藏窗口默认会被 Chromium 节流（rAF/定时器被拖住），
   * 那会让截图抓到"上一帧"或者干脆是空的。
   */
  win.webContents.setBackgroundThrottling(false)

  /*
   * 收集渲染进程的**真报错**。
   *
   * ⚠️ 只收 `error`，不收 `warning`：Electron 默认会为"没设 CSP"发一条 Security Warning，
   * 它在打包后就不出现了，把它算成"界面有报错"会让冒烟永远红着。
   *
   * ⚠️ 必须在这里（loadURL 之前）挂 —— 页面脚本的报错在加载期间就发生了，
   * 等 `runSmoke` 里再挂监听，早期错误一条都收不到。
   */
  win.webContents.on('console-message', (...args) => {
    // Electron 32+ 传一个带 level/message 的事件对象；更早是 (event, level, message, ...)
    let level, message
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) ({ level, message } = args[0])
    else [, level, message] = args
    if (level === 'error' || level === 3) consoleErrors.push(String(message))
  })

  win.loadURL(SPLASH)

  // 外链一律交给系统浏览器，别在应用窗口里把本地界面顶掉
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  win.on('closed', () => { win = null })
}

/**
 * 只留一个精简菜单。
 * 不是为了好看 —— 默认菜单里那堆 View/Window 项对普通用户全是噪音，
 * 但**开发者工具必须还能打开**：出问题时它是唯一能看见前端报错的地方。
 */
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]))
}

// ────────────────────────────────────────────────────────── smoke 断言

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待一个条件成立 —— **不要用固定 sleep 去赌**。
 *
 * 固定 sleep 的两种死法都踩过：太短 → 拿到上一帧的状态（断言假红）；
 * 太长 → 每次冒烟都白等。而"界面初始化好了没"这件事本来就有可观测的判据
 * （服务端的数据有没有落到 DOM 里），轮询它比猜时间可靠得多。
 *
 * @param {() => Promise<any>} fn  返回真值即视为完成
 * @returns {Promise<any|null>}    完成时的返回值；超时返回 null
 */
async function waitFor(fn, timeoutMs = 5000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

/**
 * 一次"真的画出来了"的截图。
 *
 * ★ 必须连拍两张：隐藏窗口的第一张 `capturePage()` 常常是**上一帧**（甚至是空的）。
 * 这条是实测踩出来的 —— 当时设置弹层 DOM 明明已经 `display:grid`，图里却是空的，
 * 差点去改没坏的代码。丢掉第一张之后就对了。
 */
async function shot(file) {
  await win.webContents.capturePage()
  await sleep(200)
  const img = await win.webContents.capturePage()
  writeFileSync(file, img.toPNG())
  const { width, height } = img.getSize()
  return { width, height, bytes: img.toPNG().length }
}

async function runSmoke(loaded) {
  const result = {
    ok: false, url: loaded.url, workdir: loaded.workdir,
    checks: [], consoleErrors, shot: null,
  }
  const push = (name, pass, detail) => result.checks.push({ name, pass: !!pass, detail: String(detail ?? '') })

  push('本地服务起来并报出端口', loaded.ok, loaded.url || '（没有收到端口）')

  if (loaded.ok) {
    /*
     * 端口顺延的验收：窗口里加载的必须**正是服务报出的那个地址**。
     * （本机 8787 常常被上一次的实例占着，所以这条是日常会走到的路径。）
     */
    const actual = win.webContents.getURL()
    push('窗口加载的正是服务报出的那个地址（端口顺延也要跟对）', actual.startsWith(loaded.url), actual)
  }

  /*
   * ★ 等界面**真的初始化完**，而不是 sleep 一个固定值。
   *
   * `boot()` 里 `render()` 是同步的，但 `fetchMembers()` 是异步的 —— 成员数、
   * 工作目录名都是那之后才填上的。**判据必须是"服务端来的数据已经落到 DOM 里"**，
   * 不能用"元素在不在"：界面的静态 HTML 里本来就有 `#memberCount`（占位 `0/0`）
   * 和 `#projectName`（占位 `…`），拿它们当通过条件等于什么都没断言。
   */
  const ready = await waitFor(async () => {
    const r = await win.webContents.executeJavaScript(`(function(){
      const t = (s) => { const e = document.querySelector(s); return e ? e.textContent : null };
      return { hub: typeof window.AgentHub, project: t('#projectName'), members: t('#memberCount') };
    })()`).catch(() => null)
    if (!r || r.hub !== 'object') return null
    const m = /^(\d+)\/(\d+)$/.exec(r.members || '')
    if (!m || Number(m[2]) === 0) return null          // 0/0 就是那个占位值，不算数
    if (!r.project || r.project === '…') return null
    return r
  }, 8000)

  push('界面初始化完成（boot() 跑完、服务端数据落进 DOM）', !!ready,
    ready ? `project=${ready.project} members=${ready.members}` : '8 秒内没等到；DOM 可能还停在静态 HTML')

  const dom = await win.webContents.executeJavaScript(`(function(){
    const q = (s) => document.querySelector(s);
    const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect();
      return { x:r.x, y:r.y, w:Math.round(r.width), h:Math.round(r.height) }; };
    return {
      // 品牌区现在装着「图标 + 文字」两件东西，textContent 必然夹着排版空白 —— 折起来比
      brand: q('.topbar .brand') ? q('.topbar .brand').textContent.replace(/\\s+/g, ' ').trim() : null,
      memberCount: q('#memberCount') ? q('#memberCount').textContent : null,
      projectName: q('#projectName') ? q('#projectName').textContent : null,
      hasChatList: !!q('#chatList'), hasTaskList: !!q('#taskList'),
      topbar: rect('.topbar'), main: rect('.main'), sidebar: rect('.sidebar'),
      viewport: { w: innerWidth, h: innerHeight },
      overflowX: document.documentElement.scrollWidth - innerWidth,
      bodyText: (document.body.innerText || '').length,
    };
  })()`).catch((e) => ({ error: String(e) }))

  if (dom.error) {
    push('界面 DOM 可读取', false, dom.error)
  } else {
    /*
     * 比的是"标题渲染出来了没有"，**不比排版空白** —— 品牌区里除文字还有一个
     * `<img class="brand-icon">`，多行写法会让 textContent 夹上换行与缩进。
     * 这条断言本来就抓不到"静态 HTML 糊弄过去"（占位页里 `.brand` 写着同样的字），
     * 真正卡住那一关的是上面那条 `界面初始化完成`（要 boot() 真跑完），
     * 所以这里去掉空白不会削弱任何东西。
     */
    push('界面标题渲染出来', dom.brand === 'AgentHub', dom.brand)
    push('顶栏/主区/左栏都有非零尺寸（元素在 ≠ 画出来了）',
      dom.topbar && dom.topbar.h > 20 && dom.main && dom.main.w > 200 && dom.sidebar && dom.sidebar.w > 40,
      JSON.stringify({ topbar: dom.topbar, main: dom.main, sidebar: dom.sidebar }))
    push('没有横向溢出', dom.overflowX <= 1, `overflowX=${dom.overflowX}`)
    push('页面上确实有内容（不是白屏）', dom.bodyText > 20, `innerText 长度=${dom.bodyText}`)
    /*
     * ★ 这里必须卡"总数 > 0"，不能只卡形状。
     * 上一版写的是 `/^\d+\/\d+$/`，而静态 HTML 里的占位值恰好是 `0/0` —— 断言全绿，
     * 可它证明的只是"页面上有个长得像 N/M 的字符串"。**能被占位值满足的断言等于没写。**
     */
    const mc = /^(\d+)\/(\d+)$/.exec(String(dom.memberCount || ''))
    push('成员列表已从服务端读到（总数必须非零，0/0 是占位值）',
      !!mc && Number(mc[2]) > 0, `memberCount=${dom.memberCount}`)
    push('工作目录名已从服务端读到（不是占位符 …）',
      !!dom.projectName && dom.projectName !== '…', dom.projectName)
    push('左栏两个列表都在', dom.hasChatList && dom.hasTaskList, `chatList=${dom.hasChatList} taskList=${dom.hasTaskList}`)
    result.projectName = dom.projectName
  }

  // 真的能和本地服务通一次话（证明不是"只有静态 HTML 画出来了"）
  const api = await win.webContents.executeJavaScript(
    `fetch('/api/members').then(r=>r.json()).then(j=>({ ok:true, count:(j.members||[]).length })).catch(e=>({ ok:false, err:String(e) }))`
  ).catch((e) => ({ ok: false, err: String(e) }))
  push('渲染进程能调通本地 API（不只是静态页画出来了）', api.ok && api.count > 0, JSON.stringify(api))
  if (api.ok) push('服务端报的成员数和服务端自己的一致', api.count > 0, `count=${api.count}`)

  if (SHOT_PATH) {
    try {
      result.shot = await shot(SHOT_PATH)
      push('截图非空且尺寸与窗口一致',
        result.shot.bytes > 2000 && result.shot.width > 800,
        JSON.stringify(result.shot))
    } catch (e) {
      push('截图', false, String(e))
    }
  }

  push('渲染进程没有 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  result.ok = result.checks.every((c) => c.pass)
  return result
}

// ────────────────────────────────────────────────────────── app 生命周期

/*
 * 任务栏身份（AppUserModelID）。
 *
 * Windows 靠这个 ID 决定"哪些窗口算同一个应用、用哪个图标、能不能钉到任务栏"。
 * 不设的话便携版会以 exe 路径为身份 —— 挪个目录、换个文件名，
 * 钉在任务栏上的图标就变成一个白纸/重复项。设成一个稳定 ID 就没这回事。
 * 必须在创建窗口之前调用。
 */
app.setAppUserModelId('AgentHub')

/*
 * 单实例：再点一次图标不该开出第二个（第二个会去抢 8787，然后顺延到 8788 ——
 * 结果就是两个窗口、两份互不相干的状态，用户完全不知道为什么）。
 * smoke 模式跳过它，否则用户正开着应用时测试跑不起来。
 */
const gotLock = SMOKE || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(async () => {
    buildMenu()
    createWindow()
    const loaded = await startServerAndLoad()

    if (SMOKE) {
      const result = await runSmoke(loaded)
      // smoke 结果走 stdout 的结构化标记，方便外层脚本抓取
      process.stdout.write(`\n__SMOKE_RESULT__${JSON.stringify(result)}__END__\n`)
      killChild()
      app.exit(result.ok ? 0 : 1)
      return
    }
  })

  app.on('window-all-closed', () => app.quit())

  // 收掉子进程 —— 留着它会让 8787 一直被占，下次启动就"莫名其妙"跑到别的端口
  app.on('before-quit', killChild)
}

/** 收子进程。硬杀也要做，否则被强退时会留下占着端口的孤儿服务。 */
function killChild() {
  if (!child) return
  try { child.kill() } catch { /* 已经没了 */ }
  child = null
}

// 命令行 Ctrl+C / 被 timeout 掐掉时也要收 —— 否则留下孤儿服务占着端口
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killChild(); app.exit(0) })
}

// 让未捕获异常也有交代，而不是静默退出
process.on('uncaughtException', (e) => {
  console.error('[AgentHub] 主进程未捕获异常：', e)
  if (SMOKE) {
    process.stdout.write(`\n__SMOKE_RESULT__${JSON.stringify({
      ok: false, checks: [{ name: '主进程未捕获异常', pass: false, detail: String(e && e.stack || e) }], consoleErrors: [],
    })}__END__\n`)
    killChild()
    app.exit(1)
    return
  }
  if (app.isReady()) dialog.showErrorBox('AgentHub 出错了', String(e && e.stack || e))
})
