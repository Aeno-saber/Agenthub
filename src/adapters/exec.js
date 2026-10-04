/**
 * 子进程执行层 —— 所有适配器共用的底层
 *
 * 本机实测踩过的坑都封在这里：
 *  1. Windows 上 .cmd 不能直接 spawn，必须走 shell
 *  2. cmd.exe 默认 GBK，输出中文会乱码 → 前置 chcp 65001
 *  3. prompt 放命令行参数会被引号/特殊字符坑 → 一律走 stdin
 *  4. 没有 stdin 输入时必须立刻 end()，否则 claude 会空等 3 秒
 *  5. 收工要按**进程树**（shell:true 起的 child 是 cmd.exe，kill 它带不走真正的 CLI）
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

import { elide } from '../util/text.js'

// elide 的实现放在 src/util/text.js —— engine 也要用它（上游产出截断），
// 不能让 engine 反向依赖 adapters。这里重导出，保持适配器们的既有 import 不变。
export { elide }

const IS_WIN = process.platform === 'win32'

function quote(s) {
  const str = String(s)
  return /[\s"]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str
}

/**
 * 构造最终要交给 shell 的命令行
 */
export function buildCommandLine(command, args = []) {
  const parts = []
  if (IS_WIN) parts.push('chcp 65001 >nul &')
  parts.push(quote(command))
  for (const a of args) parts.push(quote(a))
  return parts.join(' ')
}

/**
 * 把"追加的环境变量"合进当前环境。
 *
 * 规则（三条都是踩出来的）：
 *  1. 值是 `null`/`undefined` → **从环境里删掉**。用途是"把继承来的同名变量摘干净" ——
 *     比如父进程里就设了 `DSH_PERMISSION_MODE=full`，成员想跑只读档时必须能把它去掉。
 *     直接 `{...process.env, X: null}` 会把 null 交给 spawn，Node 会因非字符串值报错。
 *  2. 值统一 `String()` 化。配置里写成数字（`FOO: 1`）是很自然的写法，但 spawn 只吃字符串。
 *  3. 键名保持原样（Windows 的环境变量名不区分大小写，但**不**改名以免破坏 POSIX 成员的约定）。
 */
function mergeEnv(extra) {
  const out = { ...process.env }
  if (!extra || typeof extra !== 'object') return out
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) delete out[k]
    else out[k] = String(v)
  }
  return out
}

/**
 * 执行一次成员调用
 *
 * @param {string} command 可执行文件（Windows 上要带 .cmd/.exe）
 * @param {string[]} args
 * @param {object} opts
 * @param {string} [opts.input]   写进 stdin 的内容（通常是 prompt）
 * @param {string} [opts.workdir] 工作目录
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.env]     追加的环境变量
 * @param {(line:string)=>boolean} [opts.stopWhen]
 *        每收到 stdout 的一**整行**就调一次；返回 true 表示"这一步已经出结果了"，
 *        立刻按进程树收工，并把 `stoppedEarly: true` 报回去。
 *        为什么需要它：实测 codex 答完一轮之后，进程还要再挂约 10 秒才自己退出 ——
 *        那 10 秒纯属白等，而这里的调用方（成员调用）是串在用户等待路径上的。
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, durationMs:number, timedOut:boolean, stoppedEarly:boolean, spawnFailed?:boolean, command:string}>}
 */
export function execMember(command, args = [], opts = {}) {
  const { input, workdir, timeoutMs = 300000, env, stopWhen } = opts
  const full = buildCommandLine(command, args)
  const childEnv = mergeEnv(env)

  return new Promise((resolve) => {
    const t0 = Date.now()
    let child

    try {
      child = spawn(full, [], {
        shell: true,
        windowsHide: true,
        cwd: workdir || process.cwd(),
        env: childEnv,
      })
    } catch (err) {
      return resolve({
        exitCode: null, stdout: '', stderr: String(err),
        durationMs: Date.now() - t0, timedOut: false, stoppedEarly: false, spawnFailed: true, command: full,
      })
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stoppedEarly = false
    let settled = false
    // stopWhen 的逐行扫描游标 —— 见 scanForStop
    let scanned = 0

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }

    /*
     * 按**进程树**收工。
     *
     * 为什么不能只 child.kill()：shell:true 起的 child 是 cmd.exe，真正的 CLI 是它的子进程。
     * 杀掉 cmd.exe 带不走 CLI —— 实测留下一个 138MB 的 codex.exe 挂在后台，而它还会向上找
     * 正在运行的 Codex 桌面版，两边互相干扰。实测 taskkill /T /F 一条命令能把整棵树收干净
     * （turn 结束 2017ms → close 2249ms，无残留）。
     * 兜底仍留 child.kill()：taskkill 在一些受管环境里会被安全策略拦掉。
     */
    const stopTree = () => {
      if (IS_WIN && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
          return
        } catch {}
      }
      try { child.kill() } catch {}
    }

    /*
     * stopWhen 的逐行扫描。
     *
     * 只在**整行**凑齐之后才判定（游标 scanned 记住已消费到哪），半行不判 ——
     * 判定函数拿到半行 JSON 必然解析失败，那正是"安静地不生效"。
     * 扫描挂在已有的那个 stdout 监听器里，**不另加监听器**：两个监听器各存各的缓冲与游标，
     * 早晚分叉，而且分叉的时机取决于分片大小，最难复现。
     */
    const scanForStop = () => {
      if (!stopWhen) return
      while (!stoppedEarly && !settled) {
        const nl = stdout.indexOf('\n', scanned)
        if (nl === -1) return
        const line = stdout.slice(scanned, nl).replace(/\r$/, '')
        scanned = nl + 1
        let hit = false
        try { hit = !!stopWhen(line) } catch { hit = false }
        if (!hit) continue
        stoppedEarly = true
        stopTree()
        return
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      stopTree()
    }, timeoutMs)

    child.stdout?.on('data', (d) => { stdout += d; scanForStop() })
    child.stderr?.on('data', (d) => { stderr += d })

    if (input !== undefined && input !== null) {
      child.stdin.write(input)
      child.stdin.end()
    } else {
      // 关键：不给 stdin 数据也要立刻关掉，否则部分 CLI 会空等
      try { child.stdin.end() } catch {}
    }

    child.on('close', (code) => {
      finish({
        exitCode: code, stdout, stderr,
        durationMs: Date.now() - t0, timedOut, stoppedEarly, command: full,
      })
    })

    child.on('error', (err) => {
      finish({
        exitCode: null, stdout, stderr: stderr + String(err),
        durationMs: Date.now() - t0, timedOut: false, stoppedEarly, spawnFailed: true, command: full,
      })
    })
  })
}

/**
 * 过滤掉本机安全策略产生的噪音告警（reg.exe 被拦等），避免污染错误诊断
 */
export function cleanStderr(stderr = '') {
  return stderr
    .split('\n')
    .filter((l) => !/reg\.exe|Program Blacklist|blocked by security policy|cannot be approved/i.test(l))
    .join('\n')
    .trim()
}
