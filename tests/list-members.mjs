#!/usr/bin/env node
/**
 * 等价于 MCP 工具 `agenthub_list_members`，但不经过 MCP 通道。
 *
 * 用途：不需要启动客户端就能看「谁真的能用」。
 * 注意 `tests/probe.mjs` 是旧脚本，用裸命令名（cursor-agent/qodercli/...）探测，
 * 在 PATH 里没有这些命令时必然全 FAIL —— 不代表配置错。真实探测必须走
 * members.json 里的绝对路径 `command`，也就是本脚本的做法。
 */
import { loadRegistry } from '../src/adapters/index.js'

const registry = loadRegistry()
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
  }
})

const payload = {
  orchestrator: registry.orchestrator,
  availableCount: members.filter((m) => m.available).length,
  totalCount: members.length,
  members,
}

console.log(JSON.stringify(payload, null, 2))
