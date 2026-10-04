/**
 * Electron 桌面壳的冒烟测试。
 *
 * 运行：node tests/electron-smoke.mjs
 *
 * ## 它证明什么
 *
 * 沙箱/CI 里没有可用的 GUI，所以"能启动"这件事没法靠看一眼确认。
 * 这个脚本用 `--smoke` 让壳在**不弹窗**的前提下跑完断言，把结果用
 * `__SMOKE_RESULT__{...}__END__` 标记吐到 stdout，这里再解析。
 *
 * 覆盖的是"接没接上线"这一层 —— 而这一层恰恰是真跑才看得见的：
 *   - 子进程有没有真的起来（`ELECTRON_RUN_AS_NODE=1` 设错 → 秒退、无输出）
 *   - **端口由 server 决定**，壳有没有跟着那个端口走（8787 被占时会顺延）
 *   - 窗口里画的到底是不是那个界面（而不是空白页 / 错误页）
 *   - 界面是真的从服务端读到了数据，还是只印了个静态骨架
 *   - 页面上的元素是不是**有尺寸**（元素在 ≠ 画出来了）
 *
 * ## 两个环境坑（都实测踩过）
 *
 * 1. **必须去掉 `ELECTRON_RUN_AS_NODE`**。沙箱 shell 默认带这个变量，
 *    带着它启动 electron 会让 `require('electron')` 拿到一个路径字符串、
 *    `app` 为 undefined，进程秒退且没有任何输出。
 * 2. **必须让壳关掉 GPU**。否则：
 *    `FATAL:GPU process isn't usable. Goodbye.`（exit_code=-1073741819）
 *    这一步由 `--smoke` 内部处理，这里只要把参数传进去。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', '.bin', 'electron.cmd')
const ELECTRON_PLAIN = join(ROOT, 'node_modules', '.bin', 'electron')

/*
 * `--exe <path>` 时测的是**打包产物**，不是开发目录。
 *
 * 这一条不能省：打包之后 `process.defaultApp === undefined`，argv 的位置
 * 和开发时**不一样**，只有真跑才知道接线接对没接对。
 * 而且——旧代码本身是好的，所以拿"过期的产物"跑冒烟也会全绿。
 */
const exeIdx = process.argv.indexOf('--exe')
const PACKAGED = exeIdx >= 0 ? process.argv[exeIdx + 1] : ''
if (exeIdx >= 0 && !PACKAGED) {
  console.error('--exe 后面要跟产物路径')
  process.exit(1)
}

/** 用独立端口段 + 一次性工作目录，绝不碰用户真实的数据和 Documents/AgentHub */
const PORT = PACKAGED ? '8792' : '8791'
const workdir = mkdtempSync(join(tmpdir(), 'agenthub-smoke-wd-'))
const shotPath = join(ROOT, '.agenthub', 'screenshots', PACKAGED ? 'app-packaged.png' : 'app.png')

/** 环境变量：整份复制，然后**删掉** ELECTRON_RUN_AS_NODE（不是设成空串） */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.AGENTHUB_SMOKE = '1'
env.AGENTHUB_PORT = PORT
env.AGENTHUB_SHOT = shotPath

/*
 * ★ 工作目录刻意**不走** `AGENTHUB_WORKDIR`，而是走"上次记住的那个"这条路。
 *
 * 理由：后者才是真实用户每天走的路径 —— 在界面上切到自己的项目、关掉、再打开。
 * `AGENTHUB_WORKDIR` 是给脚本用的显式覆盖（优先级最高，一句话就能看懂），
 * 而"记住上次的选择"涉及落盘、读回、目录已失效等多个分支，才是真会坏的那条。
 * 所以这里预先写好那个记录文件，再看壳会不会照着它走。
 */
const stateDir = mkdtempSync(join(tmpdir(), 'agenthub-smoke-state-'))
const stateFile = join(stateDir, 'last-workdir.txt')
writeFileSync(stateFile, workdir, 'utf8')
env.AGENTHUB_STATE_FILE = stateFile

const bin = PACKAGED || (process.platform === 'win32' ? ELECTRON : ELECTRON_PLAIN)
// 打包产物是独立 exe，不需要 shell 解释 .cmd；开发时走 node_modules/.bin/electron.cmd 才要 shell
const useShell = !PACKAGED && process.platform === 'win32'
// 产物的 argv 里没有"."（它自己就是入口）；开发时要用"."告诉 electron 去读 package.json
const argv = PACKAGED ? ['--smoke'] : ['.', '--smoke']

console.log(`─── Electron 桌面壳冒烟${PACKAGED ? '（打包产物）' : ''} ───`)
console.log(`  入口   ${bin}`)
console.log(`  端口   ${PORT}`)
console.log(`  工作目录 ${workdir}\n`)

const child = spawn(bin, argv, { cwd: ROOT, env, shell: useShell })

let out = ''
child.stdout.on('data', (b) => {
  const t = b.toString()
  out += t
  process.stdout.write(t.replace(/^/gm, '  '))
})
child.stderr.on('data', (b) => {
  const t = b.toString()
  out += t
  // Electron 在沙箱里会吐一堆 GPU/网络噪音，只在真出错时显示
  if (/FATAL|Uncaught|Error:|__SMOKE_RESULT__/.test(t)) process.stderr.write(t.replace(/^/gm, '  ! '))
})

const cleanup = () => {
  try { rmSync(workdir, { recursive: true, force: true }) } catch {}
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
}

child.on('exit', (code) => {
  const m = out.match(/__SMOKE_RESULT__(.*?)__END__/s)
  if (!m) {
    console.error('\n✗ 没拿到冒烟结果 —— 壳可能在跑到断言之前就退了。')
    console.error('  上面若出现 "GPU process isn\'t usable"，说明 GPU 没被关掉。')
    console.error(`  退出码：${code}`)
    cleanup()
    process.exit(1)
  }

  let r
  try { r = JSON.parse(m[1]) } catch (e) {
    console.error('\n✗ 冒烟结果是坏 JSON：', e.message)
    cleanup()
    process.exit(1)
  }

  console.log('\n─── 断言 ───')
  let fail = 0
  for (const c of r.checks) {
    if (c.pass) console.log(`  ok   ${c.name}`)
    else { fail++; console.log(`  FAIL ${c.name}   ${c.detail}`) }
  }

  /*
   * ★ 壳用的是不是「上次记住的那个目录」。
   *
   * 断言放在这一侧而不是壳里：壳只负责把 `loaded.workdir` 如实报出来，
   * 而"它应该等于多少"只有测试脚本知道 —— 那个目录是它自己造的、自己写进记录文件的。
   * 从前这里会静默回到 `文档/AgentHub`：用户在界面上切到自己的项目、关掉、再打开，
   * 项目就没了。
   */
  const wdOk = r.workdir === workdir
  if (!wdOk) fail++
  console.log(
    `  ${wdOk ? 'ok  ' : 'FAIL'} 工作目录回到了「上次记住的那个」（而不是默认的 文档/AgentHub）   ${r.workdir}`
  )

  if (r.shot) {
    const exists = existsSync(shotPath)
    const size = exists ? statSync(shotPath).size : 0
    console.log(`\n  截图：${shotPath}`)
    console.log(`        ${r.shot.width}×${r.shot.height}，${size} 字节${exists ? '' : '（文件不存在！）'}`)
    if (!exists || size < 2000) fail++
  }

  console.log(`\n─── 冒烟：${r.checks.length - fail} 通过 / ${fail} 失败 ───`)
  if (r.projectName) console.log(`页面显示的工作目录名：${r.projectName}`)

  cleanup()
  process.exit(fail === 0 && r.ok ? 0 : 1)
})
