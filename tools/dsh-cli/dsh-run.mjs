#!/usr/bin/env node
/**
 * DSH 一次性调用的包装层 —— 存在的唯一理由是**绕开 cmd.exe 的换行截断**。
 *
 * ## 为什么需要它
 *
 * DSH 的可编程入口是 `dsh --profile headless "<任务>"`（实测 0.1.0-rc.6）：
 * 答一个任务、打印最终回复、退出。干净利落，但它只接受**位置参数**，
 * 既没有 `--file` 也没有 stdin 模式。
 *
 * 而 AgentHub 的 `execMember()` **一律 `shell: true`**（为了跑 .cmd，还前置了
 * `chcp 65001 >nul &`）。于是多行 prompt 从这里过去会被 cmd.exe 就地截断 ——
 * 成员只收到第一行，**退出码仍然是 0**。这个坑本仓库付过学费（见 generic.js 的文件头
 * 和 docs/05）：trae 当初就是因为它才只能走"落临时文件 + 传路径"那条路。
 *
 * 这个包装层把链路改成：
 *
 *     AgentHub(cmd.exe) → node dsh-run.mjs（从 stdin 读完整 prompt）
 *                        → spawn(node, [bin.js, '--profile','headless', prompt])
 *                           ↑ 不经 shell：单个 argv 元素，换行原样传给子进程
 *
 * 所以 prompt 走 **stdin** 进来（AgentHub 的 `promptMode: 'stdin'`），
 * 再作为**一个 argv 元素**交给 dsh —— 全程没有 shell 解析，多行不会断。
 *
 * ## 用法
 *
 *     node dsh-run.mjs --version      # 探活：透传给 dsh，不读 stdin、不花钱
 *     node dsh-run.mjs                # 从 stdin 读任务，执行一次 headless 调用
 *
 * `--version` 这一支是必须的：探活如果也走 headless，那每按一次界面上的「测试」
 * 就会真跑一个空任务 —— **既花钱又会因为空 prompt 得到一句"没收到任务"的回复**。
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

/** dsh 的 launcher。可用 DSH_BIN 覆盖（换 profile 目录时用） */
const DSH_BIN =
  process.env.DSH_BIN ||
  'C:\\Users\\deno\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

/**
 * 用**当前这个 node**（`process.execPath`）去拉起 dsh。
 *
 * 不写死 node 路径：AgentHub 是用哪个 node 启动本包装层的，就用哪个去跑 dsh。
 * 本机托管 node 的目录名带版本后缀（`22.22.2-3`），写死迟早对不上。
 */
const NODE = process.execPath

/** 把完整 prompt 作为**一个 argv 元素**交给 dsh headless —— 不经 shell，换行不会断 */
function spawnWithPrompt(prompt) {
  const child = spawn(NODE, [DSH_BIN, '--profile', 'headless', prompt], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (e) => {
    process.stderr.write(`无法启动 dsh：${e.message}\n`)
    process.exit(1)
  })
}

// ── 入口 ──
const passthrough = process.argv.slice(2)
if (passthrough.length) {
  // 探活：参数原样透传给 dsh（`--version` 之类），不读 stdin、不产生模型调用
  const child = spawn(NODE, [DSH_BIN, ...passthrough], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (e) => {
    process.stderr.write(`无法启动 dsh：${e.message}\n`)
    process.exit(1)
  })
} else {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { prompt += c })
  process.stdin.on('end', () => spawnWithPrompt(prompt.trim()))
}
