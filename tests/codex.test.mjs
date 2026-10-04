/**
 * Codex 适配器的解析与判定测试
 *
 * 运行：node --test tests/codex.test.mjs
 *
 * 为什么单独测这一层：
 * `codex exec --json` 的输出是 JSONL，而且里面**同一份样本同时含有**
 * 「一条 error 项」和「一次完全成功的运行」—— 那次运行文件改对了、退出码 0，
 * 却带着一条 `Model metadata for ... not found` 的 error 项（模型元数据告警）。
 * 判定只要写成"见到 error 就失败"，**每一次成功运行都会被记成 failed**，
 * 而且不会报错、不会崩，只是报告里的结论全是错的。**安静失效的东西必须直接测。**
 *
 * 所以判定被抽成纯函数 `resolveOutcome()`，解析抽成 `parseCodexJsonl()`，
 * 下面的样本取自真实运行（tests/fixtures/codex-exec-ok.jsonl 与 codex-exec-failed.jsonl），
 * 字段名与取值都是 codex 实际吐出来的，不是照文档编的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  parseCodexJsonl,
  codexResultText,
  resolveOutcome,
  unwrapErrorMessage,
  isTurnEndLine,
  expandEnvVars,
  expandGlob,
  resolveCodexCommand,
  precheckAuth,
  codexAuthFile,
  CodexAdapter,
} from '../src/adapters/codex.js'
import { BaseAdapter } from '../src/adapters/base.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

/** 真实成功运行：创建了 hello.txt、跑了一条命令、退出码 0，但**带着一条 error 项** */
const OK = fixture('codex-exec-ok.jsonl')
/** 真实失败运行：模型名不存在 → turn 级 error + turn.failed + 退出码 1 */
const FAILED = fixture('codex-exec-failed.jsonl')

// ══════════════════════════════════════════ 解析 JSONL

test('解析真实成功样本：thread_id / 两条 agent_message / 一条告警', () => {
  const p = parseCodexJsonl(OK)
  assert.match(p.threadId, /^[0-9a-f-]{20,}$/)
  assert.equal(p.messages.length, 2, '样本里有「我先建个文件」和最终结论两条')
  assert.equal(p.notes.length, 1, 'item 级 error 是告警，收进 notes')
  assert.deepEqual(p.turnErrors, [], '成功运行不许有 turn 级错误')
  assert.equal(p.sawTurnCompleted, true)
  assert.equal(p.turnFailed, false)
})

test('★ 交付正文取最后一条 agent_message，不把过程话术拼进来', () => {
  const p = parseCodexJsonl(OK)
  const text = codexResultText(p)
  assert.match(text, /hello\.txt/)
  assert.ok(!text.includes('I will create the file'), '第一条是过程话术，不该出现在交付里：' + text)
})

test('★ 同一个 item 出现两次（started + completed）—— 必须按 id 去重', () => {
  const p = parseCodexJsonl(OK)
  assert.equal(p.commands.length, 1, '样本里那条命令有 started 和 completed 两条事件，只能算一条')
  assert.equal(p.commands[0].exitCode, 0)
  assert.match(p.commands[0].output, /hi from codex/)
})

test('解析真实失败样本：turn.failed + turn 级 error，且都不是 item 级', () => {
  const p = parseCodexJsonl(FAILED)
  assert.equal(p.turnFailed, true)
  assert.ok(p.turnErrors.length >= 1)
  assert.equal(p.sawTurnCompleted, false, '失败的那次没有 turn.completed')
})

test('非 JSON 行不炸、也不丢 —— 收进 unparsed（stdin 模式会多印一行提示）', () => {
  const p = parseCodexJsonl('Reading additional input from stdin...\n{"type":"turn.started"}\n不是 JSON\n')
  assert.equal(p.unparsed.length, 2)
  assert.equal(p.messages.length, 0)
})

test('空输入 / 垃圾输入不炸', () => {
  for (const v of ['', '   ', 'not json at all', '\n\n']) {
    const p = parseCodexJsonl(v)
    assert.equal(p.messages.length, 0)
    assert.equal(codexResultText(p), '')
  }
  assert.equal(codexResultText(null), '')
})

// ══════════════════════════════════════════ 判定

test('★★ 成功样本（退出码 0，且含一条 item 级 error）→ 必须判 ok', () => {
  const p = parseCodexJsonl(OK)
  assert.equal(resolveOutcome(p, { exitCode: 0 }).status, 'ok')
})

test('★ 只有 item 级 error、没有 turn 级信号时，即使退出码非 0 也不误判成 turn 错误', () => {
  // 退出码才是这一档的判据，errorKind 必须是 exit_code 而不是 turn_failed
  const p = parseCodexJsonl(OK)
  const o = resolveOutcome(p, { exitCode: 1 })
  assert.equal(o.status, 'failed')
  assert.equal(o.errorKind, 'exit_code')
})

test('★★ 失败样本 → failed + turn_failed + 可读的错误原因', () => {
  const p = parseCodexJsonl(FAILED)
  const o = resolveOutcome(p, { exitCode: 1 })
  assert.equal(o.status, 'failed')
  assert.equal(o.errorKind, 'turn_failed')
  assert.match(o.errorLine, /supported API model names/)
  assert.ok(!o.errorLine.includes('{'), '错误原因必须拆成人话，不能带那层 JSON 壳：' + o.errorLine)
})

test('超时单独一档：不是 failed —— 两者的处置完全不同', () => {
  const o = resolveOutcome(parseCodexJsonl(OK), { exitCode: null, timedOut: true, durationMs: 65000 })
  assert.equal(o.status, 'timeout')
  assert.match(o.errorLine, /65s/)
})

// ══════════════════════════════════════════ 答完即收工

test('★★ 我们自己按树收工时，非 0 退出码不算失败', () => {
  /*
   * 那个非 0 退出码是 taskkill 造成的，不是成员报的错。当失败处理的话，
   * 每一次"答完就收工"的正常运行都会被记成 failed —— 安静地记错，报表全废。
   */
  const o = resolveOutcome(parseCodexJsonl(OK), { exitCode: 1, stoppedEarly: true })
  assert.equal(o.status, 'ok')
  assert.equal(o.errorKind, null)
})

test('★ stoppedEarly 不能吞掉真的 turn 级失败', () => {
  const o = resolveOutcome(parseCodexJsonl(FAILED), { exitCode: 1, stoppedEarly: true })
  assert.equal(o.status, 'failed')
  assert.equal(o.errorKind, 'turn_failed')
})

test('没标 stoppedEarly 时，非 0 退出码照旧判失败（不许把闸门放大）', () => {
  const o = resolveOutcome(parseCodexJsonl(OK), { exitCode: 1 })
  assert.equal(o.status, 'failed')
  assert.equal(o.errorKind, 'exit_code')
})

test('★ isTurnEndLine：只认 type 字段，正文里出现同样的字样不算收尾', () => {
  assert.equal(isTurnEndLine('{"type":"turn.completed","usage":{"input_tokens":1}}'), true)
  assert.equal(isTurnEndLine('{"type": "turn.failed", "error": {"message":"x"}}'), true)
  assert.equal(isTurnEndLine('{"type":"turn.started"}'), false)
  // 下面这条是关键：正文里出现 turn.completed 是可能的，
  // 拿 includes 一类的写法去判就会在这里提前收工，把真正的交付切掉
  const fake = '{"type":"item.completed","item":{"type":"agent_message","text":"看到 turn.completed 就停"}}'
  assert.equal(isTurnEndLine(fake), false, '不能拿正文当收尾信号：' + fake)
})

test('unwrapErrorMessage：拆得开就拆，拆不开原样给', () => {
  assert.equal(unwrapErrorMessage('{"error":{"message":"boom"}}'), 'boom')
  assert.equal(unwrapErrorMessage('{"message":"plain"}'), 'plain')
  assert.equal(unwrapErrorMessage('就是一句话'), '就是一句话')
  assert.equal(unwrapErrorMessage(null), '')
})

// ══════════════════════════════════════════ 可执行文件定位

/**
 * 一个够用的假 fs：只认「哪些目录存在、各自列得出谁、谁是文件」。
 *
 * ⚠️ 第一版写错了，值得记一句：它把 readdirSync 的返回值直接当目录，
 * 于是 statSync 对子目录抛 ENOENT、通配一个都钻不进去 —— 测试确实红了，
 * 但红的是**假 fs 不够真**，不是被测代码错。假件本身也得能表达"这是个目录"。
 */
function fakeFs({ dirs = {}, files = {} } = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const children = new Map(Object.entries(dirs).map(([k, v]) => [norm(k), v]))
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  const dirSet = new Set()
  for (const [k, names] of children) {
    dirSet.add(norm(k))
    for (const name of names) dirSet.add(norm(k) + '/' + name)
  }
  return {
    existsSync: (p) => dirSet.has(norm(p)) || fileMap.has(norm(p)),
    readdirSync: (p) => children.get(norm(p)) || [],
    statSync: (p) => {
      const n = norm(p)
      // 文件优先：同一个名字既被列在目录里、又在文件表里时按文件算（那正是"不是目录"）
      if (fileMap.has(n)) return { isDirectory: () => false, isFile: () => true, mtimeMs: fileMap.get(n) }
      if (dirSet.has(n)) return { isDirectory: () => true, isFile: () => false, mtimeMs: 0 }
      throw new Error('ENOENT ' + p)
    },
  }
}

const BIN = 'C:/Users/u/AppData/Local/OpenAI/Codex/bin'
const spec = { commandSearch: ['%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe'] }

test('展开 %VAR%：认不出来就原样留着（宁可不命中，也不许误命中）', () => {
  assert.equal(expandEnvVars('%LOCALAPPDATA%\\x', { LOCALAPPDATA: 'C:\\L' }), 'C:\\L\\x')
  assert.equal(expandEnvVars('%NOPE%\\x', {}), '%NOPE%\\x')
})

test('★★ 哈希目录会变：配置里那份失效后，按 mtime 取最新的那个自愈', () => {
  const fs = fakeFs({
    dirs: { [BIN]: ['oldhash', 'newhash'] },
    files: {
      [BIN + '/oldhash/codex.exe']: 1000,
      [BIN + '/newhash/codex.exe']: 2000,
    },
  })
  const r = resolveCodexCommand(spec, { env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, fs })
  assert.equal(r.source, 'search')
  assert.match(r.command.replace(/\\/g, '/'), /newhash\/codex\.exe$/)
  assert.equal(r.candidates.length, 2)
})

test('配置里写死的路径**还存在**时优先用它（用户显式指定优先于搜索）', () => {
  const fs = fakeFs({
    dirs: { [BIN]: ['hash'] },
    files: { [BIN + '/hash/codex.exe']: 1, 'C:/pinned/codex.exe': 1 },
  })
  const r = resolveCodexCommand({ ...spec, command: 'C:\\pinned\\codex.exe' }, { env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, fs })
  assert.equal(r.source, 'config')
  assert.equal(r.command, 'C:\\pinned\\codex.exe')
})

test('都不命中 → fallback 到 PATH 里的 codex（不抛异常，让 spawn 去报错）', () => {
  const r = resolveCodexCommand({ command: 'C:\\gone\\codex.exe', commandSearch: [] }, { env: {}, fs: fakeFs() })
  assert.equal(r.source, 'fallback')
})

test('通配只吃目录：同名文件不会被当成目录钻进去', () => {
  const fs = fakeFs({ dirs: { [BIN]: ['not-a-dir'] }, files: { [BIN + '/not-a-dir']: 5 } })
  const hits = expandGlob('%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe', { env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, fs })
  assert.deepEqual(hits, [])
})

// ══════════════════════════════════════════ 登录态前置检查

test('★ 没有凭据 → 探活前就挡下来，并说清要跑 codex login', () => {
  const r = precheckAuth({}, { USERPROFILE: 'C:\\Users\\u' }, fakeFs())
  assert.ok(r && r.available === false)
  assert.match(r.reason, /codex login/)
})

test('auth.json 在 → 放行', () => {
  const fs = fakeFs({ dirs: { 'C:/Users/u/.codex': [] }, files: { 'C:/Users/u/.codex/auth.json': 1 } })
  assert.equal(precheckAuth({}, { USERPROFILE: 'C:\\Users\\u' }, fs), null)
})

test('用 API Key 登录的也要放行（不能只认 auth.json）', () => {
  assert.equal(precheckAuth({}, { OPENAI_API_KEY: 'sk-x', USERPROFILE: 'C:\\Users\\u' }, fakeFs()), null)
  assert.equal(precheckAuth({ env: { CODEX_API_KEY: 'sk-y' } }, { USERPROFILE: 'C:\\Users\\u' }, fakeFs()), null)
})

test('CODEX_HOME 优先于 ~/.codex', () => {
  assert.equal(
    codexAuthFile({ CODEX_HOME: 'D:\\codexhome', USERPROFILE: 'C:\\Users\\u' }).replace(/\\/g, '/'),
    'D:/codexhome/auth.json'
  )
})

test('★ 声明自己是"流式输出"——规划提示词的两条上限靠它放开', () => {
  /*
   * codex 的 `exec --json` 是逐事件交回来的，不存在"输出写到一半被截断"。
   * 规划者那两条防截断的上限（子任务 2-6 个、prompt ≤150 字）对它没有意义，
   * 所以引擎不硬编码成员 id，而是问适配器自己 —— 这条声明就是那个接口。
   *
   * 断言方向是**刻意反的**：默认必须保守（没声明 = 会截断），
   * 免得将来有人复制一个适配器忘了改，悄悄把上限放开。
   */
  assert.equal(new CodexAdapter({ id: 'codex' }).streamsStructuredOutput, true)
  assert.equal(new BaseAdapter({ id: 'plain' }).streamsStructuredOutput, false,
    '基类默认必须是 false（没声明就当会截断）')
})