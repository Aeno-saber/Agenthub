#!/usr/bin/env node
/**
 * AgentHub MCP Server
 *
 * 作用：把 AgentHub 引擎暴露成 MCP 工具，供 WorkBuddy 等 MCP 客户端调用。
 * 这就是整个架构的地基 —— WorkBuddy 没有 CLI，只能反过来让它当 MCP 客户端，
 * 由它来驱动本引擎。本文件是那个"反向接口"。
 *
 * 两条硬约束（踩过坑才写的）：
 *  1. **零依赖**：手写 JSON-RPC over stdio（换行分隔），不装 @modelcontextprotocol/sdk。
 *     本机装了火绒，npm install 会被拖到几十分钟甚至半装；而 MCP 的 stdio 协议本身
 *     就是「一行一个 JSON-RPC 消息」，没有理由为它引入一棵依赖树。
 *  2. **stdout 只走协议，日志一律走 stderr**。往 stdout 打一行日志 = 客户端 JSON 解析失败，
 *     整个 server 直接失联，而且报错信息会非常不直观。
 *
 * 协议版本：回显客户端请求的版本（若在白名单内），否则回默认版本 —— 兼容性优先。
 */
import process from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRegistry } from '../src/adapters/index.js'
import { Orchestrator } from '../src/engine/orchestrator.js'
import { judgeOutput, describeQuality } from '../src/engine/quality.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 默认工作目录 = AgentHub 项目根。
 * 不用 process.cwd()：server 是被客户端拉起的，cwd 由客户端决定，
 * 是个不确定值 —— 拿它当默认值会让「文件落到哪」变得不可预测。
 * 调用方要别的目录，就显式传 workdir。
 */
const PROJECT_ROOT = resolve(__dirname, '..')

const SERVER_INFO = { name: 'agenthub', version: '0.1.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_PROTOCOL = '2025-06-18'

/** 日志只走 stderr —— stdout 是协议通道，一个字都不能多 */
const log = (...a) => process.stderr.write('[agenthub-mcp] ' + a.map(String).join(' ') + '\n')

const PERMISSION_ENUM = ['readonly', 'plan', 'execute', 'full']

const TOOLS = [
  {
    name: 'agenthub_list_members',
    description:
      '列出 AgentHub 中登记的全部 AI 成员及其真实可用性。可用性是启动子进程实测出来的（跑 --version），' +
      '不是读配置文件的 enabled 字段。返回每个成员的 id / 名称 / 是否可用 / 版本或不可用原因 / 能力标签 / 默认权限档。' +
      '不产生任何模型调用费用。与成员协作前应先调用它确认谁真的能用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agenthub_run_member',
    description:
      '让某一个 AI 成员单独执行一段提示词，并把它的产出原样返回。用于「单个成员独立使用」的场景。' +
      '返回内容包含成员名、状态、耗时、花费与 token 用量、以及它的完整产出。',
    inputSchema: {
      type: 'object',
      properties: {
        memberId: { type: 'string', description: '成员 id，例如 claude。取值为 agenthub_list_members 返回的 id。' },
        prompt: { type: 'string', description: '交给该成员的完整指令。指令要具体、可执行。' },
        role: { type: 'string', description: '可选。角色标签，会注入到系统提示。常用：代码主笔 / 评审 / 文档书写 / 测试 / 调研。' },
        permission: {
          type: 'string',
          enum: PERMISSION_ENUM,
          description: '可选。权限档位：readonly 只读 / plan 计划（默认）/ execute 执行（可改文件跑命令）/ full 全自动。',
        },
        workdir: { type: 'string', description: '可选。该成员的工作目录（绝对路径）。不填则用 AgentHub 项目根目录。' },
      },
      required: ['memberId', 'prompt'],
    },
  },
  {
    name: 'agenthub_run_plan',
    description:
      '执行一个多成员协同计划：子任务按 dependsOn 做依赖分层，同层并行执行，上游成员的产出会自动注入下游成员的提示词。' +
      '执行完返回完整运行轨迹（每个子任务派给了谁、耗时、花费、产出），并落盘存档。' +
      '这是「协同合作」的主入口 —— 主脑（调用方）负责拆解任务，本工具负责调度与串联。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务总目标。会写进每个子任务的上下文。' },
        subtasks: {
          type: 'array',
          description: '子任务列表。建议 2-6 个，不要过度拆分 —— 每次成员调用都有固定开销。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '子任务唯一 id，如 s1' },
              title: { type: 'string', description: '短标题' },
              memberId: { type: 'string', description: '执行该子任务的成员 id' },
              role: { type: 'string', description: '角色标签，如 代码主笔 / 评审 / 文档书写' },
              permission: { type: 'string', enum: PERMISSION_ENUM, description: '该子任务的权限档位' },
              prompt: { type: 'string', description: '给该成员的完整指令' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: '依赖的子任务 id 列表。有依赖则串行，无依赖则与同层并行。',
              },
            },
            required: ['id', 'memberId', 'prompt'],
          },
        },
        permission: { type: 'string', enum: PERMISSION_ENUM, description: '可选。所有子任务的默认权限档位，子任务自己的 permission 优先。' },
        budgetUsd: { type: 'number', description: '可选。整个任务的花费上限（美元）。超出后未执行的子任务会被标记失败。' },
        workdir: { type: 'string', description: '可选。工作目录（绝对路径）。不填则用 AgentHub 项目根目录。' },
      },
      required: ['goal', 'subtasks'],
    },
  },
]

const asText = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

const money = (usd) => '$' + Number(usd || 0).toFixed(4)

/** 实际执行工具调用 */
async function callTool(name, args) {
  const registry = loadRegistry()

  switch (name) {
    case 'agenthub_list_members': {
      const probed = await registry.probeAll({ force: true })
      const members = registry.list().map((a) => {
        const r = probed[a.id] || {}
        return {
          id: a.id,
          name: a.name,
          enabled: a.isEnabled,
          available: !!r.available,
          detail: r.available ? r.version || '可用' : r.reason || '未知原因',
          capabilities: a.capabilities,
          defaultPermission: a.spec.defaultPermission || 'plan',
          installHint: r.available ? undefined : a.spec.installHint,
        }
      })
      return asText(
        JSON.stringify(
          {
            orchestrator: registry.orchestrator,
            availableCount: members.filter((m) => m.available).length,
            totalCount: members.length,
            members,
          },
          null,
          2
        )
      )
    }

    case 'agenthub_run_member': {
      const { memberId, prompt, role, permission, workdir } = args
      if (!memberId) throw new Error('缺少 memberId')
      if (!prompt) throw new Error('缺少 prompt')

      const adapter = registry.get(memberId)
      if (!adapter) {
        throw new Error(
          `未知成员：${memberId}。现有成员：${registry.list().map((a) => a.id).join(', ')}`
        )
      }

      const r = await adapter.run({
        prompt,
        role,
        permission: permission || adapter.spec.defaultPermission || 'plan',
        workdir: workdir ? resolve(workdir) : PROJECT_ROOT,
      })

      // status=ok 只是进程正常退出，不代表产出可用 —— 单独判一次
      const quality = judgeOutput(r.text, { status: r.status })
      const suspect = quality.level === 'suspect'

      const header = [
        `成员：${adapter.name}（${adapter.id}）`,
        `状态：${r.status}${suspect ? '  ⚠️ 产出可疑' : ''}`,
        `权限：${permission || adapter.spec.defaultPermission || 'plan'}`,
        `耗时：${r.raw?.durationMs ?? 0}ms`,
        `花费：${money(r.cost?.usd)}（输入 ${r.cost?.inputTokens ?? '?'} / 输出 ${r.cost?.outputTokens ?? '?'} tokens）`,
        ...(suspect ? [`⚠️ ${quality.note}`] : []),
      ].join('\n')

      return asText(`${header}\n\n--- 产出 ---\n${r.text}`, r.status !== 'ok')
    }

    case 'agenthub_run_plan': {
      const { goal, subtasks, permission, budgetUsd, workdir } = args
      if (!goal) throw new Error('缺少 goal')
      if (!Array.isArray(subtasks) || !subtasks.length) throw new Error('缺少 subtasks（不能为空数组）')

      const plan = {
        goal,
        subtasks: subtasks.map((s) => ({ ...s, dependsOn: s.dependsOn || [] })),
      }

      const orch = new Orchestrator(registry, {
        permission: permission || 'plan',
        totalBudgetUsd: budgetUsd ?? null,
      })
      const wd = workdir ? resolve(workdir) : PROJECT_ROOT

      const pre = orch.dryRun(plan)
      if (!pre.ok) {
        return asText('计划校验失败，未执行：\n' + pre.errors.map((e) => '  - ' + e).join('\n'), true)
      }

      const { trace } = await orch.run(plan, { workdir: wd })
      const saved = trace.save(join(wd, '.agenthub', 'runs'), `mcp-${Date.now()}`)

      return asText(
        trace.toMarkdown() +
          `\n\n---\n轨迹已存档：\n  ${saved.mdPath}\n  ${saved.jsonPath}\n（工作目录 ${wd}）`,
        trace.summary.failedCount > 0
      )
    }

    default:
      throw new Error(`未知工具：${name}`)
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg) {
  const { id, method, params } = msg
  const isNotification = id === undefined || id === null

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'AgentHub 是本地多 agent 协同引擎。先用 agenthub_list_members 确认哪些成员真的可用，' +
            '再用 agenthub_run_member 单点调用、或用 agenthub_run_plan 做多成员协同。' +
            '拆解任务由你（主脑）负责，本引擎只负责调度与串联。',
        })
        return
      }

      // 客户端握完手会发这条通知，不需要响应
      case 'notifications/initialized':
      case 'initialized':
        log('客户端已初始化')
        return

      case 'ping':
        reply(id, {})
        return

      case 'tools/list':
        reply(id, { tools: TOOLS })
        return

      case 'tools/call': {
        const { name, arguments: args } = params || {}
        const out = await callTool(name, args || {})
        reply(id, out)
        return
      }

      default:
        if (!isNotification) replyError(id, -32601, `未实现的方法：${method}`)
        return
    }
  } catch (e) {
    log('处理失败：', method, e.stack || e.message)
    if (!isNotification) replyError(id, -32603, e.message || String(e))
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log('收到无法解析的消息（已忽略）：', line.slice(0, 200))
      continue
    }
    // 刻意不 await：让长任务（跑成员）不阻塞读流，响应靠 id 匹配
    handle(msg)
  }
})

process.stdin.on('end', () => {
  log('stdin 关闭，退出')
  process.exit(0)
})

log(`已启动 · ${SERVER_INFO.name} v${SERVER_INFO.version} · pid ${process.pid} · ${TOOLS.length} 个工具`)
