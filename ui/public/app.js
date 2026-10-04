/**
 * AgentHub 前端主逻辑（原生 ESM，零依赖）
 *
 * ## 与后端的边界
 *
 * 后端（ui/server.js）只做三件事：探活、转发指令、把引擎的 onEvent 推成 SSE。
 * **所有状态都在前端**，后端是无状态的 —— 所以刷新页面不会丢会话（见 loadState/saveState）。
 *
 * ## 为什么要「整块重渲染 + 事件委托」而不是虚拟 DOM
 *
 * 这个界面没有高频更新（一次 SSE 事件最多几十毫秒一条），整块重渲染足够快。
 * 代价是两个必须处理副作用，代码里对应两处实现：
 *   1. **焦点与光标**：重渲染会把 textarea 打回原样 → rerenderMain() 里保存/恢复
 *   2. **草稿**：重渲染后 textarea 的 value 来自 state.drafts，不是 DOM
 * 不处理这两个，打字时会跳光标、丢输入 —— 这是"能用"和"用起来别扭"的分界线。
 *
 * ## 三种主区视图
 *
 *   blank  空状态
 *   chat   会话（1 个成员 = ChatGPT 单栏；≥2 个成员 = 并排分屏）
 *   task   协同任务（子任务卡片链 + 实时日志）
 */

// ══════════════════════════════════════════ 小工具

const $ = (sel, root = document) => root.querySelector(sel)
const byId = (id) => document.getElementById(id)

/** 所有插进 innerHTML 的动态文本都要过这里 —— agent 的输出里带 < > & 是常态 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

const ts = () => new Date().toTimeString().slice(0, 8)
const uid = (p = 'x') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function fmtMs(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtTokens(n) {
  if (!n) return ''
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function listText(s, n) {
  if (!s) return ''
  const flat = String(s).replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

// ══════════════════════════════════════════ 权限档

const PERMS = [
  { id: 'readonly', label: '只读', hint: '能读，不改文件、不跑命令' },
  { id: 'plan', label: '计划', hint: '能读能规划，不动文件' },
  { id: 'execute', label: '执行', hint: '可改文件、可跑命令' },
  { id: 'full', label: '全自动', hint: '跳过确认 —— 危险' },
]
const permLabel = (id) => PERMS.find((p) => p.id === id)?.label || id
const permHint = (id) => PERMS.find((p) => p.id === id)?.hint || ''

/**
 * 「这一档在这个成员身上到底生效了吗」—— 不生效就直说。
 *
 * 实测（2026-09-29 审计 `node tests/perm-audit.mjs`）：trae 的 readonly 与 plan
 * 传下去的参数**一模一样**（都是空），dsh 更是四档全空。而这里原本一律显示
 * 「只读 · 能读，不改文件、不跑命令」—— 那是界面的承诺，不是成员的事实。
 *
 * 两种情况分开说，因为对用户的意义完全不同：
 *  - 成员不操作本地文件（豆包是 REST 成员）→ 档位对它本来就没区别，中性说明即可；
 *  - 成员操作本地文件、但这一档没有专属参数 → **警告**，用户以为自己被约束住了，
 *    其实没有。引擎侧会因此把它当"可能写"来采集（见 quality.js 的 memberMayWrite）。
 *
 * @param {object} m 成员（/api/members 返回，带 permissionSupport / writeCapable）
 * @param {string} level 当前档位
 */
function permCaveat(m, level) {
  if (!m) return ''
  if (m.writeCapable === false) return '该成员不操作本地文件，档位对它没有区别'
  const support = m.permissionSupport
  if (support && support[level] === false) {
    return `⚠️ ${permLabel(level)}档在此成员上没有对应参数，实际不受这一档约束`
  }
  return ''
}

/**
 * 协同任务弹窗里的档位提示 —— 这一单里**哪些成员其实不吃这一档**。
 *
 * 单个成员对话的提示在 composer-hint（`permCaveat`），但**协同任务才是真正
 * 一次派给多个成员的入口**：用户在这里选「只读」，而计划里可能恰好有 trae
 * （只读档没有参数）—— 不说的话，用户以为自己给整单上了锁。
 *
 * 只列「操作本地文件、但这一档没有专属参数」的成员。
 * 不操作本地文件的（豆包）不列：档位对它本来就没区别，混在一起会稀释警告的分量。
 *
 * @param {object} plan 计划草稿（含 subtasks[].memberId）
 * @param {string} level 当前档位
 */
const planPermCaveat = (plan, level) => {
  const ids = [...new Set((plan?.subtasks || []).map((s) => s.memberId).filter(Boolean))]
  const blocked = ids.filter((id) => {
    const m = memberById(id)
    return m && m.writeCapable !== false && m.permissionSupport?.[level] === false
  })
  if (!blocked.length) return ''
  return `⚠️ ${blocked.map((id) => memberName(id)).join('、')} 没有「${permLabel(level)}」档对应的参数 —— 这一档对它们不生效`
}

// 计费口径。界面上**不能**再出现 `free` 这类假标签 —— 实测 qoder 每次调用都扣积分，
// 而它以前挂的正是 `free` 能力标签，这个标签还会进规划者提示词、影响派活（见 docs/05）。
const BILLING_SHORT = {
  subscription: '订阅内',
  credits: '按积分',
  tokens: '按 token',
  unknown: '未知',
}
const billingLabel = (b) => BILLING_SHORT[b] || '未知'

/*
 * 角色目录 —— 从 `/api/members` 的 `roles` 取，**前端不再自带一份**。
 *
 * 这里原来是 `const ROLES = [...]`，和服务端的 `rolePrompt()`、规划者提示词
 * 各写了一份，三份里有两份没有「执行者」—— 而它恰好是下面这个下拉框的默认值。
 * 于是最常见的一条路径（不动角色直接用默认）落到模型头上的只有一句
 * 「你在本次任务中承担的角色是：执行者」。真相源现在只有 `src/roles.js` 一处。
 *
 * ★ 刻意**不留**本地兜底副本：留了就等于把那份漂移请回来。
 *   代价是"目录还没加载出来"时下拉框只有当前那一个值 —— 而能走到拆解这一步
 *   必然已经连上服务端了，所以这条路径实际到不了。
 */
const roleList = () => state.roles || []
const roleInfo = (label) => roleList().find((r) => r.label === label) || null

/**
 * 这一步的角色要求，和这个成员的实际能力对得上吗？
 *
 * 两个判据是**独立**的，所以分开报：
 *   · `needs`     —— 角色需要的软能力标签（code / review / doc）
 *   · `write`     —— 这一步会不会改磁盘上的文件
 * 豆包同时踩中两个：它有能力 `doc`、但 `writeCapable: false`。
 * 把「写文档」派给它没问题，把「把文档写进仓库」派给它就是错的 ——
 * 这两种在标签上完全一样，只有 write 那一维能分开。
 *
 * 规划者的提示词里一直在提这件事（第 3/4 条），但**界面从来没把结论显示出来**：
 * 用户看到的是一张排得整整齐齐的计划表，看不出第 2 行其实派错了人。
 *
 * @returns {{ok:boolean, notes:string[]}} notes 是给人看的人话，不是错误码
 */
function roleFit(roleLabel, member) {
  const info = roleInfo(roleLabel)
  if (!info || !member) return { ok: true, notes: [] }
  const caps = member.capabilities || []
  const notes = []
  const missing = (info.needs || []).filter((n) => !caps.includes(n))
  if (missing.length) notes.push(`「${roleLabel}」需要 ${missing.join(' / ')} 能力，${member.name} 没有`)
  if (info.write && member.writeCapable === false) {
    notes.push(`「${roleLabel}」要改文件，但 ${member.name} 不操作本地文件`)
  }
  return { ok: !notes.length, notes }
}

/*
 * 失败策略 —— 一个子任务失败之后，剩下的活怎么办。
 *
 * 起因（2026-09-29 真跑，docs/05 第九节）：4 个步骤，s1/s2 成功、s3 失败、s4 是最终交付。
 * 老实现是"失败即停整单"，于是 s4 永不执行 —— 已经花掉的钱只换到两份中间产物。
 * 省钱的设计反而烧钱，所以把这个选择交到用户手里，并且默认值要选"不浪费也不说谎"的那一个。
 * 文案里的每条代价都写清楚，别让用户凭猜选。
 */
const FAILURE_POLICIES = [
  { id: 'skip-blocked', label: '只跳过被断链的', hint: '某一步挂了，只有依赖它的后续步骤不跑；不依赖失败结果的分支照常跑完（推荐）' },
  { id: 'salvage', label: '带缺口继续', hint: '谁都不跳过 —— 最终交付照样跑，但它的指令里会写明"缺了谁"，报告里也会标出不完整' },
  { id: 'abort', label: '失败即停整单', hint: '最省后续开销，但已经花掉的部分可能拿不到成品（就是 2026-09-29 那次翻车的策略）' },
]
const policyLabel = (id) => FAILURE_POLICIES.find((p) => p.id === id)?.label || '只跳过被断链的'
const policyHint = (id) => FAILURE_POLICIES.find((p) => p.id === id)?.hint || ''

/** 「未执行」的原因分类 —— 处置方式不同，所以界面上也要说清是哪一种 */
const skipKindLabel = (k) =>
  ({ blocked: '依赖断链', aborted: '策略中止整单', budget: '预算上限', user: '你已跳过' }[k] || '原因未记录')

/** 把引擎给的 skippedByKind 说成人话 */
function describeSkips(k = {}) {
  const parts = []
  if (k.blocked) parts.push(`${k.blocked} 条依赖断链`)
  if (k.aborted) parts.push(`${k.aborted} 条策略中止`)
  if (k.budget) parts.push(`${k.budget} 条预算上限`)
  if (k.user) parts.push(`${k.user} 条你主动跳过`)
  return parts.length ? parts.join('、') : '原因未记录'
}

// ══════════════════════════════════════════ 状态

const LS_KEY = 'agenthub.ui.v1'

/*
 * 「删除单条会话/任务前是否先弹确认」的偏好。
 *
 * ★ 为什么**单独一个键**，不并进上面 LS_KEY 的 slim：
 *   slim 存的是会话/任务**数据**，每次 saveState() 整份全量重写。偏好是另一类东西 ——
 *   生命周期不同、语义不同。混在一起的话，将来任何一次 slim 结构调整都可能顺手把它丢掉，
 *   而丢掉的表现是"确认框又回来了"：静默、不像 bug、没人会去查。
 *
 * ★ 为什么用「存 'off' / 不存」而不是「存 true/false」：
 *   默认值是**安全的那一侧**（确认）。不存任何东西 = 默认开，
 *   这样老用户升级上来时 localStorage 是干净的，也不必写一个 v1 迁移。
 *
 * ★ 为什么默认必须是"确认"：会话和任务只在本机 localStorage 里，删了没有回收站。
 *   这类偏好只能由用户**主动**关掉，不能由代码替他决定。
 */
const LS_ASK = 'agenthub.delconfirm.v1'

function askEnabled() {
  try { return localStorage.getItem(LS_ASK) !== 'off' } catch { return true }
}
function setAskEnabled(v) {
  try {
    if (v) localStorage.removeItem(LS_ASK)
    else localStorage.setItem(LS_ASK, 'off')
  } catch { /* 存不下（隐私模式/超配额）就只在本次会话生效，不打断删除动作 */ }
}

const state = {
  workdir: '',
  projectName: '',
  configPath: '',
  orchestrator: null,
  members: [],
  roles: [],           // 角色目录（服务端下发，见 roleList()）—— 唯一真相源在 src/roles.js
  envKeys: [],         // 允许填写的环境变量名（服务端白名单，前端不自己抄一份）
  probed: false,
  probing: false,

  permission: 'plan',
  // 失败策略：一个子任务失败后剩下的活怎么办。默认与引擎一致（skip-blocked）
  failurePolicy: 'skip-blocked',
  editorOpen: false,
  sidebarMini: false,
  // 首页「单独 / 协同」两个页签，默认单独 —— 见 renderHome() 的说明
  homeTab: 'solo',

  chats: [],
  tasks: [],
  active: { type: 'blank', id: null },

  drafts: {},        // `${chatId}:${memberId}` → 输入框草稿
  broadcast: {},     // chatId → 是否勾了「发给全部」

  treeDir: '.',
  editor: null,      // { path, original, mtimeMs, dirty }

  /*
   * 协同任务页左栏选中的子任务 id —— 决定右栏显示哪一步的问答。
   * null 表示"还没点过"，此时默认显示第一步（见 renderTaskView）。
   * 不落盘：它是"当前在看哪一步"，跟会话草稿一样属于临时视图状态。
   */
  pickedStep: null,

  /*
   * 工作台左栏勾选的分工（角色 label 数组）。空数组 = 不指定，交给规划者自己挑。
   * 不落盘：它和"这次想怎么拆"绑在一起，跟草稿同级；而且目录内容可能随版本变化，
   * 存到 localStorage 里的旧角色名再读回来会变成认不出的鬼角色。
   */
  _roles: [],
}

const memberById = (id) => state.members.find((m) => m.id === id)
const memberName = (id) => memberById(id)?.name || id
const activeChat = () => state.chats.find((c) => c.id === state.active.id)
const activeTask = () => state.tasks.find((t) => t.id === state.active.id)

// ── 持久化 ──
// 只存"下次打开还想看到"的东西。轨迹日志、SSE 中间态、草稿都是瞬态，不存。

function saveState() {
  try {
    const slim = {
      workdir: state.workdir,
      permission: state.permission,
      failurePolicy: state.failurePolicy,
      editorOpen: state.editorOpen,
      sidebarMini: state.sidebarMini,
      homeTab: state.homeTab,
      active: state.active,
      chats: state.chats.map((c) => ({
        id: c.id,
        title: c.title,
        memberIds: c.memberIds,
        lastStatus: c.lastStatus,
        threads: Object.fromEntries(
          Object.entries(c.threads).map(([k, v]) => [
            k,
            v.slice(-40).map((m) => ({ ...m, text: String(m.text || '').slice(0, 20000) })),
          ])
        ),
      })),
      tasks: state.tasks.map((t) => ({
        id: t.id,
        goal: t.goal,
        plan: t.plan,
        status: t.status,
        // 失败策略要跟着任务存 —— 事后看轨迹报告时才知道这份结果是按哪种策略跑出来的
        failurePolicy: t.failurePolicy,
        batches: t.batches,
        cards: t.cards,
        cardOrder: t.cardOrder,
        summary: t.summary,
        markdown: String(t.markdown || '').slice(0, 20000),
        logs: t.logs.slice(-200),
        startedAt: t.startedAt,
      })),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(slim))
  } catch { /* 超配额就算了，不该因为存不下而打断使用 */ }
}

/**
 * ★★ 把一份**存档里的**任务补齐成当前代码能直接渲染的形状。
 *
 * 为什么必须在**入口**做，而不是在用到的地方各写一个 `|| {}`：
 *
 * 存档是**上一个版本的代码**写的。老版本没有某个字段时，`JSON.stringify` 会
 * 干脆不写那个键 —— 读回来就是 `undefined`，而且**不会报错**，直到某一行直接下标访问它。
 * 2026-09-30 实测到的现场：一份没有 `cards` 的老任务，`renderTaskView` 里
 * `task.cards[picked]` 抛 `TypeError: Cannot read properties of undefined (reading 's1')`，
 * `render()` 中途断掉 —— `#main` 是空的，整个界面**看起来就是打不开**。
 * 更坏的是它**每次打开都崩**：`state.active` 也被存着，用户根本进不去界面去清存档。
 *
 * 全文件有 8 处以上读 `task.cards`（右栏详情、卡片弹窗、重跑、SSE 事件处理…），
 * 逐个补 `|| {}` 一定会漏，而且下一个新字段还会重演一遍。所以收在这一个地方：
 * **凡是进 state 的任务，先过这里。**
 */
function normalizeTask(t) {
  const task = (t && typeof t === 'object') ? t : {}
  // 计划：subtasks 是渲染左栏步骤与进度条的依据
  const plan = {
    goal: task.plan?.goal || task.goal || '',
    subtasks: Array.isArray(task.plan?.subtasks) ? task.plan.subtasks : [],
  }
  // 卡片：**这次崩的就是它**。新任务一定有（confirmTask 里写了 `cards: {}`），老任务可能没有
  const cards = (task.cards && typeof task.cards === 'object') ? task.cards : {}
  /*
   * 老存档可能**一张卡片都没存**。左栏的"一步"就是一张卡片（stepItem 里
   * `if (!card) return ''`），所以卡片全缺 = 左栏空的、右栏也点不开 ——
   * 用户打开一份老任务，看到的只有一个任务头，会以为这份记录坏了。
   *
   * 那就用计划里的步骤补一批空壳卡片：标题、派给谁、指令都从步骤上抄。
   * 状态按步骤自己记的（老存档里有时会有 `status`），**认不出就按「等待」** ——
   * 不确定的时候，"这一刻还没有结论"比编一个"已完成"安全得多。
   * 补出来的卡片只有展示用途，不参与执行（执行永远是从计划重新跑一遍）。
   */
  if (!Object.keys(cards).length && plan.subtasks.length) {
    for (const s of plan.subtasks) {
      if (!s || !s.id || cards[s.id]) continue
      cards[s.id] = {
        id: s.id,
        title: s.title || s.id,
        memberId: s.memberId,
        role: s.role,
        prompt: s.prompt || '',
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        status: ['wait', 'run', 'done', 'fail', 'skip'].includes(s.status) ? s.status : 'wait',
      }
    }
  }
  return {
    ...task,
    id: task.id || uid('t'),
    goal: task.goal || '',
    status: task.status || 'done',
    plan,
    cards,
    // 顺序：没有就退回计划里的步骤顺序（renderTaskView 也是这么兜的）
    cardOrder: Array.isArray(task.cardOrder) && task.cardOrder.length
      ? task.cardOrder
      : plan.subtasks.map((s) => s?.id).filter(Boolean),
    logs: Array.isArray(task.logs) ? task.logs : [],
    markdown: String(task.markdown || ''),
    summary: task.summary || null,
  }
}

/**
 * 会话也过一遍同样的坎。
 *
 * 少了 `threads` 的会话，轻则在 `chat.threads[mid]` 崩掉，重则**把保存整个弄坏**：
 * `saveState` 里 `Object.entries(c.threads)` 会抛，而那个 try/catch 是"超配额就算了"写的 ——
 * 于是用户之后所有的改动**一条都存不进去**，且没有任何提示。
 */
function normalizeChat(c) {
  const chat = (c && typeof c === 'object') ? c : {}
  return {
    ...chat,
    id: chat.id || uid('c'),
    title: chat.title || '未命名会话',
    memberIds: Array.isArray(chat.memberIds) ? chat.memberIds : [],
    threads: (chat.threads && typeof chat.threads === 'object') ? chat.threads : {},
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    Object.assign(state, {
      permission: s.permission || 'plan',
      // 存档里可能是旧版本（没有这个字段），也可能是手改过的值 —— 一律校验，不认就直接回默认
      failurePolicy: FAILURE_POLICIES.some((p) => p.id === s.failurePolicy) ? s.failurePolicy : 'skip-blocked',
      editorOpen: !!s.editorOpen,
      sidebarMini: !!s.sidebarMini,
      // 旧存档没有这个字段；手改成怪值一律回默认
      homeTab: s.homeTab === 'coop' ? 'coop' : 'solo',
      // ★ 两个数组都必须逐条补齐（见 normalizeTask / normalizeChat 上面的长注释）
      chats: (Array.isArray(s.chats) ? s.chats : []).map(normalizeChat),
      tasks: (Array.isArray(s.tasks) ? s.tasks : []).map(normalizeTask),
    })
    // 上次退出时正在跑的任务，这次打开只能是"已中断"
    for (const t of state.tasks) {
      if (t.status === 'running') t.status = 'interrupted'
    }
    if (s.active && (
      (s.active.type === 'chat' && state.chats.some((c) => c.id === s.active.id)) ||
      (s.active.type === 'task' && state.tasks.some((t) => t.id === s.active.id))
    )) state.active = { ...s.active }
  } catch { /* 存档坏了就当没有 */ }
}

// ══════════════════════════════════════════ API

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error === 'conflict' ? '文件冲突' : (json?.error || `HTTP ${res.status}`))
    err.status = res.status
    err.payload = json
    throw err
  }
  return json
}

/**
 * 用 fetch 读 SSE 流。
 *
 * 为什么不用 EventSource：EventSource 只支持 GET，而 /api/run 需要 POST 一个 plan 过去。
 * 所以手动切 chunk —— 注意 data 行可能被 TCP 切在两个 chunk 中间，必须缓冲到见到 \n\n 才解析。
 */
async function ssePost(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(t || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try { onEvent(JSON.parse(payload)) } catch { /* 坏帧跳过，不打断整条流 */ }
      }
    }
  }
}

// ══════════════════════════════════════════ toast

/*
 * kind 只有 'ok' / 'err' 两种（不传 = 中性）。
 * 这里把类名写成字面量而不是 `'toast' + kind`：拼出来的类名，样式覆盖检查器抽不到，
 * `.toast.ok` / `.toast.err` 会被一直误报成"死样式"。
 *
 * `action` = `{ label, act, data }`，在 toast 尾巴上挂一个按钮（目前只有「恢复确认」）。
 *
 * ★ 用 DOM 拼、**不用 innerHTML**：msg 里会带用户自己的会话名/任务名，
 *   走 innerHTML 等于把标题当 HTML 解析 —— 一条名字叫 `<img onerror=...>` 的会话
 *   就能执行脚本。`label` 同理，一律 textContent。
 * ★ 带按钮的 toast 活 9s 而不是 4.2s：一个刚看清就消失的按钮等于没有按钮，
 *   而它偏偏是「删除不再确认」那条偏好唯一的回头路。
 */
function toast(msg, kind = '', action = null) {
  const n = document.createElement('div')
  n.className = kind === 'err' ? 'toast err' : kind === 'ok' ? 'toast ok' : 'toast'

  const txt = document.createElement('span')
  txt.className = 'toast-msg'
  txt.textContent = msg
  n.appendChild(txt)

  if (action) {
    /*
     * 同一个动作的 toast 只留一条。
     *
     * 「恢复确认」跟着每一次删除冒出来，连着删三条就并排挂三个一模一样的按钮，
     * 而且点掉其中一个之后剩下的还杵在那儿、看着仍然能点 —— 点下去只是把已经开着的
     * 开关再开一遍。既然它们做的是同一件事（把那条全局偏好改回来），留最新的一条就够。
     */
    for (const old of byId('toastRoot').querySelectorAll(`.toast-act[data-act="${action.act}"]`)) {
      old.closest('.toast')?.remove()
    }
    const b = document.createElement('button')
    b.className = 'toast-act'
    b.textContent = action.label
    b.dataset.act = action.act
    for (const [k, v] of Object.entries(action.data || {})) b.dataset[k] = v
    n.appendChild(b)
  }

  byId('toastRoot').appendChild(n)
  setTimeout(() => n.remove(), action ? 9000 : kind === 'err' ? 9000 : 4200)
}

// ══════════════════════════════════════════ 渲染：重渲染骨架

/** 重渲染主区，同时把焦点和光标位置原样还回去 */
function rerenderMain() {
  const ae = document.activeElement
  const keep = (ae && byId('main')?.contains(ae) && /INPUT|TEXTAREA/.test(ae.tagName))
    ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd }
    : null

  // 滚动位置的保存/恢复已经收进 renderMain() —— 见那里的注释
  renderMain()

  if (keep) {
    const n = byId(keep.id)
    if (n) {
      n.focus()
      try { n.setSelectionRange(keep.s, keep.e) } catch { /* number 等类型不支持 */ }
    }
  }
}

/**
 * ★★ 最后一道防线：**渲染出错不许把整个界面变白**。
 *
 * `render()` 是一串同步调用，中间任何一个 `renderXxx` 抛异常，后面的全都不执行、
 * 异常冒到 `boot()` 外面 —— 用户看到的就是一个**白屏**，而且（因为 `state.active`
 * 也在存档里）**每次打开都白**。他连"进界面把它删掉"这条路都没有，只能去翻
 * localStorage，等于被锁在外面。2026-09-30 那次"打不开"就是这么来的。
 *
 * 所以：主区这一屏渲染失败时，就地画一块**看得见的错误面板**，把原始报错写出来，
 * 并给一个"清掉本机存档重开"的按钮 —— 把一个死局变成一步就能自救的局面。
 *
 * 只兜主区（顶栏/左栏是纯数据映射，出错的概率低得多，且它们挂了主区也救不回来）。
 */
function renderMainSafe(main) {
  if (!main) return false   // 骨架还没搭好（比如在 index.html 之前调用）—— 没有主区可画，也没什么可救的
  try {
    renderMainInto(main)
    return true
  } catch (e) {
    const msg = (e && (e.stack || e.message)) || String(e)
    console.error('[AgentHub] 主区渲染失败：', e)
    main.innerHTML = `<div class="render-crash">
      <div class="crash-title">这一屏渲染失败了</div>
      <div class="crash-sub">你的数据都还在（会话、任务都在本机存档里）—— 这是界面代码的问题，不是你的操作。</div>
      <pre class="crash-msg">${esc(msg)}</pre>
      <div class="crash-actions">
        <button class="btn-lg" data-act="crash-retry">重试渲染</button>
        <button class="btn-lg" data-act="crash-reset">清掉本机存档并重开</button>
      </div>
      <div class="crash-note">「清掉本机存档」会丢掉本机的会话历史与任务记录（磁盘上的运行结果不受影响）。</div>
    </div>`
    return false
  }
}

function render() {
  renderTopbar()
  renderSidebar()
  renderMainSafe(byId('main'))
  renderEditor()
}

// ══════════════════════════════════════════ 渲染：顶栏

/**
 * 面包屑：「我现在在哪一屏」。
 *
 * 顶栏原来只有品牌名 + 工作目录，而工作目录在会话/任务/选择页三种状态下**一模一样** ——
 * 从截图里根本看不出这一屏是什么。这里的三条分支与 renderMain() 一一对应，
 * 不许出现第四种说法（那说明两处判断已经不一致了）。
 */
function renderCrumb() {
  const el = byId('crumb')
  if (!el) return
  const a = state.active
  if (a.type === 'chat') {
    const c = activeChat()
    const who = c ? c.memberIds.map(memberName).join(' + ') : ''
    el.innerHTML = `<span>会话</span><span>›</span><b title="${esc(who)}">${esc(who || '已删除')}</b>`
  } else if (a.type === 'task') {
    const t = activeTask()
    const label = t ? (t.title || t.goal) : '已删除'
    el.innerHTML = `<span>协同</span><span>›</span><b title="${esc(t?.goal || '')}">${esc(label)}</b>`
  } else {
    el.innerHTML = '<b>选择页</b>'
  }
}

function renderTopbar() {
  byId('projectName').textContent = state.projectName || state.workdir || '…'
  byId('projectBtn').title = state.workdir || ''
  renderCrumb()

  const p = PERMS.find((x) => x.id === state.permission) || PERMS[1]
  byId('permLabel').textContent = p.label
  byId('permBtn').title = `权限档位：${p.label} —— ${p.hint}（点击切换）`
  const dot = $('#permBtn .pill-dot')
  dot.style.background = state.permission === 'full' ? 'var(--fail)'
    : state.permission === 'execute' ? 'var(--run)' : 'var(--idle)'

  const avail = state.members.filter((m) => m.available).length
  byId('memberCount').textContent = `${avail}/${state.members.length}`

  byId('editorToggle').classList.toggle('on', state.editorOpen)
  byId('sidebar').classList.toggle('mini', state.sidebarMini)
}

// ══════════════════════════════════════════ 渲染：左栏

/*
 * 左栏条目 = **两行**。
 *
 * 旧版是一行：`• Qoder + Cursor`，在 156px 宽里连名字都放不下，只剩省略号 ——
 * 用户认不出哪条是哪条，只能靠点开猜。现在宽度到 248px，且副信息另起一行：
 *   · 会话 → 「成员 · 几条对话」，跑着的时候补一句「运行中」；
 *   · 任务 → 「N 步 · 状态」。
 * 两行里第一行是**被截断也不影响识别**的东西（名字），副信息只是补充。
 */
function sideItem({ act, id, title, sub, dotCls, active, delAct, delTitle }) {
  return `<div class="item${active ? ' active' : ''}" data-act="${act}" data-id="${esc(id)}">
    <span class="item-title"><span class="dot ${dotCls}"></span><span class="name">${esc(title)}</span>${delBtn(delAct, id, delTitle)}</span>
    <span class="item-sub">${esc(sub)}</span>
  </div>`
}

function renderSidebar() {
  const chatList = byId('chatList')
  if (!state.chats.length) {
    chatList.innerHTML = '<div class="empty-hint">还没有会话</div>'
  } else {
    chatList.innerHTML = state.chats.map((c) => {
      const busy = c.memberIds.some((id) => c.busy?.[id])
      const msgs = Object.values(c.threads || {}).reduce((n, t) => n + t.length, 0)
      const who = c.memberIds.map(memberName).join('、')
      return sideItem({
        act: 'open-chat', id: c.id, title: c.title,
        sub: listText(`${who} · ${msgs} 条${busy ? ' · 运行中' : ''}`, 40),
        dotCls: chatStatus(c),
        active: state.active.type === 'chat' && state.active.id === c.id,
        delAct: 'del-chat', delTitle: '删除会话',
      })
    }).join('')
  }
  // 「清空」只在有东西可清的时候出现 —— 空列表旁边挂个按钮纯属噪音
  byId('chatGroupTitle').innerHTML = '独立会话' + (state.chats.length ? clearBtn('clear-chats', `删除全部 ${state.chats.length} 条独立会话`) : '')

  const taskList = byId('taskList')
  if (!state.tasks.length) {
    taskList.innerHTML = '<div class="empty-hint">还没有协同任务</div>'
  } else {
    taskList.innerHTML = state.tasks.map((t) => {
      const steps = (t.plan?.subtasks || []).length
      return sideItem({
        act: 'open-task', id: t.id, title: t.title || t.goal,
        sub: steps ? `${steps} 步 · ${taskStatusText(t.status)}` : taskStatusText(t.status),
        dotCls: taskDot(t),
        active: state.active.type === 'task' && state.active.id === t.id,
        delAct: 'del-task', delTitle: '删除协同任务',
      })
    }).join('')
  }
  byId('taskGroupTitle').innerHTML = '协同任务' + (state.tasks.length ? clearBtn('clear-tasks', `删除全部 ${state.tasks.length} 个协同任务`) : '')

  /*
   * 左栏底部的「删除确认」开关：**默认开着确认 → 它 hidden**。
   * 只有用户主动勾过"下次直接删除"之后才露面，作为那条偏好唯一的回头路。
   * 放在 renderSidebar 而不是绑定处：它是"偏好的状态"派生出来的界面，
   * 任何一次重渲染都该跟当前偏好一致（否则恢复之后开关还挂在那儿）。
   */
  const sw = byId('askSwitch')
  if (sw) sw.hidden = askEnabled()
}

/*
 * 行内的删除按钮（×）。
 *
 * ★ 为什么需要它：会话和任务只存在 localStorage 里，删不掉就意味着**只能一直堆着**。
 * 用户原话：「这里没法删除会话啊」。
 *
 * ★ 为什么是独立的一层 `[data-act]` 而不是给整行加个 data-del：
 * 点击分发用的是 `e.target.closest('[data-act]')` —— 点到按钮上时最近的那个是按钮本身，
 * 所以点 × 不会顺带把会话打开。这是**靠结构**保证的，不靠 stopPropagation 那种
 * 容易被后续改动破坏的写法。
 *
 * 平时 opacity: 0，鼠标移到这一行才显形（见 style.css 的 .item-del）——
 * 一屏小 × 太吵；但当前打开的那一条会留 55% 透明度，免得"刚打开的会话反而找不到删除"。
 */
function delBtn(act, id, title) {
  return `<button class="item-del" data-act="${act}" data-id="${esc(id)}" title="${title}" aria-label="${title}">×</button>`
}
function clearBtn(act, title) {
  return `<button class="group-clear" data-act="${act}" title="${title}">清空</button>`
}

function chatStatus(c) {
  if (c.memberIds.some((id) => c.busy?.[id])) return 'run'
  const sts = c.memberIds.map((id) => c.lastStatus?.[id]).filter(Boolean)
  if (!sts.length) return ''
  if (sts.some((s) => s !== 'ok')) return 'fail'
  return 'done'
}

function taskDot(t) {
  if (t.status === 'running') return 'run'
  if (t.status === 'done') return 'done'
  if (t.status === 'failed' || t.status === 'interrupted') return 'fail'
  return ''
}

/*
 * 任务状态 → 人话。左栏副标题与任务头共用这一份 ——
 * 两处各写一份映射，迟早会出现"左栏说已完成、头部说 done"。
 */
const TASK_STATUS_TEXT = { running: '运行中', done: '已完成', failed: '失败', interrupted: '已中断', planning: '待确认' }
const taskStatusText = (s) => TASK_STATUS_TEXT[s] || s || '未开始'

// ══════════════════════════════════════════ 成员品牌徽标
/*
 * 一屏黑白灰的界面，最先让人分不清的就是"谁是谁"。
 * 徽标 = 品牌色底 + 一个字，卡片、会话头、并排列头共用这一个来源 ——
 * 颜色只许在这里定义，别让界面各处的"Claude 橙"出现两个版本。
 *
 * 颜色取各产品的品牌色；没收录的成员按 id 哈希取一个稳定的 HSL ——
 * 同一个成员每次打开颜色都一样，不同成员大概率不同色。
 */
/*
 * 品牌底色 + 真实应用图标。
 * 图标文件在 ui/public/icons/（本地静态文件，不依赖外网）：
 *   · 单色白 logo（claude/cursor/deepseek/trae，来自 Simple Icons）→ 品牌色底上反白；
 *   · 官方彩色图标（qoder 黑白双色 / 豆包彩色）→ 白底细边，不套品牌色底。
 * 字母是**兜底**：图标文件万一丢失/加载失败，onerror 退回字母徽标 —— 界面不空。
 */
const MEMBER_BRAND = {
  claude: { c: '#D97757', t: 'C', icon: 'claude.svg' },   // Anthropic 橙
  cursor: { c: '#6E56CF', t: 'C', icon: 'cursor.svg' },   // Cursor 紫
  qoder:  { c: '#0891B2', t: 'Q', icon: 'qoder.svg', plain: true },  // 官方黑白双色 → 白底
  dsh:    { c: '#4D6BFE', t: 'D', icon: 'deepseek.svg' }, // DeepSeek 蓝
  trae:   { c: '#7C5CFC', t: 'T', icon: 'trae.svg' },     // Trae 紫蓝
  doubao: { c: '#FA5252', t: '豆', icon: 'doubao.png', plain: true }, // 官方彩色 → 白底
}
function memberBrand(id) {
  if (MEMBER_BRAND[id]) return MEMBER_BRAND[id]
  /*
   * ★ 这个函数必须是**全函数**：任何 id（包括 undefined）都得能画出一个徽标。
   *   它是渲染路径上的一环，抛出去就是整块 innerHTML 拼不出来 → 白屏。
   *   而状态是从 localStorage 读回来的，里面完全可能有旧版本写下的、
   *   或用户手改过的残缺卡片（比如没有 memberId）—— 那时宁可是个灰色占位徽标，
   *   也不该整页打不开。
   */
  const name = memberById(id)?.name || (typeof id === 'string' && id ? id : '?')
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { c: `hsl(${h % 360} 45% 52%)`, t: name.slice(0, 1).toUpperCase() }
}
/** 小徽标（品牌色/白底圆角方块 + 应用图标；图标加载失败退回字母）。size 是边长 */
function memberBadge(id, size = 26) {
  const b = memberBrand(id)
  const box = `width:${size}px;height:${size}px`
  if (b.icon) {
    const bg = b.plain ? '#ffffff;border:0.5px solid var(--border-strong)' : b.c
    const letter = esc(b.t)
    return `<span class="mc-badge${b.plain ? ' plain' : ''}" style="background:${bg};${box}" aria-hidden="true">` +
      `<img class="mc-img" src="icons/${esc(b.icon)}" alt="" loading="eager" ` +
      `onerror="this.closest('.mc-badge').textContent='${letter}'">` +
      `</span>`
  }
  return `<span class="mc-badge" style="background:${b.c};${box};font-size:${Math.round(size * 0.54)}px" aria-hidden="true">${esc(b.t)}</span>`
}

// ══════════════════════════════════════════ 渲染：主区

/**
 * 重渲染主区。
 *
 * ★ 滚动位置在这里统一兜住 —— **不能**放在 rerenderMain() 里。
 *   日志区 `#taskLogs` 原来是每次渲染都无条件 `scrollTop = scrollHeight`，
 *   于是运行中的任务每来一个 SSE 事件就把正在往回翻日志的用户**拽回底部**，
 *   想看清某一步的产出根本做不到。聊天流那边早就有"贴底才跟随"的判断，
 *   但任务日志没走那条路。放到这里之后，**任何**渲染路径都自动带上这个判断。
 */
/** 主区渲染的**本体**。名字带 Into 是因为它要求把 main 传进来 —— `renderMainSafe()` 要用。
 *  别的调用点仍然写 `renderMain()`（下面那个壳），不用关心这里的分工。 */
function renderMainInto(main) {
  const stick = {}
  for (const el of document.querySelectorAll('[data-stick]')) {
    stick[el.dataset.stick] = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  if (state.active.type === 'chat') {
    const c = activeChat()
    if (!c) renderBlank(main)
    else if (c.memberIds.length === 1) renderSingleChat(main, c)
    else renderSplitChat(main, c)
  } else if (state.active.type === 'task') {
    const t = activeTask()
    if (!t) renderBlank(main)
    else renderTaskView(main, t)
  } else {
    renderBlank(main)
  }

  for (const el of document.querySelectorAll('[data-stick]')) {
    if (stick[el.dataset.stick] !== false) el.scrollTop = el.scrollHeight
  }
}

/*
 * `renderMain()` 是给"我就是要重画主区"的调用点用的壳。
 * 它也走 renderMainSafe —— 崩了同样要给用户一块看得见的错误面板，
 * 而不是留一片空白让他以为界面坏了。
 */
function renderMain() {
  return renderMainSafe(byId('main'))
}

function renderBlank(main) {
  const avail = state.members.filter((m) => m.available)
  /*
   * ★ 探测中（probing）时**不能**把"还没探到的成员"算成不可用。
   *   首屏 members 是空的、要等探活回包才有内容，中间这几秒拿空数组的补集当结论，
   *   屏幕上会先闪出一整排"暂不可用"再变成正常卡片 —— 那是个**假结论**，
   *   而用户完全可能正好在这一秒里点开一张卡去查"为什么不能用"。
   */
  const unavail = state.probing ? [] : state.members.filter((m) => !m.available)
  const tab = state.homeTab === 'coop' ? 'coop' : 'solo'
  /*
   * 首页 = 「选择页」，不是广告牌。
   *
   * 原来这里只有一句"实测可用 x 个成员"加两个按钮，整屏都是空的 ——
   * 用户每次都要多开一层弹窗才能开始干活。现在把两个入口直接铺在主页上，
   * 用页签分开（← / → 方向键也能切）：
   *
   *   · **单独工作**（默认）：成员卡片网格。点一张卡 = 直接开单聊，不再弹窗确认。
   *     这是最高频的动作，不该多一次点击。要多成员并排分屏时，右上角有「多选」入口。
   *   · **协同任务**：目标输入框 + 谁来拆解（主脑默认）—— 与「新建协同」弹窗同一份逻辑，
   *     doPlan() 同时认两套元素 id（首页与弹窗不会同时可见，但 id 决不能撞）。
   *
   * 「新建会话 / 新建协同」弹窗保留 —— 从会话里开新会话时还是要走它。
   */
  main.innerHTML = `<div class="home">
    <div class="home-head">
      <div class="hero">
        <span class="hero-title">把活派给多个 Agent</span>
        <span class="hero-sub">${state.probing
          ? '正在探测成员可用性…'
          : `实测可用 ${avail.length} / ${state.members.length} 个成员 —— 可用性都是真跑一次探出来的，不是配置里写了就算`}</span>
      </div>
      <span class="home-hud"><span class="dot"></span>${state.probing ? 'SCANNING' : 'ONLINE'} · ${avail.length}/${state.members.length} NODES</span>
    </div>
    <div class="home-tabs" role="tablist">
      <button class="home-tab${tab === 'solo' ? ' on' : ''}" data-act="home-tab" data-tab="solo">单独工作</button>
      <button class="home-tab${tab === 'coop' ? ' on' : ''}" data-act="home-tab" data-tab="coop">协同任务</button>
    </div>
    ${tab === 'solo' ? homeSoloHtml(avail, unavail) : homeCoopHtml(avail)}
  </div>`
}

/**
 * 成员卡。点一下**直接开单聊** —— 这是首页最高频的动作，不该再弹一次窗。
 *
 * 卡里那两枚 `.tag` 是**约束信息**（默认档位 / 计费口径），不是装饰：
 * 它们直接影响用户选谁（"按积分"的成员和"订阅内"的成员，代价完全不同），
 * 所以从原来挤在一起的小字里提出来单独成行。
 */
function memberCardHtml(m) {
  const caps = m.capabilities || []
  return `<button class="member-card" style="--mc:${memberBrand(m.id).c}" data-act="home-solo" data-id="${esc(m.id)}">
    <span class="mc-top">${memberBadge(m.id)}<span class="mc-name">${esc(m.name)}</span></span>
    <span class="mc-meta">${esc(m.version ? m.version.slice(0, 18) : '可用')}</span>
    <span class="mc-tags">
      <span class="tag">默认${esc(permLabel(m.defaultPermission))}档</span>
      <span class="tag">${esc(billingLabel(m.billing))}</span>
    </span>
    ${caps.length ? `<span class="mc-caps">${esc(caps.join(' · '))}</span>` : ''}
  </button>`
}

/**
 * 「接着上次」—— 首页底部原来是一大片空白。
 *
 * 这里放的是**真能一键继续**的入口（用的就是左栏那两条 open-chat / open-task，
 * 不新开通道、不新写一份跳转逻辑），不是装饰性的"最近记录"。
 * 空列表时整块不出现 —— 一条都没有的时候，这个标题只会让人以为漏加载了。
 */
function recentHtml(limit = 4) {
  const items = [
    ...state.chats.map((c) => ({ act: 'open-chat', id: c.id, dot: chatStatus(c), name: c.title, meta: `会话 · ${c.memberIds.length} 人` })),
    ...state.tasks.map((t) => ({ act: 'open-task', id: t.id, dot: taskDot(t), name: t.title || t.goal, meta: `协同 · ${(t.plan?.subtasks || []).length} 步` })),
  ].slice(0, limit)
  if (!items.length) return ''
  return `<div>
    <div class="section-title">接着上次</div>
    <div class="recent">
      ${items.map((it) => `<button class="recent-item" data-act="${it.act}" data-id="${esc(it.id)}">
        <span class="dot ${it.dot}"></span>
        <span class="recent-name">${esc(listText(it.name, 44))}</span>
        <span class="recent-meta">${esc(it.meta)}</span>
      </button>`).join('')}
    </div>
  </div>`
}

/**
 * 从探活原因里抠出"缺哪些环境变量"。
 *
 * ★ 为什么不直接读配置里的 `requiredEnv`：前端拿到的成员对象里只有探活**结果**，
 *   而"为什么不可用"的权威答案就在 `reason` 里 —— 后端那条 reason 是
 *   `缺少环境变量 X、Y（配置里声明了 requiredEnv，探活前先查）`。
 * ★ 抠不出来就返回空数组，卡片少写一行命令 —— 编一条假命令给用户，比少写一行坏得多。
 */
function missingEnvOf(reason) {
  const m = /缺少环境变量\s*([^（(]+)/.exec(String(reason || ''))
  if (!m) return []
  return m[1].split('、').map((s) => s.trim()).filter(Boolean)
}

/**
 * 不可用成员卡（虚线框那一张）。
 *
 * ★ 为什么不让它退化成"一行小字"：用户原话是「补充 trae 和豆包」——
 *   这两个成员**装了、但缺 key**，恰恰是最需要被看见的情形。压成一行 11px 灰字，
 *   等于告诉用户"这里没有它们"；占满一格，用户才会去想"怎么让它能用"。
 * ★ 为什么仍然可点：点开的是「怎么让它可用」（缺哪个变量、补到哪个文件），
 *   而**不是**开聊 —— 点开聊必然失败，那是在骗人。
 */
function memberOffCardHtml(m) {
  const need = missingEnvOf(m.reason)
  return `<button class="member-card off" style="--mc:${memberBrand(m.id).c}" data-act="member-fix" data-id="${esc(m.id)}">
    <span class="mc-top">${memberBadge(m.id)}<span class="mc-name">${esc(m.name)}</span></span>
    <span class="mc-meta">${esc(m.command ? listText(m.command, 30) : '没有命令行 · 走 API')}</span>
    <span class="mc-why" title="${esc(m.reason || '未连接')}">✕ ${esc(listText(m.reason, 44))}</span>
    ${need.length ? `<span class="mc-fix">.env: ${need.map((k) => `${esc(k)}=…`).join('  ')}</span>` : ''}
  </button>`
}

/** 单独工作：点卡片直接开单聊 */
function homeSoloHtml(avail, unavail) {
  const orch = state.orchestrator
  if (!avail.length && !orch) {
    // 还在探活 → 不能下"没有可用成员"这种结论（那是个还没算出来的答案）
    if (state.probing) return `<div class="home-empty">正在探测成员可用性 —— 每个成员都会真跑一次探活，通常几秒。</div>`
    if (!unavail.length) return `<div class="home-empty">没有可用成员 —— 先去顶栏「成员」里看看原因，装一个或把钥匙补上。</div>`
  }
  return `<div class="home-body">
    <div class="section-title">选一个成员，直接开聊</div>
    <div class="member-cards">
      ${orch ? homeOrchCard(orch) : ''}
      ${avail.map(memberCardHtml).join('')}
      ${unavail.map(memberOffCardHtml).join('')}
    </div>
    ${unavail.length ? `<div class="home-unavail">虚线框的 ${unavail.length} 个成员暂不可用 ——
      点开卡片看它缺什么。<b>它们仍然列在这里</b>，是因为"装了但还没配好"和"根本没有这个成员"
      是两件事，前者只差一步。</div>` : ''}
    <div class="home-foot"><button class="btn" data-act="new-chat">多选成员并排…</button></div>
    ${recentHtml()}
  </div>`
}

/**
 * 重画「为什么不能用」那个弹窗 —— 里面的实测原因必须是**刚探到的**那一条。
 * 保存 Key 之后如果还是没探通，弹窗上挂着上一次的原因就等于在骗人：
 * 用户会照着旧原因去改一个其实已经不是问题的地方。
 */
function rerenderFixModal() {
  if (state._fixFor) openMemberFixModal(state._fixFor)
}

/**
 * 该给这个成员填哪个变量名。
 *
 * 优先用服务端 `reason` 里那句「缺少环境变量 X」—— 那是**实测**出来的答案，
 * 比前端按 id 猜准得多。trae 就是这个坑：trae-agent 按 provider 名推导变量名，
 * 它的 provider 是 doubao，所以**只认 DOUBAO_API_KEY**，设 ARK_API_KEY 不认，
 * 而且报出来的是一段 Python 堆栈，堆栈里根本看不出是 key 的问题。
 * 前端要是自作聪明按成员 id 挑变量名，正好会挑到那个不通的。
 *
 * 认不出来的返回空串 —— 编一个变量名给用户，比不给坏得多。
 */
function keyVarFor(m) {
  const need = missingEnvOf(m.reason).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k))
  if (need.length) return need[0]
  const keys = state.envKeys || []
  // 豆包：两个变量名都认，但 DOUBAO_API_KEY 能**一次激活 Trae 和豆包**，所以优先它
  if (m.id === 'doubao') return keys.find((k) => k === 'DOUBAO_API_KEY') || keys.find((k) => k === 'ARK_API_KEY') || ''
  return ''
}

/**
 * 填 Key 的表单 —— 点一下就把密钥交给服务端写进本机 .env，然后当场重探。
 *
 * 为什么要有它：Trae 和豆包**装了、但缺 key**，界面上是一张"暂不可用"的虚线卡。
 * 点开看到的是"请在项目根目录新建 .env"，然后用户得自己开编辑器、找到目录、
 * 写对变量名（trae 那个变量名还反直觉）、再回来点重探。这条路上每一步都能把人劝退，
 * 而引擎侧要的其实只是一个字符串。
 *
 * ★ 值只去不返：提交后立刻清空输入框，不进 state、不回显、不写日志。
 *   所以这个表单**没有"已保存的 Key"可以显示** —— 那是有意为之，不是没做完。
 */
/**
 * 「这个变量名有没有额外的坑」那一句。
 *
 * Trae 和豆包共用 `DOUBAO_API_KEY` 这件事必须说出来 —— 不说的话，
 * 用户补完豆包发现 Trae 也亮了（或者反过来），只会觉得莫名其妙；
 * 更糟的是他可能以为要再填一遍，于是去找一个不存在的"Trae 的 Key"。
 */
const keySharedNote = (varName) => (varName === 'DOUBAO_API_KEY' || varName === 'ARK_API_KEY')
  ? '🌋 <b>这一个 Key 同时激活 Trae 和豆包</b> —— 两个成员共用同一个变量（Trae 的 provider 就是 doubao，只认这个名字）。'
  : ''

function keyFormHtml(m = {}) {
  const guess = keyVarFor(m)
  const keys = state.envKeys || []
  if (!keys.length) return ''   // 服务端没告诉我们允许哪些变量名，就不摆一个填了会被拒的框
  // 没猜到具体变量时，下拉框里选中的就是第一项 —— 提示要按**实际选中的**那个来说
  const current = guess || keys[0]
  return `<div class="key-form">
    <div class="kf-head">直接填 Key —— 服务端写进项目根的 <code>.env</code>，只落本机</div>
    <div class="kf-row">
      <select class="sel kf-var" id="keyVar">
        ${keys.map((k) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(k)}</option>`).join('')}
      </select>
      <input class="kf-input" id="keyInput" type="password" autocomplete="off" spellcheck="false"
        placeholder="粘贴 Key 后点右边">
      <button class="btn-lg primary" data-act="save-key">保存并重探</button>
    </div>
    <div class="kf-note" data-kf-shared>${keySharedNote(current)}</div>
    <div class="kf-note">服务只监听 127.0.0.1，密钥只落本地 <code>.env</code>；保存后立刻真跑一次探活，
      跑通才算数。</div>
  </div>`
}

/**
 * 「为什么不能用 / 怎么才能用」。
 *
 * 内容**全部**来自实测（`reason`）和配置（`authHint` / `command`），没有一句是猜的：
 * 这类弹窗最容易写歪的地方就是开始"建议"用户去做一些其实没用的事。
 */
function openMemberFixModal(id) {
  const m = memberById(id)
  if (!m) return
  // 记下是给谁开的：保存 Key 之后要能把**刷新过的**实测原因重新摆出来
  state._fixFor = id
  const need = missingEnvOf(m.reason)
  const envPath = state.configPath ? state.configPath.replace(/[\\/][^\\/]+$/, '') : ''
  openModal(`
    <h3>${esc(m.name)} 暂时不可用</h3>
    <div class="sub">${esc(m.id)}${m.command ? ` · <code>${esc(m.command)}</code>` : ''}</div>
    <div style="font-size:13px;line-height:1.9;margin:10px 0">
      <div>· 实测原因：<b>${esc(m.reason || '未连接')}</b></div>
      ${need.length ? `<div>· 缺的环境变量：<b>${esc(need.join('、'))}</b></div>` : ''}
      <div>· 可用性只看实测结果，配置里写 enabled: true 不算数。</div>
    </div>
    ${keyFormHtml(m)}
    <details class="kf-manual">
      <summary>或者自己去改 .env（不想让服务写文件就走这条）</summary>
      <div class="mc-fix"># 在项目根目录新建/编辑 .env${envPath ? `（${esc(envPath)}）` : ''}
${(need.length ? need : [keyVarFor(m)]).filter(Boolean).map((k) => `${k}=你的Key`).join('\n') || '（服务端没报告缺哪个变量名，先看上面的实测原因）'}</div>
      <div class="sub">改完回顶栏「成员」点<b>全部重探</b>。</div>
    </details>
    ${m.authHint ? `<div class="sub" style="margin-top:10px">${esc(m.authHint)}</div>` : ''}
    <div class="modal-actions">
      <button class="btn-lg" data-act="reprobe-all">全部重探</button>
      <button class="btn-lg" data-act="close-modal">知道了</button>
    </div>`, true)
}

/**
 * WorkBuddy 主脑卡 —— 排第一，样式与普通成员卡区分（渐变描边 +「主脑」标）。
 *
 * 主脑没有 CLI，点它**不可能**像普通成员那样开一个引擎调度的对话 ——
 * 那样做是骗人的。点它开的是「交给主脑」弹窗：写目标 → 落盘待拆解请求 →
 * 给一句能粘给 WorkBuddy 的话。和协同页签的「交给主脑」是同一件事，
 * 只是入口也放在了单独页签 —— 用户在哪儿想起主脑，哪儿就有入口。
 */
function homeOrchCard(orch) {
  return `<button class="member-card orch-card" data-act="orch-handoff">
    <span class="mc-badge orch-badge" aria-hidden="true">W</span>
    <span class="mc-top"><span class="mc-name">${esc(orch.name)}</span><span class="orch-tag">主脑</span></span>
    <span class="mc-meta">没有命令行 · 引擎调不动它 —— 点它把目标交给它拆解</span>
    <span class="orch-go">交给主脑 →</span>
  </button>`
}

/** 「交给主脑」输入弹窗（单独页签的 WorkBuddy 卡入口） */
function openHandoffModal() {
  openModal(`
    <h3>交给主脑</h3>
    <div class="sub">${esc(state.orchestrator?.name || 'WorkBuddy')} 没有命令行，引擎调不动它 ——
      写下目标，引擎会把它存成一份待拆解请求，并给你一句可以直接粘给主脑的话。</div>
    <textarea class="goal-box" id="handoffGoal" placeholder="想让主脑帮你做什么？"></textarea>
    <div class="modal-actions">
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" data-act="do-handoff">交给主脑</button>
    </div>`)
  setTimeout(() => byId('handoffGoal')?.focus(), 30)
}

/**
 * id 是不是一个**能派活**的拆解者：主脑，或一个实测可用的成员。
 *
 * ★ 探测中（probing）也算可用。成员列表除了首屏之外不会被清空，
 *   但探活回包前的这一小段里 available 还是上一轮的结论 ——
 *   拿这一瞬间去"纠正"用户选过的人，会让他的选择在自己眼皮底下被换掉。
 */
function canPlan(id) {
  if (!id) return false
  if (state.orchestrator && id === state.orchestrator.id) return true
  const m = memberById(id)
  return !!m && (m.available || state.probing)
}

/**
 * 当前选中的拆解者，**带回写**。
 *
 * 原来这里是一句 `state._planner || orch?.id || …` —— 只兜底、不校验。
 * 问题出在成员列表是每次探活刷新的：上次记下的 id 可能已经掉线（key 过期、
 * CLI 被卸）。此时 `<select>` 里根本没有这一项，浏览器把 value 置成空串、
 * 显示的是第一项，而 `state._planner` 还记着那个鬼 id，`doPlan` 又是
 * `byId(...)?.value || state._planner` —— 空串是 falsy，于是**真的去调那个掉线的人**。
 * select 上显示的和实际调用的是两个人，这是最难查的一类不一致。
 *
 * 所以在这里就把结论写回 state：显示什么，就调什么。
 */
function pickedPlanner() {
  if (canPlan(state._planner)) return state._planner
  // 兜底顺序：**本机可用的成员（优先 claude）→ 主脑 → 空**
  // ★ 2026-10-02 改：默认落在成员上。成员有命令行，拆解 + 执行都能在本软件里跑完；
  //   主脑（WorkBuddy）没有 CLI，选它只会把目标存成待拆解请求，还得用户切到那个软件里粘一句话。
  const avail = state.members.filter((m) => m.available)
  state._planner = avail.find((m) => m.id === 'claude')?.id || avail[0]?.id || state.orchestrator?.id || ''
  return state._planner
}

// ── 工作台：分工那几块 ──

/** 一个角色的能力要求，写成一行给人看的话 */
const roleNeedText = (info) =>
  `${info.needs?.length ? info.needs.join('/') : '不限能力'}${info.write ? ' · 会改文件' : ' · 不改文件'}`

/** 目录里这个角色，**实测可用**的成员里谁能干（配置里 enabled 不算数） */
const roleMakers = (info) => state.members.filter((m) => m.available && roleFit(info.label, m).ok)

/** 左栏的分工选项 —— 一条一个角色，勾选即「这件事要在计划里发生」 */
function rolePickHtml(info) {
  const on = state._roles.includes(info.label)
  return `<button class="role-pick${on ? ' on' : ''}" data-act="wb-role" data-role="${esc(info.label)}"
    aria-pressed="${on ? 'true' : 'false'}">
    <span class="rp-glyph">${esc(info.glyph)}</span>
    <span class="rp-body">
      <span class="rp-top"><span class="rp-name">${esc(info.label)}</span><span class="rp-need">${esc(roleNeedText(info))}</span></span>
      <span class="rp-duty">${esc(info.duty)}</span>
    </span>
  </button>`
}

/**
 * 右栏的分工预览 —— 这是「分工再详细点」真正落地的地方。
 *
 * 左栏那条只写「职责」（选人时看的是"这件事是什么"），这里补齐**交付物**和**谁能干**：
 * 交付物是这一步的验收标准 —— 只写"负责测试"，规划者会拆出"写点测试"这种没法验收的活；
 * 「谁能干」则是把规划者提示词里第 3/4 条那个结论**显示出来** ——
 * 那两条一直在提醒模型别派错人，但界面从来没让用户看见过结论。
 */
function rolePreviewHtml(info) {
  const who = roleMakers(info)
  const fit = who.length
    ? `<span class="rc-fit ok">✓ 实测可用：${who.map((m) => esc(m.name)).join('、')}</span>`
    : `<span class="rc-fit bad">⚠️ 没有实测可用的成员能干这个角色 —— 勾了也得先换人或补 Key</span>`
  return `<div class="role-card">
    <div class="rc-head">
      <span class="rp-glyph">${esc(info.glyph)}</span>
      <span class="rc-name">${esc(info.label)}</span>
      <span class="rc-need">${esc(roleNeedText(info))}</span>
    </div>
    <div class="rc-row"><span class="rc-k">职责</span><span>${esc(info.duty)}</span></div>
    <div class="rc-row"><span class="rc-k">交付物</span><span>${esc(info.deliverable)}</span></div>
    <div class="rc-row rc-fitrow">${fit}</div>
  </div>`
}

/**
 * 协同任务 = **一整页工作台**，不再是一个输入框加一个下拉框。
 *
 * 左栏是决策（谁来拆、要哪几件事发生、有谁能干、按什么权限跑），
 * 右栏是这次决策的结果（目标、分工预览、已有的协同任务）。
 * 原来这一屏只有一个 textarea 和一个 select，用户根本不知道"分工"这件事存在。
 *
 * ★ id 必须与弹窗那套**不同**（homeGoalBox / homePlannerSel / homePlanBtn / homePlannerHint）。
 *   首页和弹窗在 DOM 里可能同时在（从首页协同页签点开弹窗），getElementById 只认文档顺序的第一个，
 *   撞了 id 就会把弹窗里按的按钮算到首页的输入框头上 —— 静默错对象，最难查的那种。
 *   doPlan() 和 planner-sel 的 change 处理两边都认。
 */
function homeCoopHtml(avail) {
  const orch = state.orchestrator
  const planner = pickedPlanner()
  const usingOrch = !!orch && planner === orch.id
  const picked = state._roles.map(roleInfo).filter(Boolean)
  // 探测中不算"不可用" —— 同 renderBlank 里那条注释：那是个还没算出来的答案
  const unavail = state.probing ? [] : state.members.filter((m) => !m.available)

  return `<div class="wb">
    <div class="wb-rail">
      <div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">01</span><span class="wb-sec-title">谁来拆解</span></div>
        <select class="sel" id="homePlannerSel" data-act="planner-sel">
          ${avail.map((m) => `<option value="${esc(m.id)}"${m.id === planner ? ' selected' : ''}>${esc(m.name)}（本软件内拆解）</option>`).join('')}
          ${orch ? `<option value="${esc(orch.id)}"${usingOrch ? ' selected' : ''}>${esc(orch.name)}（主脑 · 需切到那边）</option>` : ''}
        </select>
        <div class="wb-note">${usingOrch
          ? '主脑没有命令行，引擎调不动它 —— 选它 = 只把目标存成一份待拆解请求，还得去它那边粘一句话。'
          : '引擎让这个成员当规划者<b>代拆</b>：直接出计划表，确认后就在本软件里跑完，不用切到别的软件。'}</div>
      </div>

      <div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">02</span><span class="wb-sec-title">分工</span>
          <span class="wb-count">${picked.length ? `已选 ${picked.length}` : '不指定'}</span></div>
        <div class="role-picks">
          ${roleList().map(rolePickHtml).join('')}
          ${roleList().length ? '' : '<div class="wb-empty">角色目录还没加载出来 —— 它跟着成员列表一起下发。</div>'}
        </div>
        <div class="wb-note">勾选 = 这几件事<b>都要</b>在计划里发生。不勾则由规划者自己从这份目录里挑。</div>
      </div>

      <div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">03</span><span class="wb-sec-title">成员池</span>
          <span class="wb-count">实测可用 ${avail.length}/${state.members.length}</span></div>
        <div class="wb-pool">
          ${avail.map((m) => `<span class="pool-chip" title="${esc((m.capabilities || []).join(' · ') || '没有能力标签')}">
            <span class="dot done"></span>${esc(m.name)}<i>${esc((m.capabilities || []).join('/') || '—')}</i></span>`).join('')}
          ${unavail.map((m) => `<button class="pool-chip off" data-act="member-fix" data-id="${esc(m.id)}"
            title="${esc(m.reason || '未连接')}">
            <span class="dot fail"></span>${esc(m.name)}<i>点这里补 Key</i></button>`).join('')}
        </div>
        ${unavail.length ? '<div class="wb-note">带虚线的那些还没跑通，点开就能填 Key（不用离开这一页）。</div>' : ''}
      </div>

      <div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">04</span><span class="wb-sec-title">执行参数</span></div>
        <label class="wb-arg"><span>执行权限档</span>
          <select class="sel" id="wbPerm" data-act="wb-perm">
            ${PERMS.map((p) => `<option value="${p.id}"${p.id === state.permission ? ' selected' : ''}>${esc(p.label)} —— ${esc(p.hint)}</option>`).join('')}
          </select>
        </label>
        <label class="wb-arg"><span>某步失败后</span>
          <select class="sel" id="wbPolicy" data-act="wb-policy">
            ${FAILURE_POLICIES.map((p) => `<option value="${p.id}"${p.id === state.failurePolicy ? ' selected' : ''}>${esc(p.label)} —— ${esc(p.hint)}</option>`).join('')}
          </select>
        </label>
        <div class="wb-note">和「执行计划确认」表里那两个是同一份设置 —— 先在这儿定好，确认表打开时就是它。</div>
      </div>
    </div>

    <div class="wb-main">
      <div class="wb-sec wb-goal-sec">
        <label class="wb-label" for="homeGoalBox">目标</label>
        <textarea class="goal-box home-goal" id="homeGoalBox" placeholder="例如：给 src/utils.js 的 5 个导出函数补单元测试，并写一份 README 章节说明测试覆盖了什么"></textarea>
        <div class="home-coop-row">
          <span class="grow"></span>
          <button class="btn-lg primary" id="homePlanBtn" data-act="do-plan">${usingOrch ? '交给主脑' : '拆解'}</button>
        </div>
        <div class="planner-hint" id="homePlannerHint">${esc(plannerHintText(planner))}</div>
      </div>

      <div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">05</span><span class="wb-sec-title">分工预览</span></div>
        ${picked.length
          ? `<div class="role-cards">${picked.map(rolePreviewHtml).join('')}</div>`
          : `<div class="wb-empty">还没选分工 —— 规划者会自己从 ${roleList().length} 个角色里挑。
              想让它<b>一定</b>拆出某几件事，就在左栏勾上。</div>`}
      </div>

      ${state.tasks.length ? `<div class="wb-sec">
        <div class="wb-sec-head"><span class="wb-idx">06</span><span class="wb-sec-title">已有的协同任务</span>
          <span class="wb-count">${state.tasks.length} 个</span></div>
        <div class="wb-tasks">
          ${state.tasks.slice(-6).reverse().map((t) => `<button class="wb-task" data-act="open-task" data-id="${esc(t.id)}">
            <span class="dot ${taskDot(t)}"></span>
            <span class="wb-task-name">${esc(listText(t.title || t.goal, 44))}</span>
            <span class="wb-task-meta">${(t.plan?.subtasks || []).length} 步 · ${esc(taskStatusText(t.status))}</span>
          </button>`).join('')}
        </div>
      </div>` : ''}
    </div>
  </div>`
}

/**
 * 重画首页，并保住用户已经敲进去的目标。
 *
 * 首页是**整块** innerHTML 重渲染的 —— 在左栏勾一个分工，右栏 `#homeGoalBox` 里
 * 刚写好的目标就被擦掉了，而这两件事在用户眼里毫无关系。所以先把值收起来、
 * 重画、再连光标位置一起写回去（和 `rerenderMain()` 恢复会话草稿是同一个道理，
 * 只是那条路管的是会话里的输入框，管不到首页）。
 */
function rerenderHomeKeepGoal() {
  const box = byId('homeGoalBox')
  const val = box ? box.value : ''
  const focused = !!box && document.activeElement === box
  const pos = box ? box.selectionStart : 0
  renderMain()
  const next = byId('homeGoalBox')
  if (!next) return
  next.value = val
  if (focused) {
    next.focus()
    try { next.setSelectionRange(pos, pos) } catch { /* 个别输入类型不支持选区，忽略 */ }
  }
}

// ── 单会话（ChatGPT 风格）──

function renderSingleChat(main, chat) {
  const mid = chat.memberIds[0]
  const m = memberById(mid) || { name: mid }
  const thread = chat.threads[mid] || []
  const busy = !!chat.busy?.[mid]

  /*
   * 会话头：徽标 + 名字 + 三枚信息片（版本 / 档位 / 不可用原因）+ 右侧操作。
   * 旧版是一行 11px 小字，看不出"我在跟谁说话、它现在是什么档"。
   * 「换成员」放在这里而不是只留在左栏底部 —— 用户想换人时第一眼就看向会话头。
   */
  main.innerHTML = `<div class="chat-single">
    <div class="chat-head">
      ${memberBadge(mid, 22)}
      <span class="m">${esc(m.name)}</span>
      <span class="head-chip">${esc(m.version ? m.version.slice(0, 18) : (m.available ? '可用' : '未连接'))}</span>
      <span class="head-chip">${esc(permLabel(state.permission))}档</span>
      ${m.available ? '' : `<span class="head-chip" style="color:var(--fail)">${esc(listText(m.reason, 40))}</span>`}
      <span class="head-actions">
        <button class="mini-btn" data-act="new-chat" title="新建会话（换一个成员）">换成员</button>
      </span>
    </div>
    <div class="stream" data-stick="${esc(chat.id + ':' + mid)}">
      <div class="stream-inner">${renderThread(thread, { chatId: chat.id, mid, name: m.name })}${busy ? busyLine(m.name) : ''}</div>
    </div>
    ${renderComposer(chat, [mid], { showBroadcast: false })}
  </div>`
}

// ── 并排会话 ──

function renderSplitChat(main, chat) {
  const cols = chat.memberIds.length
  main.innerHTML = `<div class="chat-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">
    ${chat.memberIds.map((mid) => renderGridCol(chat, mid)).join('')}
  </div>`
}

function renderGridCol(chat, mid) {
  const m = memberById(mid) || { name: mid }
  const thread = chat.threads[mid] || []
  const busy = !!chat.busy?.[mid]
  const cost = thread.reduce((s, x) => s + (x.meta?.cost?.usd || 0), 0)
  const credits = thread.reduce((s, x) => s + (x.meta?.cost?.credits || 0), 0)
  /*
   * 有几条回复压根没上报美元成本（qoder 按积分计费、cursor/trae 不返回成本）。
   * 不标出来的话，那个 `$` 数看起来就是这一列的**全部**花费。
   */
  const costUnknown = thread.filter((x) => x.meta && typeof x.meta.cost?.usd !== 'number').length
  const tokens = thread.reduce((s, x) => s + (x.meta?.cost?.outputTokens || 0), 0)
  const receiving = chat.broadcastTick?.[mid]

  return `<div class="grid-col${busy ? ' busy' : ''}">
    <div class="panel-head">
      <span class="m">${memberBadge(mid, 16)} ${esc(m.name)}</span>
      <span class="right">${esc(permLabel(state.permission))}档${cost ? ' · $' + cost.toFixed(4) : ''}${credits ? ' · ' + credits.toFixed(4) + ' 积分' : ''}${(cost || credits) && costUnknown ? ` · 另 ${costUnknown} 条未报成本` : ''}${tokens ? ' · ' + fmtTokens(tokens) + ' tok' : ''}</span>
    </div>
    ${receiving ? '<div style="padding:2px 10px"><span class="recv-badge">接收广播中</span></div>' : ''}
    <div class="stream" data-stick="${esc(chat.id + ':' + mid)}">
      <div class="stream-inner">${renderThread(thread, { chatId: chat.id, mid, name: m.name })}${busy ? busyLine(m.name) : ''}</div>
    </div>
    ${renderComposer(chat, [mid], { showBroadcast: true })}
  </div>`
}

function busyLine(name) {
  return `<div class="msg-tool">${esc(name)} 正在处理…</div>`
}

/*
 * 空会话的「起点卡」。
 *
 * 旧版只有一句「发一条指令开始。」悬在一大片空白里 —— 用户既不知道该说什么，
 * 也看不见自己现在是什么权限档（而档位直接决定它能不能改文件）。
 *
 * ★ 三条示例**点一下只填进输入框，不自动发送**。
 *   自动发送会在用户还没看清第一个字的时候花掉一次真实调用 ——
 *   这是"顺手"和"替用户花钱"的分界线，不能越。
 */
const STARTERS = [
  '用一句话说清你现在能做什么',
  '列出当前工作目录里的文件',
  '看看最近的日志里有什么报错',
]

function startCard({ chatId, mid, name } = {}) {
  return `<div class="start-card">
    <span class="start-title">开始和 ${esc(name || '它')} 对话</span>
    <span class="start-sub">指令会以「${esc(permLabel(state.permission))}」档发出去 —— ${esc(permHint(state.permission))}。<br>
      下面几条点一下会填进输入框，你可以改完再发。</span>
    <span class="chips">
      ${STARTERS.map((s) => `<button class="chip" data-act="fill-draft"
        data-cid="${esc(chatId || '')}" data-mid="${esc(mid || '')}" data-text="${esc(s)}">${esc(s)}</button>`).join('')}
    </span>
  </div>`
}

function renderThread(thread, ctx = {}) {
  if (!thread.length) return ctx.mid ? startCard(ctx) : '<div class="empty-hint">发一条指令开始。</div>'
  return thread.map((msg) => {
    if (msg.role === 'user') {
      return `<div class="msg-user"><div class="bubble">${esc(msg.text)}</div></div>`
    }
    if (msg.role === 'tool') {
      return `<div class="msg-tool">${esc(msg.text)}</div>`
    }
    const mt = msg.meta || {}
    const flag = mt.status && mt.status !== 'ok'
    const bits = []
    if (mt.status) bits.push(flag ? `<span class="msg-flag">${esc(mt.status)}</span>` : 'ok')
    if (mt.ms != null) bits.push(fmtMs(mt.ms))
    if (mt.cost?.outputTokens) bits.push(`${fmtTokens(mt.cost.outputTokens)} tok`)
    if (mt.exit != null) bits.push(`exit ${mt.exit}`)
    return `<div class="msg-ai">${esc(msg.text)}
      ${bits.length ? `<div class="msg-meta">${bits.join(' · ')}</div>` : ''}</div>`
  }).join('')
}

function renderComposer(chat, [mid], { showBroadcast }) {
  const key = `${chat.id}:${mid}`
  const draft = state.drafts[key] || ''
  const busy = !!chat.busy?.[mid]
  const m = memberById(mid)
  const canSend = !busy && !!draft.trim() && (m ? m.available : false)

  return `<div class="composer"><div class="composer-inner">
    ${showBroadcast ? `<div class="broadcast-bar">
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
        <input type="checkbox" data-act="toggle-broadcast" data-chat="${esc(chat.id)}"
          ${state.broadcast[chat.id] ? 'checked' : ''}> 发给全部（${chat.memberIds.length} 列并行）
      </label>
      ${!state.broadcast[chat.id] && Object.values(chat.broadcastTick || {}).some(Boolean)
        ? '<span class="recv-badge">其他列正在广播</span>' : ''}
    </div>` : ''}
    <div class="input-wrap">
      <textarea class="ta" id="ta-${esc(key)}" rows="1" placeholder="输入指令…"
        data-cid="${esc(chat.id)}" data-mid="${esc(mid)}"
        ${busy ? 'disabled' : ''}>${esc(draft)}</textarea>
      <button class="send-btn" data-act="send" data-cid="${esc(chat.id)}" data-mid="${esc(mid)}"
        ${canSend ? '' : 'disabled'}>发送</button>
    </div>
    <div class="composer-hint">${esc(permLabel(state.permission))}档 · ${esc(permHint(state.permission))}${m && !m.available ? ' · 成员不可用' : ''}${
      (() => { const c = permCaveat(m, state.permission); return c ? ` · <span class="hint-caveat">${esc(c)}</span>` : '' })()
    } · <span class="hint-keys">回车发送 · Shift+回车换行</span></div>
  </div></div>`
}

// ── 协同任务视图 ──

/*
 * ★★ 2026-10-02：任务跑动期间的**增量重画**。
 *
 * 原来每个事件末尾都调一次 `render()`，而 `render()` 会把顶栏、左栏、主区、编辑器
 * **全部**重建一遍；主区这一份又是整块 `innerHTML = <大字符串>` —— 一个几十步、
 * 日志攒到几百行的任务，每来一个事件就要重新拼一遍这份字符串、让浏览器重新解析
 * 上千个节点。而事件是成串来的（开始、工具、结束…），同一帧里能重画好几轮，
 * 用户看到的就是卡顿。
 *
 * 所以这里把任务视图拆成四块，各记各的"当前长相"，只在**真的变了**的时候替换：
 *   · 日志区   —— 只往后追加新增的行（这是最大的一块，也最容易省）
 *   · 分工列表 —— 只换状态变了的那个条目
 *   · 任务头   —— 数字变了才换
 *   · 右栏     —— 选中的那一步变了才换
 * 顶栏与编辑器在任务跑动期间不受影响，直接不画。
 *
 * 兜底：任何一处"对不上结构"（不是这块任务、步骤名单换了、DOM 被别处重建过…）
 * 都返回 false，交给调用方老老实实整屏重画一次。
 * **宁可多画一次，也不能少画一条。**
 */

/** 分工列表的顺序：优先用引擎给的批次顺序，没有才回落到计划本身 */
function stepOrder(task) {
  return task.cardOrder?.length ? task.cardOrder : (task.plan?.subtasks || []).map((s) => s.id)
}

/**
 * ★ 左栏选中哪一步 = 右栏显示哪一步。
 *   选中的 id 不存在时（换了任务、或计划被重排）回落到第一步 ——
 *   否则右栏会永远空着，而用户明明已经点了左侧一条，看着像界面坏了。
 */
function pickedOf(task, order) {
  return order.includes(state.pickedStep) ? state.pickedStep : (order[0] || null)
}

/**
 * 任务头要用的那组数字。
 *
 * 进度按**已处理**（成功 + 失败 + 未执行）算，不按成功算 ——
 * 否则一个 3 步全失败的任务看起来会永远停在 0%。
 */
function taskNums(task) {
  const subTotal = (task.plan?.subtasks || []).length
  const cardList = Object.values(task.cards || {})
  const nDone = cardList.filter((c) => c.status === 'done').length
  const nFail = cardList.filter((c) => c.status === 'fail').length
  const nSkip = cardList.filter((c) => c.status === 'skip').length
  const processed = nDone + nFail + nSkip
  return {
    subTotal, nDone, nFail, nSkip, processed,
    pct: subTotal ? Math.round((processed / subTotal) * 100) : 0,
    // 优先用引擎给的汇总口径（它认得积分计费的成员），没有才自己累加卡片上的美元成本
    usd: typeof task.summary?.totalCostUsd === 'number'
      ? task.summary.totalCostUsd
      : cardList.reduce((sum, c) => sum + (c.cost?.usd || 0), 0),
  }
}

function taskHeadHtml(task) {
  const badge = task.status === 'running' ? 'run'
    : task.status === 'done' ? 'done'
      : (task.status === 'failed' || task.status === 'interrupted') ? 'fail' : ''
  const { subTotal, nDone, nFail, nSkip, processed, pct, usd } = taskNums(task)
  const s = task.summary
  return `<div class="task-head">
      <span class="task-goal">${esc(task.goal)}</span>
      <span class="badge ${badge}">${esc(taskStatusText(task.status))}</span>
      <span class="badge">${esc(permLabel(task.permission || state.permission))}档</span>
      ${task.failurePolicy ? `<span class="badge" title="${esc(policyHint(task.failurePolicy))}">失败策略：${esc(policyLabel(task.failurePolicy))}</span>` : ''}
      ${s?.skippedCount ? `<span class="badge skip" title="引擎没有调用这些步骤的成员，所以没有花费">${s.skippedCount} 步未执行</span>` : ''}
      ${s?.degradedCount ? `<span class="badge warn" title="这些步骤是在上游缺了输入的情况下跑的，结论可能不完整">${s.degradedCount} 步带缺口</span>` : ''}
      ${s?.suspectCount ? `<span class="badge warn" title="进程正常退出，但内容不像是有效结果 ——「成功」只说明没崩">${s.suspectCount} 步产出可疑</span>` : ''}
      <span class="task-stats">
        <span class="stat"><span class="stat-n">${nDone}/${subTotal}</span><span class="stat-l">已完成</span></span>
        ${nFail ? `<span class="stat"><span class="stat-n">${nFail}</span><span class="stat-l">失败</span></span>` : ''}
        ${nSkip ? `<span class="stat"><span class="stat-n">${nSkip}</span><span class="stat-l">未执行</span></span>` : ''}
        <span class="stat"><span class="stat-n">$${usd.toFixed(4)}</span><span class="stat-l">已花</span></span>
      </span>
      ${task.status === 'running' ? '<button class="mini-btn" data-act="stop-task">停止</button>' : ''}
      ${task.status === 'done' ? '<button class="mini-btn" data-act="open-report">看轨迹报告</button>' : ''}
      <span class="prog" title="已处理 ${processed}/${subTotal} 步"><span class="prog-fill" style="width:${pct}%"></span></span>
    </div>`
}

function taskViewHtml(task) {
  const order = stepOrder(task)
  const subtasksById = Object.fromEntries((task.plan?.subtasks || []).map((s) => [s.id, s]))
  const { subTotal, nDone, nFail, nSkip } = taskNums(task)
  const picked = pickedOf(task, order)
  const pickedCard = picked ? task.cards[picked] : null
  const pickedIdx = picked ? order.indexOf(picked) + 1 : 0

  return `<div class="task-view">
    ${taskHeadHtml(task)}
    <div class="coop-split">
      <div class="coop-left">
        <div class="coop-left-head">分工<span class="n">${order.length} 步</span></div>
        <div class="coop-steps">
          ${order.length ? order.map((id, i) => stepItem(task, id, i, picked)).join('') : '<div class="empty-hint">计划为空</div>'}
        </div>
        <div class="coop-left-foot">
          <div class="coop-field">共 ${order.length} 步 · 已完成 ${nDone}${nFail ? ` · 失败 ${nFail}` : ''}${nSkip ? ` · 未执行 ${nSkip}` : ''}</div>
        </div>
      </div>
      <div class="coop-right ${esc(pickedCard?.status || '')}">
        ${pickedCard
          ? stepDetail(task, pickedCard, pickedIdx, subtasksById[picked] || pickedCard, order)
          : '<div class="empty-hint">计划为空，没有可看的分工</div>'}
      </div>
    </div>
    <div class="logs" id="taskLogs" data-stick="task:${esc(task.id)}">${task.logs.map(renderLogLine).join('')}</div>
  </div>`
}

function renderTaskView(main, task) {
  main.innerHTML = taskViewHtml(task)
  task._paint = paintSnapshot(task)

  // 注意：这里**故意不**再滚到底部。日志区的跟随与否统一由 renderMain() 的
  // "贴底才跟随"判断决定 —— 见那里的注释（原来这里无条件滚动，会把用户往回翻的手拽走）。
}

/** 一条分工条目的"长相"：变了才需要重画它 */
function stepSig(task, id, picked) {
  const c = task.cards[id]
  if (!c) return '-'
  return `${c.status}|${c.memberId}|${id === picked ? 'on' : ''}`
}

/** 任务头的"长相"：这些数字任何一个变了就得重画头 */
function taskHeadSig(task) {
  const n = taskNums(task)
  const s = task.summary
  return [task.status, task.permission, task.failurePolicy,
    s?.skippedCount, s?.degradedCount, s?.suspectCount,
    n.nDone, n.nFail, n.nSkip, n.subTotal, n.usd.toFixed(4), n.pct].join('|')
}

function paintSnapshot(task) {
  const order = stepOrder(task)
  const picked = pickedOf(task, order)
  const steps = {}
  for (const id of order) steps[id] = stepSig(task, id, picked)
  return {
    order: order.join('|'),
    steps,
    picked,
    head: taskHeadSig(task),
    right: picked ? `${picked}|${steps[picked]}` : '',
    // 日志：用**首行对象的身份**判断"有没有被裁掉/换过一份"，
    // 用行数判断"有没有新增"。两者都不依赖日志行里有没有多余字段 ——
    // 老存档里的行只有 {t,text}。
    firstLog: task.logs[0] || null,
    logCount: task.logs.length,
  }
}

/** 增量重画任务视图。能画就画，画不了返回 false 让调用方整屏重画。 */
function patchTaskView(task) {
  const p = task._paint
  const main = byId('main')
  if (!p || !main) return false
  if (state.active.type !== 'task' || state.active.id !== task.id) return false
  const view = main.querySelector('.task-view')
  if (!view) return false

  const order = stepOrder(task)
  // 步骤名单换了（比如刚 accept 计划、或重排过）—— 结构变了，交给整屏重画
  if (order.join('|') !== p.order) return false

  // ── 1. 日志：只追加新增的行 ──
  const box = view.querySelector('#taskLogs')
  if (!box) return false
  const swapped = task.logs.length >= p.logCount && task.logs[0] !== p.firstLog
  if (swapped || task.logs.length < p.logCount) {
    // 被裁过（超过 800 行上限）或整份换过（新的一次运行）—— 重铺，但只重铺这一块
    box.innerHTML = task.logs.map(renderLogLine).join('')
  } else if (task.logs.length > p.logCount) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80
    box.insertAdjacentHTML('beforeend', task.logs.slice(p.logCount).map(renderLogLine).join(''))
    if (stick) box.scrollTop = box.scrollHeight
  }

  const picked = pickedOf(task, order)

  // ── 2. 分工列表：只换状态变了的条目 ──
  for (const id of order) {
    const sig = stepSig(task, id, picked)
    if (p.steps[id] === sig) continue
    let hit = null
    for (const el of view.querySelectorAll('.coop-steps [data-act="pick-step"]')) {
      if (el.dataset.id === id) { hit = el; break }
    }
    if (!hit) return false
    hit.outerHTML = stepItem(task, id, order.indexOf(id), picked)
    p.steps[id] = sig
  }

  // ── 3. 任务头：数字变了才换 ──
  const headSig = taskHeadSig(task)
  if (headSig !== p.head) {
    const head = view.querySelector('.task-head')
    if (!head) return false
    head.outerHTML = taskHeadHtml(task)
    p.head = headSig
  }

  // ── 4. 右栏：选中的那一步变了才换 ──
  const rightSig = picked ? `${picked}|${stepSig(task, picked, picked)}` : ''
  if (rightSig !== p.right || picked !== p.picked) {
    const right = view.querySelector('.coop-right')
    if (!right) return false
    const card = picked ? task.cards[picked] : null
    const subtasksById = Object.fromEntries((task.plan?.subtasks || []).map((s) => [s.id, s]))
    right.className = `coop-right ${esc(card?.status || '')}`
    right.innerHTML = card
      ? stepDetail(task, card, order.indexOf(picked) + 1, subtasksById[picked] || card, order)
      : '<div class="empty-hint">计划为空，没有可看的分工</div>'
    p.right = rightSig
  }

  p.picked = picked
  p.firstLog = task.logs[0] || null
  p.logCount = task.logs.length
  return true
}

/**
 * 任务跑动期间统一走这里。
 *
 * 顶栏 / 左栏只在**任务状态真的换了**的时候重画（左栏那个状态点靠它）——
 * 主区交给增量重画。画不动就整屏重画：宁可慢一点，不能少一条。
 */
function paintTask(task) {
  if (task._sideStatus !== task.status) {
    task._sideStatus = task.status
    renderTopbar()
    renderSidebar()
  }
  if (!patchTaskView(task)) render()
}
function stepItem(task, id, i, picked) {
  const card = task.cards[id]
  if (!card) return ''
  const st = card.status || 'wait'
  const txt = { wait: '等待', run: '运行中', done: '已完成', fail: '失败', skip: '未执行' }[st] || st
  const dotCls = { run: 'run', done: 'done', fail: 'fail' }[st] || ''
  return `<button class="step ${esc(st)}${id === picked ? ' on' : ''}" data-act="pick-step" data-id="${esc(id)}"
      title="${esc(card.title || id)}">
    <span class="step-idx">${i + 1}</span>
    <span class="step-title">${esc(card.title || id)}</span>
    <span class="step-state"><span class="dot ${dotCls}"></span>${esc(txt)}</span>
    <span class="step-who">${memberBadge(card.memberId, 16)}<span class="name">${esc(memberName(card.memberId))}</span></span>
  </button>`
}

/**
 * 右栏「问答」：这一步派给成员的指令（问）→ 成员交回来的产出（答）。
 *
 * 它取代了原来那一列 `.chain` 长卡片：十几步的任务在那种排布下要往下滚三屏，
 * 而且"这一步派给谁"和"这一步说了什么"挤在同一张卡里，来回找很累。
 * 现在分工归左栏，这一栏只回答一个问题：**这一步到底说了什么**。所以：
 *   · 指令和产出用气泡分左右，读起来是对话，不是表格；
 *   · 「未执行」的步骤只讲清楚"为什么没跑"，**不印空的指令与产出** ——
 *     印出来会让人以为"它跑了、只是什么都没交"，空壳比没有更误导。
 */
function stepDetail(task, card, idx, st, order) {
  const cls = { run: 'run', done: 'done', fail: 'fail', skip: 'skip' }[card.status] || ''
  const statusText = { wait: '等待中', run: '运行中', done: '已完成', fail: '失败', skip: '未执行' }[card.status] || card.status
  const bad = card.quality?.level === 'suspect'
  const gaps = Array.isArray(card.degradedUpstream) ? card.degradedUpstream : []
  const dur = card.status === 'run' && card.startedAt
    ? `<span data-elapsed data-from="${card.startedAt}">0.0s</span>`
    : fmtMs(card.durationMs)
  const deps = st?.dependsOn || []
  /*
   * 依赖那句话必须和事实一致：依赖里有被跳过/失败的步骤时，
   * 那一段上游根本不存在，"产出已注入"就是假的 —— 如实说缺口。
   */
  const deadDeps = deps.filter((d) => {
    const c = task.cards[d]
    return c && (c.status === 'skip' || c.status === 'fail')
  })
  /*
   * 文件改动三态必须分开 —— 有改动 / 完整采集但零改动 / **未采集**。
   * 把"未采集"显示成"无改动"会让用户以为成员什么都没干，那是另一处假绿。
   */
  const cf = (card.status !== 'done' && card.status !== 'fail')
    ? ''
    : Array.isArray(card.changedFiles)
      ? (card.changedFiles.length
          ? `改动 ${card.changedFiles.length} 个文件：${card.changedFiles.slice(0, 6).join('、')}${card.changedFiles.length > 6 ? ' 等' : ''}`
          : '改动文件：无（已完整采集）')
      : '改动文件：未采集'

  const isSkip = card.status === 'skip'
  const canAct = isSkip ? card.skipKind !== 'user' : card.status === 'fail'
  /*
   * 这一步的角色说明 —— 从目录里取。
   *
   * 任务跑起来之后，右栏原来只有"谁、什么状态、花了多久"，看不出**这一步本该交付什么**，
   * 于是就没法判断拿到的产出算不算完成。把职责与交付物摆在这里，验收标准才在场。
   * 顺带把能力不匹配的结论也留在这里：跑完才失败时，这是最直接的线索之一。
   */
  const roleInfoOfStep = roleInfo(card.role)
  const stepFit = roleFit(card.role, memberById(card.memberId))

  return `<div class="coop-right-head">
      ${memberBadge(card.memberId, 22)}
      <span class="m">${esc(memberName(card.memberId))}</span>
      <span class="head-chip">步骤 ${idx} · ${esc(card.role || '执行者')}</span>
      <span class="badge ${cls}">${esc(statusText)}</span>
      <span class="head-chip" title="耗时">${dur}</span>
      ${card.cost?.usd ? `<span class="head-chip" title="这一步的花费">$${card.cost.usd.toFixed(4)}</span>` : ''}
      ${bad ? '<span class="head-chip" style="color:var(--run)">产出可疑</span>' : ''}
      ${gaps.length ? '<span class="head-chip" style="color:var(--run)">上游缺口</span>' : ''}
    </div>
    <div class="coop-right-body">
      ${roleInfoOfStep ? `<div class="step-role">
        <span class="sr-k">职责</span><span>${esc(roleInfoOfStep.duty)}</span>
        <span class="sr-k">交付物</span><span>${esc(roleInfoOfStep.deliverable)}</span>
      </div>` : ''}
      ${stepFit.notes.map((n) => `<div class="pr-misfit">⚠️ ${esc(n)}</div>`).join('')}
      ${isSkip
        ? `<div class="turn-a"><div class="turn-label">这一步没有被执行</div>引擎没有调用这一步的成员（${esc(skipKindLabel(card.skipKind))}）—— 没有指令发出去、没有花费、也没有产出。${canAct ? '卡住它的那一步修好之后，可以直接重试它。' : ''}</div>`
        : `<div class="turn-q">${esc(card.prompt || '（这一步没有指令）')}</div>
           <div class="turn-a">
             <div class="turn-label">${esc(memberName(card.memberId))} 的产出 · ${esc(statusText)}</div>
             ${card.text ? esc(card.text.slice(0, 8000)) : '（还没有产出）'}
           </div>`}
      ${cf && !isSkip ? `<div class="turn-label" data-changed-files>${esc(cf)}</div>` : ''}
      ${gaps.length ? `<div class="turn-label" style="color:var(--run)">⚠️ 这一步是在 ${esc(gaps.join('、'))} 没有可用产出的情况下执行的 —— 结论可能不完整</div>` : ''}
      ${bad && card.quality?.note ? `<div class="turn-label" style="color:var(--run)">⚠️ ${esc(card.quality.note)}</div>` : ''}
      ${deps.length ? `<div class="turn-label">↑ 依赖 ${deps.map((d) => `步骤 ${indexOfId(order, d)}`).join('、')}${deadDeps.length ? ` —— 其中 ${deadDeps.length} 步没有可用产出，缺口已标在指令里` : ' 的产出已注入上面的指令'}</div>` : ''}
    </div>
    ${canAct ? `<div class="coop-actions">
      <button class="mini-btn" data-act="retry-card" data-tid="${esc(card._tid || '')}" data-id="${esc(card.id)}">重试</button>
      <button class="mini-btn" data-act="swap-card" data-tid="${esc(card._tid || '')}" data-id="${esc(card.id)}">换人</button>
      <button class="mini-btn" data-act="skip-card" data-tid="${esc(card._tid || '')}" data-id="${esc(card.id)}">跳过</button>
    </div>` : ''}`
}

function indexOfId(order, id) {
  const i = order.indexOf(id)
  return i >= 0 ? i + 1 : '?'
}

function renderLogLine(l) {
  return `<div><span class="t">${esc(l.t)}</span>  ${esc(l.text)}</div>`
}

// ── 运行中卡片计时器 ──

setInterval(() => {
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const from = Number(el.dataset.from)
    if (from) el.textContent = fmtMs(Date.now() - from)
  })
}, 1000)

// ══════════════════════════════════════════ 渲染：编辑器

/** 当前文件树已经加载的目录。用来避免每次重渲染都重读磁盘。 */
const treeState = { dir: null }

function renderEditor() {
  const pane = byId('editorPane')
  pane.classList.toggle('hidden', !state.editorOpen)
  byId('resizer').style.display = state.editorOpen ? '' : 'none'
  if (!state.editorOpen) return

  const ed = state.editor
  byId('editorTitle').textContent = ed ? ed.path : '编辑器'
  byId('unsavedDot').hidden = !ed?.dirty

  if (treeState.dir !== state.treeDir) loadTree(state.treeDir)
  else renderTreeItems()

  // 只在"换了文件"时才覆盖编辑框内容 —— 否则每次重渲染都会擦掉用户正在打的字
  const view = byId('fileView')
  if (!ed) {
    if (view.dataset.path) { view.value = ''; view.dataset.path = '' }
  } else if (view.dataset.path !== ed.path) {
    view.value = ed.original
    view.dataset.path = ed.path
  }
}

function renderTreeNav() {
  return `<div class="ft-item" data-act="tree-up" style="${state.treeDir === '.' ? 'opacity:.45;pointer-events:none' : ''}">📁 ..</div>
    <div class="ft-item" style="opacity:.7;cursor:default">/${esc(state.treeDir === '.' ? '' : state.treeDir)}</div>
    <div id="treeItems"></div>`
}

function renderTreeItems() {
  const box = byId('treeItems')
  if (!box) return
  const items = state._treeItems || []
  const sig = items.map((i) => i.path + (i.dir ? '/' : '')).join('|') + '#' + (state.editor?.path || '')
  if (sig === state._treeSig) return
  state._treeSig = sig
  if (!items.length) { box.innerHTML = '<div class="empty-hint">空目录</div>'; return }
  box.innerHTML = items.map((it) => `<div class="ft-item${it.dir ? ' dir' : ''}${state.editor?.path === it.path ? ' active' : ''}"
    data-act="${it.dir ? 'tree-into' : 'open-file'}" data-path="${esc(it.path)}">
    ${it.dir ? '📁' : '📄'} ${esc(it.name)}</div>`).join('')
}

async function loadTree(dir) {
  treeState.dir = dir
  const tree = byId('fileTree')
  tree.innerHTML = renderTreeNav() + '<div class="empty-hint">读取中…</div>'
  try {
    const r = await api(`/api/tree?dir=${encodeURIComponent(dir)}`)
    state._treeItems = r.items
    state._treeSig = null
    state.treeDir = r.dir || dir
    treeState.dir = state.treeDir
    tree.innerHTML = renderTreeNav()
    renderTreeItems()
  } catch (e) {
    tree.innerHTML = renderTreeNav() + `<div class="empty-hint">读目录失败：${esc(e.message)}</div>`
  }
}

async function openFileInEditor(path, { force = false } = {}) {
  if (state.editor?.dirty && !force) {
    if (!confirm(`「${state.editor.path}」有未保存的修改，切走会丢失。继续？`)) return
  }
  try {
    const r = await api(`/api/file?path=${encodeURIComponent(path)}`)
    state.editor = { path: r.path, original: r.text, mtimeMs: r.mtimeMs, dirty: false }
    state._treeSig = null
    renderEditor()
    renderTreeItems()
  } catch (e) {
    toast(`打开失败：${e.message}`, 'err')
  }
}

/**
 * 保存文件。带上打开时记下的 mtime，让服务端判断有没有被外部改过。
 * 409 = 冲突（多半是某个 agent 刚改过），**绝不覆盖**，出冲突卡片。
 */
async function saveEditorFile() {
  const ed = state.editor
  if (!ed) return
  const v = byId('fileView')
  const text = v ? v.value : ed.original
  try {
    const r = await api('/api/write', {
      method: 'POST',
      body: { path: ed.path, text, expectMtimeMs: ed.mtimeMs },
    })
    ed.original = text
    ed.mtimeMs = r.mtimeMs
    ed.dirty = false
    renderEditor()
    toast(`已保存 ${ed.path}`, 'ok')
  } catch (e) {
    if (e.status === 409 && e.payload?.current) {
      openConflictModal(ed.path, text, e.payload.current)
    } else {
      toast(`保存失败：${e.message}`, 'err')
    }
  }
}

// ══════════════════════════════════════════ 弹窗

/*
 * 弹窗。`wide` 是唯一一种额外宽度档（成员管理 / 计划确认表 / 交给主脑要用）。
 *
 * ★ 这里刻意**不用** `class="modal ${extraClass}"` 那种拼法，而是把 `'modal wide'`
 *   写死在字面量里：`${extraClass}` 这种形式，样式覆盖检查器（tools/check-css-coverage.mjs）
 *   抽不出来 —— 于是 `.modal.wide` 会被一直当成"死样式"，而它其实在用。
 *   一个会误报的检查器很快就会没人看，所以宁可这里写法啰嗦一点。
 */
function openModal(html, wide = false) {
  byId('modalRoot').innerHTML = `<div class="${wide ? 'modal wide' : 'modal'}">${html}</div>`
  byId('modalRoot').classList.add('open')
}

function closeModal() {
  byId('modalRoot').classList.remove('open')
  byId('modalRoot').innerHTML = ''
}

// ── 成员管理 ──

function openMembersModal() {
  const rows = state.members.map((m) => `
    <div class="member-row">
      <div class="member-top">
        <span class="dot ${m.available ? 'done' : (m.enabled ? 'fail' : '')}" title="${m.available ? '实测可用' : (m.enabled ? '实测不可用' : '已禁用')}"></span>
        <span class="who">
          <span>${esc(m.name)}
            <span style="color:var(--text-faint);font-size:11px">${esc(m.id)} · 计费${esc(billingLabel(m.billing))}</span>
          </span>
          <span class="cmd" title="${esc(m.command)}">${esc(m.command)}</span>
        </span>
        <span class="why ${m.available ? 'good' : 'bad'}" title="${esc(m.available ? `可用 ${m.version || ''}` : (m.reason || '未连接'))}">
          ${esc(m.available ? `可用 ${m.version || ''}`.trim() : (m.reason || '未连接'))}</span>
        <select class="sel" data-act="set-perm" data-id="${esc(m.id)}" title="该成员的默认权限档">
          ${PERMS.map((p) => `<option value="${p.id}"${p.id === m.defaultPermission ? ' selected' : ''}>默认 ${esc(p.label)}</option>`).join('')}
        </select>
        <button class="mini-btn" data-act="test-member" data-id="${esc(m.id)}">测试</button>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim)">
          <input type="checkbox" data-act="toggle-member" data-id="${esc(m.id)}" ${m.enabled ? 'checked' : ''}>启用
        </label>
        <button class="mini-btn" data-act="member-notes" data-id="${esc(m.id)}">笔记</button>
      </div>
      ${m.authHint
        ? `<div class="hint" title="${esc(m.authHint)}">${esc(listText(m.authHint, 200))}</div>`
        : ''}
    </div>`).join('')

  openModal(`
    <h3>成员管理</h3>
    <div class="sub">可用性一律来自实测（真跑一次 <code>--version</code> 或真发一次请求），不看配置文件里的 enabled 字段。
      <br>配置：<code>${esc(state.configPath || 'src/config/members.json')}</code>　·　密钥放 <code>.env</code>（见 <code>.env.example</code>）</div>
    ${rows || '<div class="empty-hint">配置里没有成员</div>'}
    ${keyFormHtml()}
    <div class="modal-actions">
      <button class="btn-lg" data-act="reprobe-all">全部重探</button>
      <button class="btn-lg" data-act="add-member">+ 自定义成员</button>
      <button class="btn-lg primary" data-act="close-modal">关闭</button>
    </div>`, true)
}

/**
 * 换人：挑一个成员来重跑这一步。
 *
 * 只列**实测可用**的成员 —— 换到一个探活都不通的成员，除了浪费一次点击没有别的作用。
 * 当前成员也不列（"换成它自己"就是重试，那是另一个按钮的事）。
 */
function openSwapModal(task, id) {
  const card = task.cards[id]
  const usable = state.members.filter((m) => m.available && m.id !== card?.memberId)
  openModal(`
    <h3>换人重跑 [${esc(id)}]</h3>
    <div class="sub">当前成员：${esc(memberName(card?.memberId))}。已经成功的其它步骤<b>不会</b>被重跑。</div>
    ${usable.length
      ? `<div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">
          ${usable.map((m) => `<button class="btn-lg" style="text-align:left" data-act="swap-to"
            data-tid="${esc(task.id)}" data-id="${esc(id)}" data-mid="${esc(m.id)}">
            ${esc(m.name)}
            <span style="color:var(--text-faint);font-size:11px">${esc(m.version || '')} · 默认${esc(permLabel(m.defaultPermission))}档 · 计费${esc(billingLabel(m.billing))}</span>
          </button>`).join('')}
        </div>`
      : '<div class="empty-hint">没有别的可用成员可换 —— 先去成员管理里探活或加一个</div>'}
    <div class="modal-actions"><button class="btn-lg" data-act="close-modal">取消</button></div>`)
}

/**
 * 跳过：**必须先把后果说清楚再让人点**。
 *
 * "跳过"不只是"这一步不要了" —— 它会让依赖它的步骤带着缺口继续跑，
 * 也就是说这一次点击实际改变了整条下游链的输入条件（而且那些步骤会花新的钱）。
 * 按钮上写"跳过"两个字，谁都想不到这一层，所以这里逐条列出来。
 */
function openSkipModal(task, id) {
  const card = task.cards[id]
  const waiters = (task.plan?.subtasks || [])
    .filter((s) => (s.dependsOn || []).includes(id))
    .map((s) => s.id)
  openModal(`
    <h3>跳过 [${esc(id)}]</h3>
    <div class="sub">${esc(card?.title || '')} —— ${esc(memberName(card?.memberId))}</div>
    <div style="font-size:13px;line-height:1.9;margin:10px 0">
      跳过 = <b>确认这一步的产出不要了</b>。它不会再被重跑。${waiters.length
        ? `<br>依赖它的 <b>${esc(waiters.join('、'))}</b> 会带着「缺 ${esc(id)}」的标记继续跑 ——
           这一步会花新的钱，报告里也会标成"不完整"。`
        : '<br>没有其它步骤依赖它，所以跳过不会有连带影响。'}
      <br>报告里记成「已由用户跳过」，和引擎自己跳过的情形分开。
    </div>
    <div class="modal-actions">
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" data-act="skip-confirm" data-tid="${esc(task.id)}" data-id="${esc(id)}">确认跳过</button>
    </div>`)
}

// ── 删除会话 / 任务：不可恢复，所以先把它是什么、会丢什么说清楚 ──

/*
 * 会话和任务**只存在浏览器的 localStorage 里**（后端是无状态的，见文件头）。
 * 也就是说删掉就是真没了：没有回收站、没有云端副本，而这些对话是**真花钱跑出来的**。
 * 按钮上写「删除」两个字，用户不会想到这一层 —— 所以对话框里逐条列清楚。
 *
 * 另一头也不能吓唬人：删掉的只是界面上的记录，**工作目录里的文件一个都不动**。
 * 这一条必须写出来，否则用户会以为要连产出一起删掉、干脆不敢点。
 */
function openDeleteModal(kind, id) {
  const isChat = kind === 'chat'
  const obj = isChat ? state.chats.find((c) => c.id === id) : state.tasks.find((t) => t.id === id)
  if (!obj) return

  let title, sub, lines
  if (isChat) {
    const msgs = Object.values(obj.threads || {}).reduce((n, t) => n + t.length, 0)
    const running = obj.memberIds.filter((m) => obj.busy?.[m])
    title = '删除会话'
    sub = `${obj.title} · ${obj.memberIds.map(memberName).join('、')}`
    lines = [
      `这条会话（含 <b>${msgs}</b> 条对话记录）会被删掉，<b>不可恢复</b> —— 对话只保存在本机浏览器里，没有云端副本。`,
      running.length ? `<b>${esc(running.map(memberName).join('、'))} 正在跑</b>：请求已经发出去了，费用照算，但返回的内容不会再显示。` : '',
      '工作目录里的文件不会被删 —— 删掉的只是界面上的这条记录。',
    ]
  } else {
    const subs = obj.plan?.subtasks || []
    const done = subs.filter((s) => obj.cards?.[s.id]?.status === 'ok').length
    title = '删除协同任务'
    sub = obj.goal
    lines = [
      `这条任务（${subs.length} 个子任务，其中 ${done} 个已完成）和它的轨迹报告会被删掉，<b>不可恢复</b>。`,
      obj.status === 'running' ? '<b>这个任务正在跑</b>：已经在跑的成员不会被叫停，费用照算，但结果不会再显示。' : '',
      '工作目录里的文件不会被删。',
    ]
  }
  openModal(`
    <h3>${title}</h3>
    <div class="sub">${esc(sub)}</div>
    <div style="font-size:13px;line-height:1.9;margin:10px 0">
      ${lines.filter(Boolean).map((l) => `<div>· ${l}</div>`).join('')}
    </div>
    <div class="modal-actions">
      <label class="ask-once" title="勾选后，删除单条会话/任务不再弹这个框（整组清空仍然会确认）">
        <input type="checkbox" id="delNoAsk">下次直接删除，不再提示
      </label>
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg danger" data-act="del-confirm" data-kind="${isChat ? 'chat' : 'task'}" data-id="${esc(id)}">删除</button>
    </div>`)
}

/*
 * 点 × 之后的岔路：确认开着 → 弹框；关着 → 直接删。
 *
 * ★ 直接删的时候**必须**在 toast 上挂「恢复确认」：这是那条偏好唯一的回头路。
 *   用户勾了"不再提示"之后，界面里再没有任何地方能打开这个框（左栏那个开关
 *   只在关掉时出现，它就是靠这里出现的），所以这一次的 toast 是关键时刻。
 * ★ 只在**真的删掉**（done 为真）时才给恢复入口 —— 删除失败却弹出"恢复确认"，
 *   用户会以为是自己点错了。
 */
function delOrAsk(kind, id) {
  if (askEnabled()) { openDeleteModal(kind, id); return }
  const done = kind === 'chat' ? deleteChat(id) : deleteTask(id)
  if (!done) return
  toast(kind === 'chat' ? '会话已删除' : '协同任务已删除', 'ok',
    { label: '恢复确认', act: 'ask-on' })
}

/** 清空整组。数量说在按钮和正文里 —— 「清空」这个词本身不告诉你要清掉多少东西 */
function openClearModal(kind) {
  const isChat = kind === 'chat'
  const n = isChat ? state.chats.length : state.tasks.length
  if (!n) return
  const running = isChat
    ? state.chats.filter((c) => c.memberIds.some((m) => c.busy?.[m])).length
    : state.tasks.filter((t) => t.status === 'running').length
  openModal(`
    <h3>清空${isChat ? '独立会话' : '协同任务'}</h3>
    <div class="sub">${n} 条全部删除，<b>不可恢复</b></div>
    <div style="font-size:13px;line-height:1.9;margin:10px 0">
      ${running ? `<div>· 其中 <b>${running} 条正在跑</b>：费用照算，但结果不会再显示。</div>` : ''}
      <div>· 工作目录里的文件不会被删。</div>
    </div>
    <div class="modal-actions">
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg danger" data-act="clear-confirm" data-kind="${isChat ? 'chat' : 'task'}">全部删除</button>
    </div>`)
}

/*
 * 真删。
 *
 * 三个细节都不是可选的：
 *  1. **跟着会话走的瞬态要一起清**（草稿 `cid:mid`、广播开关 `cid`）——
 *     不清的话这些键会永远留在内存里，而且下次新建会话万一撞 id 就会"莫名带着上次的字"。
 *  2. 删的正好是**当前打开**的那条 → `active` 回到 blank（也就是选择页）。
 *     否则 render() 找不到会话，主区会白屏或者报错。
 *  3. 清理完立刻 saveState()：用户下一秒可能就刷新页面。
 */
function forgetChatTransients(id) {
  for (const k of Object.keys(state.drafts)) if (k.startsWith(`${id}:`)) delete state.drafts[k]
  delete state.broadcast[id]
}

function deleteChat(id) {
  const i = state.chats.findIndex((c) => c.id === id)
  if (i < 0) return false
  state.chats.splice(i, 1)
  forgetChatTransients(id)
  if (state.active.type === 'chat' && state.active.id === id) state.active = { type: 'blank', id: null }
  closeModal(); render(); saveState()
  return true
}

function deleteTask(id) {
  const i = state.tasks.findIndex((t) => t.id === id)
  if (i < 0) return false
  state.tasks.splice(i, 1)
  if (state.active.type === 'task' && state.active.id === id) state.active = { type: 'blank', id: null }
  closeModal(); render(); saveState()
  return true
}

function clearAllChats() {
  const n = state.chats.length
  for (const c of [...state.chats]) forgetChatTransients(c.id)
  state.chats = []
  if (state.active.type === 'chat') state.active = { type: 'blank', id: null }
  closeModal(); render(); saveState()
  return n
}

function clearAllTasks() {
  const n = state.tasks.length
  state.tasks = []
  if (state.active.type === 'task') state.active = { type: 'blank', id: null }
  closeModal(); render(); saveState()
  return n
}

function openMemberNotes(id) {  const m = memberById(id)
  if (!m) return
  openModal(`
    <h3>${esc(m.name)}</h3>
    <div class="sub">${esc(m.id)} · 能力 [${esc((m.capabilities || []).join(', '))}] · 计费 ${esc(billingLabel(m.billing))}</div>
    <pre style="white-space:pre-wrap;font-size:12px;line-height:1.7;margin:0">${esc(m.notes || '（无笔记）')}</pre>
    <div class="modal-actions"><button class="btn-lg primary" data-act="close-modal">关闭</button></div>`)
}

function openAddMemberModal() {
  openModal(`
    <h3>添加自定义成员</h3>
    <div class="sub">添加后会立刻真跑一次探活；探不通会<b>自动回滚</b>，不会往配置里留垃圾。</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>成员 id（小写英文）<input class="text-in" id="nmId" placeholder="myagent"></label>
      <label>显示名称<input class="text-in" id="nmName" placeholder="我的 Agent"></label>
    </div>
    <label style="display:block;margin-top:10px">可执行文件 / 命令<input class="text-in" id="nmCmd" placeholder="C:\\path\\to\\agent.cmd 或 agent-cli"></label>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
      <label>参数模板（逗号分隔）<input class="text-in" id="nmArgs" placeholder="-p"></label>
      <label>prompt 怎么传
        <select class="sel" id="nmMode" style="width:100%;height:32px">
          <option value="stdin">stdin（最安全）</option>
          <option value="arg">{prompt} 占位</option>
          <option value="file">{promptFile} 落临时文件</option>
        </select></label>
      <label>默认权限档
        <select class="sel" id="nmPerm" style="width:100%;height:32px">
          ${PERMS.map((p) => `<option value="${p.id}"${p.id === 'plan' ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select></label>
    </div>
    <label style="display:block;margin-top:10px">能力标签（逗号分隔）<input class="text-in" id="nmCaps" value="code"></label>
    <div class="sub" style="margin-top:6px">能力标签只描述"能干什么"，不要写 free/免费 —— 它会被规划者读到并影响派活。</div>
    <div class="modal-actions">
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" data-act="submit-member">添加并探活</button>
    </div>`)
}

// ── 新建会话 ──

function openNewChatModal() {
  const usable = state.members.filter((m) => m.available)
  const unusable = state.members.filter((m) => !m.available)
  openModal(`
    <h3>新建会话</h3>
    <div class="sub">勾 1 个成员 → 单栏对话；勾 2 个以上 → 并排分屏（可广播）。</div>
    ${usable.map((m) => `<label class="checkbox-item">
      <input type="checkbox" class="chat-pick" value="${esc(m.id)}">
      <span style="flex:1">${esc(m.name)}</span>
      <span style="font-size:11px;color:var(--text-faint)">${esc(m.version || '')} · 默认${esc(permLabel(m.defaultPermission))}档 · 计费${esc(billingLabel(m.billing))} · [${esc((m.capabilities || []).join(', '))}]</span>
    </label>`).join('')}
    ${unusable.length ? `<div class="sub" style="margin:12px 0 4px">不可用（置灰，附原因）</div>
      ${unusable.map((m) => `<label class="checkbox-item" style="opacity:.45">
        <input type="checkbox" disabled>
        <span style="flex:1">${esc(m.name)}</span>
        <span style="font-size:11px;color:var(--fail)">${esc(listText(m.reason, 60))}</span>
      </label>`).join('')}` : ''}
    <div class="modal-actions">
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" data-act="create-chat">创建</button>
    </div>`)
}

function createChat(memberIds) {
  if (!memberIds.length) return toast('至少选一个成员', 'err')
  const chat = {
    id: uid('c'),
    title: memberIds.map(memberName).join(' + '),
    memberIds,
    threads: Object.fromEntries(memberIds.map((id) => [id, []])),
    busy: {},
    lastStatus: {},
  }
  state.chats.unshift(chat)
  state.active = { type: 'chat', id: chat.id }
  if (memberIds.length >= 2) state.sidebarMini = true   // 并排 ≥2 面板 → 左栏自动收成图标条（设计文档 §5）
  closeModal()
  render()
  saveState()
}

// ── 新建协同：拆解 → 计划确认表 → 执行 ──

let planDraft = null

function openNewTaskModal() {
  planDraft = null
  /*
   * 「谁来拆解」的候选 = 实测可用的成员 + **主脑（WorkBuddy）**，且**默认选成员**。
   *
   * 两条路的语义完全不同，界面必须说清：
   *  - **选成员（默认）**：引擎用这个成员当规划者**代拆** —— 立刻出计划表，确认后成员们
   *    就在本软件里跑完。这是"直接在这个软件里干活"的那条路，不用切到别的软件。
   *  - **选主脑**：引擎**不拆**。它把目标存成一份待拆解请求（有留痕、可核对），
   *    真正的拆解由 WorkBuddy 从 MCP 那侧过来做（它没有 CLI，引擎调不动它）——
   *    这条路要用户切到 WorkBuddy 里粘一句话。
   */
  const orch = state.orchestrator
  // ★ 默认值走 pickedPlanner()：它会把「选中的那个真的可用吗」验过再写回 state（见函数上方那段）
  const planner = pickedPlanner()
  const candidates = state.members.filter((m) => m.available)
  const usingOrch = !!orch && planner === orch.id

  openModal(`
    <h3>新建协同任务</h3>
    <div class="sub">只写目标。先拆解、出「执行计划确认表」等你改完再执行 —— 不会拆完就跑。</div>
    <textarea class="goal-box" id="goalBox" placeholder="例如：给 src/utils.js 的 5 个导出函数补单元测试，并写一份 README 章节说明测试覆盖了什么"></textarea>
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <span style="font-size:12px;color:var(--text-dim);flex:0 0 auto">谁来拆解</span>
      <select class="sel" id="plannerSel" data-act="planner-sel">
        ${candidates.map((m) => `<option value="${esc(m.id)}"${m.id === planner ? ' selected' : ''}>${esc(m.name)}（在本软件里拆解）</option>`).join('')}
        ${orch ? `<option value="${esc(orch.id)}"${usingOrch ? ' selected' : ''}>${esc(orch.name)}（主脑 · 要切到它那边粘一句话）</option>` : ''}
      </select>
      <span class="grow"></span>
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" id="planBtn" data-act="do-plan">${usingOrch ? '交给主脑' : '拆解'}</button>
    </div>
    <div class="planner-hint" id="plannerHint">${esc(plannerHintText(planner))}</div>`)
  setTimeout(() => byId('goalBox')?.focus(), 30)
}

/** 两种拆解路径的差别 —— 就写在一起，让用户自己选，别靠猜 */
function plannerHintText(planner) {
  const orch = state.orchestrator
  if (orch && planner === orch.id) {
    return `${orch.name} 没有命令行，引擎调不动它 —— 选它表示「引擎不拆，把目标交给主脑」。` +
      `点下面那个按钮只会把目标存成一份待拆解请求，再给你一句要去那个软件里粘的话。` +
      `想就在本软件里干活，就换成上面的成员（引擎让它代拆，立刻出计划表）。`
  }
  /*
   * ⚠️ 这里不能写 `**代拆**`。这段文本的两个调用点（首页工作台与弹窗）都过 `esc()`，
   * 所以 HTML 标签进来会变成字面的尖括号 —— 而 markdown 的星号更糟：
   * 它会被**原样印在界面上**，用户看到的就是两颗星。要强调就用中文自己造词（「代拆」加引号），
   * 或者由调用方决定怎么包标签。
   */
  return '引擎让这个成员当规划者「代拆」：直接出计划表，你确认后成员们就在本软件里跑完 —— 不用切到别的软件。'
}

async function doPlan(goalOverride) {
  // 重拆时模态框里已经没有目标输入框了，所以从四处依次兜底
  // （首页协同页签的 homeGoalBox 与弹窗的 goalBox 不会同时可见，但 id 是两套，都认）
  const goal = String(goalOverride || byId('goalBox')?.value || byId('homeGoalBox')?.value || planDraft?.goal || '').trim()
  /*
   * 选中的拆解者**要过一遍校验**（`pickedPlanner` 会把结论写回 state）。
   * 原来这里是裸的 `|| state._planner`：成员掉线之后那个 id 在 select 里根本不存在，
   * value 是空串（falsy）→ 又退回 state._planner → 于是**界面显示一个人、实际调用另一个人**。
   */
  const typed = byId('plannerSel')?.value || byId('homePlannerSel')?.value
  if (typed) state._planner = typed
  const memberId = pickedPlanner()
  if (!goal) return toast('先写个目标', 'err')

  // 主脑没有 CLI —— 引擎调不动它，只能把请求交出去（走 MCP 反向通道）
  if (state.orchestrator && memberId === state.orchestrator.id) return handOffToOrchestrator(goal)

  /*
   * 按钮要能**回到空闲态**。
   *
   * 实测（2026-09-30 做工作台时）：`#homePlanBtn` 和弹窗里的 `#planBtn` 不是一回事 ——
   * 后者随弹窗整个被换掉，前者是页面上的常驻元素。原来只有 catch 分支恢复它，
   * 成功分支直接把确认表盖上去走人，于是关掉确认表后那个按钮还停在
   * 「拆解中…」且 disabled，再点它什么都不会发生，看起来像卡死。
   */
  const btn = byId('planBtn') || byId('homePlanBtn')
  const idleBtn = () => { if (btn) { btn.disabled = false; btn.textContent = '拆解' } }
  if (btn) { btn.disabled = true; btn.textContent = '拆解中…' }
  try {
    // 勾了分工就一起送过去；没勾就是空数组，规划者自己从目录里挑
    const r = await api('/api/plan', { method: 'POST', body: { goal, memberId, roles: state._roles } })
    /*
     * 把这一次拆解的诊断信息留在 state 上。
     * 动机（实测）：失败时只看到"没拆出可用计划"，无法判断是"模型没按 JSON 答"
     * 还是"输出被截断"还是"端点在抽风"。留一份结构化诊断，界面和实跑脚本都能读，
     * 不用再去猜 raw 的长度。
     */
    state._lastPlanDiag = {
      ok: !!r.plan,
      repaired: !!r.repaired,
      repairReason: r.repairReason || '',
      rawLength: r.rawLength ?? (r.raw || '').length,
      subtaskCount: r.plan?.subtasks?.length ?? 0,
      plannerStatus: r.plannerStatus || '',
      roster: r.roster || [],
      // 实际生效的分工 + 被丢掉的角色名（服务端会滤掉目录里不认识的）
      roles: r.roles || [],
      droppedRoles: r.droppedRoles || [],
      durationMs: r.durationMs ?? 0,
      at: new Date().toISOString(),
    }
    /*
     * 有角色名被服务端丢掉了就得说一声。
     * 用户勾了 3 个、计划里只出来 2 个，不解释的话他只能猜是引擎丢了还是规划者没照办。
     */
    if (r.droppedRoles?.length) {
      toast(`有 ${r.droppedRoles.length} 个角色名服务端不认识，已忽略：${r.droppedRoles.join('、')}`, 'err')
    }
    if (r.plan) {
      planDraft = r.plan
      idleBtn()
      renderPlanTable(goal, { repaired: r.repaired, repairReason: r.repairReason, roster: r.roster })
    } else {
      idleBtn()
      // 把真实输出长度显示出来：以前这里只贴内容，而服务端又把内容切到 2000 字符，
      // 导致"输出被截断"这个最关键的信息看不出来（实测踩过）。现在长度单独给出。
      const len = r.rawLength ?? (r.raw || '').length
      openModal(`
        <h3>没拆出可用的计划</h3>
        <div class="sub">主脑的原始输出在下面，共 ${len} 字符。可能是它没按 JSON 格式回答，也可能这个成员压根没干活 —— 别急着往下走，先看一眼。</div>
        <pre style="white-space:pre-wrap;font-size:12px;max-height:40vh;overflow:auto">${esc(r.raw || '（空）')}</pre>
        <div class="modal-actions">
          <button class="btn-lg" data-act="close-modal">取消</button>
          <button class="btn-lg primary" data-act="back-to-goal">改目标重拆</button>
        </div>`)
    }
  } catch (e) {
    toast(`拆解失败：${e.message}`, 'err')
    idleBtn()
  }
}

/**
 * 「交给主脑」—— 引擎**不替主脑拆**，只把目标存成待拆解请求。
 *
 * 为什么只能这样：主脑（WorkBuddy）没有 CLI，引擎没法像调 claude 那样"调用"它。
 * 它只能从另一侧过来 —— 作为 MCP 客户端调 `agenthub_run_plan`（见 mcp-server/index.js）。
 * 所以界面在这里做两件**真实**的事：
 *   1. 把请求落盘（`.agenthub/inbox/`），让"我交过了"有留痕、可核对；
 *   2. 给出一句可以直接交给 WorkBuddy 的话。
 *
 * 刻意**不**做的是：假装界面上有个队列在转、或者显示一个假的"等待中"。
 * 拆解由主脑做，它拆完要不要回到界面确认是它的选择，引擎替它决定不了。
 */
async function handOffToOrchestrator(goal) {
  /*
   * ★ 两个按钮都要认。
   * 这条路有两个入口（弹窗的 `planBtn`、工作台的 `homePlanBtn`），原来只找 `planBtn` ——
   * 从工作台点「交给主脑」时一个按钮都拿不到，于是请求在飞的那几秒里界面上**毫无反应**，
   * 用户会以为没点着，接着再点一次（就多落一份待拆解请求）。
   */
  const btn = byId('planBtn') || byId('homePlanBtn')
  const idle = () => { if (btn) { btn.disabled = false; btn.textContent = '交给主脑' } }
  if (btn) { btn.disabled = true; btn.textContent = '交给主脑…' }
  try {
    // 分工跟着请求一起落盘（见 server.js 的 apiPlanRequest）—— 不带上就是无声丢数据
    const r = await api('/api/plan/request', { method: 'POST', body: { goal, roles: state._roles } })
    state._handoffGoal = goal   // 弹窗里那条「改用本软件里的成员来拆」要把目标带过去
    idle()
    const line = `处理 .agenthub/inbox/${r.id}.json 里待拆解的任务`
    state._handoff = line
    openModal(`
      <h3>已交给主脑</h3>
      <div class="sub">目标已存成一份待拆解请求 —— 有留痕，你随时能回来核对：</div>
      <pre class="path-line">${esc(r.file)}</pre>
      <div class="sub" style="margin-top:12px">接下来把下面这句话交给 WorkBuddy。它会读那份请求、拆好，并调用
        <code>agenthub_run_plan</code> 执行 —— 引擎自己不会拆。</div>
      <div class="sub">不想切到别的软件？点下面的「改用本软件里的成员来拆」—— 同样这几步就在这儿跑完。</div>
      <pre class="handoff-line" id="handoffLine">${esc(line)}</pre>
      <div class="modal-actions">
        <button class="btn-lg" data-act="close-modal">知道了</button>
        <button class="btn-lg" data-act="plan-in-app">改用本软件里的成员来拆</button>
        <button class="btn-lg primary" data-act="copy-handoff">复制这句话</button>
      </div>`, true)
  } catch (e) {
    toast(`交给主脑失败：${e.message}`, 'err')
    idle()
  }
}

function renderPlanTable(goal, extra = {}) {
  const subs = planDraft.subtasks || []
  // 规划者输出被截断时，这里必须说出来。否则用户只看到"拆出 2 个子任务"，
  // 根本不知道原本可能还有第 3、4 个 —— 会被当成"计划本来就这么短"。
  const warn = extra.repaired
    ? `<div style="margin:8px 0;padding:8px 10px;border-radius:6px;
         background:rgba(240,180,40,.14);border:1px solid rgba(240,180,40,.45);font-size:12px;line-height:1.7">
        ⚠️ 规划者的输出被截断了（${esc(extra.repairReason || '内容不完整')}），已尽量保住写完的部分，共 ${subs.length} 个子任务。
        <b>它可能没把活拆完</b> —— 缺的可以「+ 手动加一个子任务」补上，或换个规划者「重新拆解」。
      </div>`
    : ''
  openModal(`
    <h3>执行计划确认</h3>
    <div class="sub">目标：${esc(goal)} —— 主脑拆出 ${subs.length} 个子任务。成员和角色都可以当场改，改完才落盘执行。</div>
    ${warn}
    <div id="planRows">
      ${subs.map((s, i) => planRowHtml(s, i)).join('')}
    </div>
    <div style="margin:10px 0">
      <button class="mini-btn" data-act="plan-add">+ 手动加一个子任务</button>
      <button class="mini-btn" data-act="replan">重新拆解</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:12px;color:var(--text-dim);flex:0 0 auto">执行权限档</span>
      <select class="sel" id="taskPerm" data-act="plan-perm">
        ${PERMS.map((p) => `<option value="${p.id}"${p.id === state.permission ? ' selected' : ''}>${esc(p.label)} —— ${esc(p.hint)}</option>`).join('')}
      </select>
    </div>
    <div class="plan-perm-caveat" id="planPermCaveat">${esc(planPermCaveat(planDraft, state.permission))}</div>
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--text-dim);flex:0 0 auto">某步失败后</span>
      <select class="sel" id="taskPolicy">
        ${FAILURE_POLICIES.map((p) => `<option value="${p.id}"${p.id === state.failurePolicy ? ' selected' : ''}>${esc(p.label)} —— ${esc(p.hint)}</option>`).join('')}
      </select>
      <span class="grow"></span>
      <button class="btn-lg" data-act="close-modal">取消</button>
      <button class="btn-lg primary" data-act="confirm-task">确认执行</button>
    </div>`, true)
}

/**
 * 计划表里那一行的「角色说明 + 能力匹配结论」。
 *
 * 单独抽出来是因为它**要能就地重画**：用户在这张表里换成员、换角色是最常见的动作，
 * 结论必须当场跟着变，否则「✓」会停在旧的组合上 —— 那比不显示更坏。
 *
 * 这里显示的正是"分工再详细点"要的东西：这个角色**做什么**、**交出什么**，
 * 以及**现在派的这个人干不干得了**。规划者的提示词一直在叮嘱它别派错人，
 * 但结论从来没显示给用户看过。
 */
function planRoleNoteHtml(roleLabel, memberId) {
  const info = roleInfo(roleLabel)
  const who = memberById(memberId)
  const parts = []
  if (info) {
    parts.push(`<div class="pr-role"><span class="pr-k">职责</span>${esc(info.duty)}</div>`)
    parts.push(`<div class="pr-role"><span class="pr-k">交付物</span>${esc(info.deliverable)}</div>`)
  } else if (roleLabel) {
    // 认不出的角色也得说清楚会发生什么，而不是留一行空白让人猜
    parts.push(`<div class="pr-role"><span class="pr-k">未知角色</span>目录里没有「${esc(roleLabel)}」——
      引擎只会给它一句通用说明。建议换成目录里的角色。</div>`)
  }
  for (const n of roleFit(roleLabel, who).notes) parts.push(`<div class="pr-misfit">⚠️ ${esc(n)}</div>`)
  return parts.join('')
}

function planRowHtml(s, i) {
  const usable = state.members.filter((m) => m.available)
  /*
   * 成员下拉也要**兜住当前值**，理由和下面 roles 那段一模一样，但后果更严重。
   *
   * 计划可能把某一步派给一个**当下不可用**的成员（主脑拆的、或者拆完这个成员才掉线）。
   * 只列可用成员的话，`<option>` 里没有那一项，浏览器就把 select 显示成**第一项** ——
   * 于是这一行看着派给了 Claude，`planRoleNoteHtml(s.role, s.memberId)` 却在拿豆包算结论：
   * 下拉说 Claude、警告说豆包，用户没法判断哪句是真的。而 `collectPlanFromDom()` 提交时
   * 读的是**下拉的值**，也就是真按 Claude 跑 —— 屏幕上那句"派给了豆包"是假的，
   * 偏偏它又是唯一解释得通"为什么有这条警告"的线索。显示什么就提交什么，这一条不能破。
   */
  const memberOpts = usable.map((m) => ({ id: m.id, name: m.name, off: false }))
  const curMember = memberById(s.memberId)
  if (curMember && !memberOpts.some((o) => o.id === curMember.id)) {
    memberOpts.push({ id: curMember.id, name: curMember.name, off: true })
  }
  /*
   * 角色下拉 = 目录里的全部 label，再把当前值兜进来。
   * 兜是为了**未知角色不被静默改掉**：计划可能来自旧版本存档，也可能是主脑拆的、
   * 用了我们没见过的名字。不兜的话那一行的角色会被悄悄换成目录里的第一项 ——
   * 等于替用户改了计划，而他还以为这就是拆出来的结果。
   */
  const labels = roleList().map((r) => r.label)
  const roles = s.role && !labels.includes(s.role) ? [s.role, ...labels] : labels
  // 缺指令的行必须一眼看得出来 —— 否则它长得跟正常行一模一样，
  // 用户会以为计划没问题，点执行才被拒（2026-09-29 第二轮实跑踩到）。
  const missing = !String(s.prompt || '').trim()
  const warn = missing
    ? `<div style="margin-top:6px;font-size:12px;color:#e0533d">⚠️ 这一行没有指令，直接执行会被拒 —— 在下面补上，或点「删除」去掉这一行</div>`
    : ''
  return `<div class="plan-row" data-sid="${esc(s.id)}"${missing ? ' data-broken="1"' : ''}>
    <div class="inline">
      <span class="card-idx">${i + 1}</span>
      <select class="sel plan-member">${memberOpts.map((o) => `<option value="${esc(o.id)}"${o.id === s.memberId ? ' selected' : ''}>${esc(o.name)}${o.off ? '（未连接）' : ''}</option>`).join('')}</select>
      <select class="sel plan-role">${roles.map((r) => `<option value="${esc(r)}"${r === s.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <span class="dep">${(s.dependsOn || []).length ? `依赖 ${s.dependsOn.join('、')}` : '无依赖'}</span>
      <span class="grow"></span>
      <button class="mini-btn" data-act="plan-toggle">编辑指令</button>
      <button class="mini-btn" data-act="plan-del">删除</button>
    </div>
    <div class="pr-title">${esc(s.title || '')}</div>
    <div class="pr-note" data-role-note>${planRoleNoteHtml(s.role, s.memberId)}</div>
    ${warn}
    <textarea class="prompt-box plan-prompt" style="${missing ? '' : 'display:none;'}margin-top:6px;min-height:76px">${esc(s.prompt || '')}</textarea>
  </div>`
}

/** 把计划表的当前 DOM 收回到一个 plan 对象 —— 用户在表里改过的成员/角色/指令都要算数 */
function collectPlanFromDom() {
  const rows = [...document.querySelectorAll('#planRows .plan-row')]
  const subtasks = rows.map((row) => {
    const orig = planDraft?.subtasks?.find((s) => s.id === row.dataset.sid)
    return {
      id: row.dataset.sid,
      title: orig?.title,
      memberId: row.querySelector('.plan-member')?.value,
      role: row.querySelector('.plan-role')?.value,
      prompt: row.querySelector('.plan-prompt')?.value || '',
      // 依赖关系不在表里改（改了图容易画错），沿用主脑拆的
      dependsOn: orig?.dependsOn || [],
    }
  })
  return { goal: planDraft.goal, subtasks }
}

async function confirmTask() {
  const plan = collectPlanFromDom()
  if (!plan.subtasks.length) return toast('计划是空的', 'err')

  /*
   * 本地先校验一遍，别把问题推给服务端。
   *
   * 起因（2026-09-29 第二轮真跑）：拆解被截断、抢救出一个 s3 少了 prompt 的计划，
   * 界面照常渲染、照常放行「确认执行」，点下去才弹
   * 「服务端错误：计划校验失败 — 子任务 s3 缺少 prompt」。
   * 用户白点一次，而且**界面上根本没提示是哪一行缺**。
   * 现在在点按钮这一步就拦住，并直接点名哪几行没指令。
   */
  const noPrompt = plan.subtasks.filter((s) => !String(s.prompt || '').trim())
  if (noPrompt.length) {
    return toast(`${noPrompt.map((s) => s.id).join('、')} 还没填指令 —— 点「编辑指令」补上再执行`, 'err')
  }
  const noMember = plan.subtasks.filter((s) => !s.memberId)
  if (noMember.length) {
    return toast(`${noMember.map((s) => s.id).join('、')} 没有指定成员`, 'err')
  }

  const permission = byId('taskPerm')?.value || state.permission
  const failurePolicy = byId('taskPolicy')?.value || state.failurePolicy
  state.failurePolicy = failurePolicy   // 记住这次的选择，下次拆解时默认用它

  const task = {
    id: uid('t'),
    title: plan.goal.length > 22 ? plan.goal.slice(0, 22) + '…' : plan.goal,
    goal: plan.goal,
    plan,
    permission,
    failurePolicy,
    status: 'running',
    cards: {},
    cardOrder: [],
    logs: [],
    summary: null,
    markdown: '',
    startedAt: Date.now(),
  }
  state.tasks.unshift(task)
  state.active = { type: 'task', id: task.id }
  if (plan.subtasks.length >= 3) state.sidebarMini = true
  closeModal()
  render()
  saveState()

  await runTask(task)
}

/**
 * 打开一条 SSE 通道，把事件喂给这张任务卡。
 *
 * 首跑（`/api/run`）和单卡片重跑（`/api/retry`）**共用这一个函数** ——
 * 两条通道的事件格式是一样的，前端就该只有一套处理逻辑。
 * 分成两套的后果很具体：重跑之后界面显示的还停在旧状态，或者少更新一个字段。
 */
async function streamTask(task, url, body, { failMsg = '协同任务中断' } = {}) {
  const ac = new AbortController()
  task._ac = ac
  const log = (text) => {
    task.logs.push({ t: ts(), text })
    if (task.logs.length > 800) task.logs.shift()
  }
  task.status = 'running'
  render()

  try {
    await ssePost(url, body, (evt) => onTaskEvent(task, evt, log), ac.signal)
  } catch (e) {
    if (e.name === 'AbortError') {
      task.status = 'interrupted'
      log('已被手动停止')
    } else {
      task.status = 'failed'
      log(`通道异常：${e.message}`)
      toast(`${failMsg}：${e.message}`, 'err')
    }
  } finally {
    if (task.status === 'running') task.status = 'done'
    for (const c of Object.values(task.cards)) if (c.status === 'run') c.status = 'fail'
    render()
    saveState()
  }
}

async function runTask(task) {
  await streamTask(task, '/api/run', {
    // 带上去，服务端要按它存这次运行的现场 —— 之后单卡片重跑靠它
    taskId: task.id,
    plan: task.plan,
    permission: task.permission,
    // 服务端/引擎那边的选项名是 onFailure，界面上叫"某步失败后"（failurePolicy）
    onFailure: task.failurePolicy,
    workdir: state.workdir,
  })
}

/**
 * 单卡片重跑 / 换人 / 跳过。
 *
 * 省钱的地方在服务端和引擎侧：已经成功的步骤**不会被重跑**，
 * 所以这里不必再问"要不要连前面的一起重来" —— 它根本不会。
 */
async function retryCard(task, id, action, memberId) {
  await streamTask(task, '/api/retry', { taskId: task.id, id, action, memberId },
    { failMsg: '重试通道中断' })
}

function onTaskEvent(task, evt, log) {
  switch (evt.type) {
    case 'open':
      log('已连接执行通道')
      break

    case 'plan-accepted':
      task.batches = evt.batches
      task.cardOrder = evt.batches.flat()
      for (const st of task.plan.subtasks) {
        task.cards[st.id] = {
          id: st.id, title: st.title, memberId: st.memberId, role: st.role,
          prompt: st.prompt, status: 'wait', startedAt: 0, durationMs: 0,
          text: '', cost: {}, quality: null, changedFiles: null,
          degradedUpstream: [], skipKind: '', _tid: task.id,
        }
      }
      log(`计划校验通过，分 ${evt.batches.length} 批执行`)
      break

    case 'plan-start':
      log(`开始执行：${evt.goal}`)
      if (evt.policy) log(`失败策略：${policyLabel(evt.policy)} —— ${policyHint(evt.policy)}`)
      break

    case 'batch-start':
      log(`第 ${evt.index}/${evt.total} 批${evt.parallel ? `（并行 ${evt.ids.length} 个）` : ''}：${evt.ids.join('、')}`)
      break

    case 'subtask-start': {
      const c = task.cards[evt.id]
      if (c) {
        c.status = 'run'
        c.startedAt = Date.now()
        // 清掉上一次的产出与判定 —— 否则重跑期间界面还挂着旧结果，
        // 看起来像"这次跑完了"，而其实这次刚开始
        c.text = ''
        c.quality = null
        c.degradedUpstream = []
        c.skipKind = ''
      }
      log(`▶ [${evt.id}] ${evt.memberName} / ${evt.role || '执行者'} 开始` +
        ((evt.degradedUpstream || []).length ? `　⚠️ 上游缺 ${evt.degradedUpstream.join('、')} —— 带缺口执行` : ''))
      break
    }

    case 'subtask-member-changed': {
      // 换人改的是计划本身，界面两边都要跟上，否则卡片上还写着旧成员
      const c = task.cards[evt.id]
      const st = (task.plan?.subtasks || []).find((s) => s.id === evt.id)
      if (c) c.memberId = evt.to
      if (st) st.memberId = evt.to
      log(`↺ [${evt.id}] 换人：${memberName(evt.from)} → ${memberName(evt.to)}`)
      break
    }

    case 'resume-ack': {
      const what = { retry: '重跑', swap: '换人重跑', skip: '跳过' }[evt.action] || evt.action
      log(`↻ 单卡片${what} [${evt.id}] —— 已经成功的步骤不会重跑，不会再花一遍钱`)
      break
    }

    case 'resume-start': {
      const prev = evt.previous
      log(`接着跑：${evt.onlyId ? `补跑 [${evt.onlyId}] 及其后续` : '补跑剩余步骤'}` +
        (prev ? `（此前 ${prev.okCount}/${prev.subtaskCount} 成功 · ${prev.skippedCount} 未执行）` : ''))
      break
    }

    case 'plan-updated':
      // 计划的唯一权威在服务端（换人会改它）；这里只做同步
      task.plan = evt.plan
      for (const st of evt.plan.subtasks || []) {
        if (task.cards[st.id]) task.cards[st.id].memberId = st.memberId
      }
      break

    case 'subtask-finish': {
      const c = task.cards[evt.id]
      if (c) {
        c.status = evt.status === 'ok' ? 'done' : 'fail'
        c.text = evt.text || ''
        c.cost = evt.cost || {}
        c.quality = evt.quality || null
        // 数组 = 确实采集过；null/undefined = 未采集 —— 两者在界面上必须长得不一样
        c.changedFiles = Array.isArray(evt.changedFiles) ? evt.changedFiles : null
        // 空数组 = 上游齐备；非空 = 这次是带着缺口跑的（salvage 策略）
        c.degradedUpstream = Array.isArray(evt.degradedUpstream) ? evt.degradedUpstream : []
        c.durationMs = evt.durationMs || 0
        c.startedAt = 0
      }
      const sus = evt.quality?.level === 'suspect' ? '  ⚠️ 产出可疑' : ''
      const gap = (evt.degradedUpstream || []).length ? `  ⚠️ 上游缺 ${evt.degradedUpstream.join('、')}` : ''
      const chg = Array.isArray(evt.changedFiles) ? ` · 改动 ${evt.changedFiles.length} 文件` : ''
      log(`■ [${evt.id}] ${evt.memberName} ${evt.status} · ${fmtMs(evt.durationMs)}${chg}${gap}${sus} — ${listText(evt.text, 70)}`)
      break
    }

    case 'subtask-skip': {
      /*
       * 「未执行」是第三种状态，不能塞进 fail 里 ——
       * 那会让人以为"跑过但挂了"，去点重试，而实际上引擎根本没调用成员、一分钱没花。
       */
      const c = task.cards[evt.id]
      if (c) {
        c.status = 'skip'
        c.text = evt.text || ''
        c.skipKind = evt.skipKind || ''
        c.durationMs = 0
        c.startedAt = 0
      }
      log(`⊘ [${evt.id}] 未执行 · ${evt.text || ''}`)
      break
    }

    case 'aborted':
      log(`✖ 中止：${evt.reason}`)
      toast(evt.reason, 'err')
      break

    case 'plan-finish': {
      task.summary = evt.summary
      const s = evt.summary
      const skip = s.skippedCount ? ` · ${s.skippedCount} 未执行（引擎未调用成员）` : ''
      const gap = s.degradedCount ? ` · ${s.degradedCount} 个带缺口` : ''
      // 和报告、命令行三边对齐：可疑产出也必须在完成行里说出来，
      // 否则"3/3 成功"看着像个干净收尾
      const sus = s.suspectCount ? ` · ${s.suspectCount} 个产出可疑` : ''
      log(`全部结束：${s.okCount}/${s.subtaskCount} 成功 · ${s.failedCount} 失败${skip}${gap}${sus}`)
      if (s.skippedCount) {
        log(`　（未执行的原因：${describeSkips(s.skippedByKind)}）`)
      }
      break
    }

    case 'trace':
      task.markdown = evt.markdown || ''
      task.summary = evt.summary || task.summary
      log('轨迹报告已生成（任务头里可查看）')
      break

    case 'error':
      log(`✖ 服务端错误：${evt.message}`)
      if (evt.errors) log(`  ${evt.errors.join('；')}`)
      task.status = 'failed'
      break

    default:
      log(`（未识别事件 ${evt.type}）`)
  }
  paintTask(task)
}

// ══════════════════════════════════════════ 会话：发指令

async function sendToMember(chat, mid, text) {
  const thread = chat.threads[mid] || (chat.threads[mid] = [])
  thread.push({ role: 'user', text })
  chat.busy[mid] = true
  state.drafts[`${chat.id}:${mid}`] = ''
  render()

  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: { memberId: mid, prompt: text, permission: state.permission, workdir: state.workdir },
    })
    thread.push({
      role: 'ai',
      text: r.text || '（空产出）',
      meta: { status: r.status, ms: r.durationMs, cost: r.cost, exit: r.raw?.exitCode, cmd: r.raw?.command },
    })
    chat.lastStatus[mid] = r.status
  } catch (e) {
    thread.push({ role: 'ai', text: `调用失败：${e.message}`, meta: { status: 'failed' } })
    chat.lastStatus[mid] = 'failed'
  } finally {
    chat.busy[mid] = false
    chat.broadcastTick = {}
    render()
    saveState()
  }
}

async function handleSend(chatId, mid) {
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) return
  const text = (state.drafts[`${chatId}:${mid}`] || '').trim()
  if (!text) return
  state.drafts[`${chatId}:${mid}`] = ''

  const broadcast = !!state.broadcast[chatId]
  if (!broadcast || chat.memberIds.length < 2) {
    chat.broadcastTick = {}
    await sendToMember(chat, mid, text)
    return
  }

  if (chat.memberIds.some((id) => chat.busy?.[id])) {
    state.drafts[`${chatId}:${mid}`] = text
    render()
    return toast('还有列在跑，等它跑完再广播', 'err')
  }

  // 广播：同一条指令并行发给所有列。各列仍是独立会话，互不依赖、不进入协同任务。
  chat.broadcastTick = {}
  for (const id of chat.memberIds) if (id !== mid) chat.broadcastTick[id] = true

  const jobs = chat.memberIds.map((id) => {
    const t = chat.threads[id] || (chat.threads[id] = [])
    t.push({ role: 'user', text })
    chat.busy[id] = true
    return { id, t }
  })

  // ⚠️ 这一行是必须的：不先渲染一次，用户点完「发送」会**几秒钟毫无反应** ——
  // 消息、忙碌态、"接收广播中"标记全都要等 Promise.all 结束才一次性冒出来。
  // （单列路径的 sendToMember 里有 render()，广播路径早先漏了，是截图抓出来的）
  render()

  await Promise.all(jobs.map(async ({ id, t }) => {
    try {
      const r = await api('/api/chat', {
        method: 'POST',
        body: { memberId: id, prompt: text, permission: state.permission, workdir: state.workdir },
      })
      t.push({
        role: 'ai', text: r.text || '（空产出）',
        meta: { status: r.status, ms: r.durationMs, cost: r.cost, exit: r.raw?.exitCode },
      })
      chat.lastStatus[id] = r.status
    } catch (e) {
      t.push({ role: 'ai', text: `调用失败：${e.message}`, meta: { status: 'failed' } })
      chat.lastStatus[id] = 'failed'
    } finally {
      // 每列各自跑完就各自刷一次 —— 快的先出结果，不必等最慢的那个
      chat.busy[id] = false
      render()
    }
  }))

  chat.broadcastTick = {}
  render()
  saveState()
}

// ══════════════════════════════════════════ 冲突卡片

function openConflictModal(path, mine, current) {
  openModal(`
    <h3>保存冲突</h3>
    <div class="sub"><code>${esc(path)}</code> 从你打开它到现在，已被外部修改过（多半是某个 agent 刚改了它）。
      为避免互相覆盖，这次保存被拦下了。你选怎么处理：</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="mini-btn" data-act="conflict-mode" data-mode="diff">并排看差异</button>
      <span style="font-size:11px;color:var(--text-faint);align-self:center">当前磁盘上的版本 ${esc(current.size)} 字节</span>
    </div>
    <div id="conflictBody" style="max-height:44vh;overflow:auto;font-family:var(--mono);font-size:11.5px;line-height:1.6">
      <div style="color:var(--text-faint)">点上面的「并排看差异」查看改动。</div>
    </div>
    <div class="modal-actions">
      <button class="btn-lg" data-act="conflict-take-theirs">用 agent 的（丢弃我的）</button>
      <button class="btn-lg primary" data-act="conflict-keep-mine">保留我的（覆盖磁盘）</button>
    </div>`)
  window.__conflict = { path, mine, current }
}

/**
 * 极简行级差异。不做真正的 LCS —— 只要能让用户看清"哪一段被换了"就够，
 * 为此实现一个 O(n) 的首尾裁剪版本，中间的变化块整体标出来。
 */
function simpleDiff(a, b) {
  const A = String(a).split('\n')
  const B = String(b).split('\n')
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (
    tail < A.length - head && tail < B.length - head &&
    A[A.length - 1 - tail] === B[B.length - 1 - tail]
  ) tail++

  const rows = []
  for (let i = 0; i < head; i++) rows.push({ type: 'same', text: A[i] })
  for (let i = head; i < A.length - tail; i++) rows.push({ type: 'del', text: A[i] })
  for (let i = head; i < B.length - tail; i++) rows.push({ type: 'add', text: B[i] })
  for (let i = A.length - tail; i < A.length; i++) rows.push({ type: 'same', text: A[i] })
  return rows
}

// ══════════════════════════════════════════ 事件委托

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]')
  if (!t) return
  const act = t.dataset.act

  switch (act) {
    /*
     * ── 左栏：删除 ──
     *
     * 点 × 走的是这里，**不是**上面那条 open-chat：`closest('[data-act]')` 从点击点往上找，
     * 最近的是按钮自己，所以删除按钮不会被外层的"打开会话"吃掉。
     */
    case 'del-chat': delOrAsk('chat', t.dataset.id); break
    case 'del-task': delOrAsk('task', t.dataset.id); break
    /*
     * 整组清空**不吃**「不再提示」那条偏好，永远确认。
     * 一次干掉几十条和删掉一条不是同一个量级的动作，不共用一份授权 ——
     * 用户勾"下次直接删除"时想的是"别老问我要不要删这一条"，不是"允许批量清空"。
     */
    case 'clear-chats': openClearModal('chat'); break
    case 'clear-tasks': openClearModal('task'); break
    case 'del-confirm': {
      // 勾了"下次直接删除" → 现在就记住。本次仍走完确认（框已经弹出来了，
      // 半路改成直删会让"点了删除"这件事的结果变得不确定）
      const noAsk = byId('delNoAsk')?.checked
      const okDone = t.dataset.kind === 'chat' ? deleteChat(t.dataset.id) : deleteTask(t.dataset.id)
      if (!okDone) break
      /*
       * ★ 落完偏好必须**自己再渲染一次左栏**。
       *   deleteChat/deleteTask 内部已经 render() 过了，但那一次读到的还是**旧**偏好
       *   （顺序上偏好是在删除之后才写下去的），于是左栏底部那个「恢复确认」开关
       *   一直不露面 —— 而它正是这条偏好唯一的回头路，就在这一个顺序上丢了。
       */
      if (noAsk) { setAskEnabled(false); renderSidebar() }
      toast(t.dataset.kind === 'chat' ? '会话已删除' : '任务已删除', 'ok',
        noAsk ? { label: '恢复确认', act: 'ask-on' } : null)
      break
    }
    /*
     * 把「删除前先确认」打开，并把左栏底部的开关收回去（renderSidebar 会处理）。
     * ★ 顺手把这条 toast 自己撤掉：留着它，用户下次看见会以为还能点，其实已经开着了。
     */
    case 'ask-on': {
      setAskEnabled(true)
      t.closest('.toast')?.remove()
      renderSidebar()
      toast('删除前会先确认', 'ok')
      break
    }
    case 'clear-confirm': {
      const n = t.dataset.kind === 'chat' ? clearAllChats() : clearAllTasks()
      if (!n) break
      toast(`已删除 ${n} 条${t.dataset.kind === 'chat' ? '会话' : '协同任务'}`, 'ok')
      break
    }

    // ── 顶栏 ──
    case 'open-chat': state.active = { type: 'chat', id: t.dataset.id }; render(); saveState(); break
    /*
     * 换任务时清掉左栏选中的步骤：那个 id 属于上一条任务的计划，
     * 带过去只会指向一个不存在的步骤（虽然 renderTaskView 会兜底回落第一步，
     * 但状态字段本身该是干净的）。
     */
    case 'open-task': state.active = { type: 'task', id: t.dataset.id }; state.pickedStep = null; render(); saveState(); break
    /* 协同任务左栏：切换正在看哪一步。只重渲染主区 —— 顶栏左栏都没变 */
    case 'pick-step': state.pickedStep = t.dataset.id; renderMain(); break

    // ── 主区 ──
    case 'new-chat': openNewChatModal(); break
    case 'new-task': openNewTaskModal(); break
    case 'send': await handleSend(t.dataset.cid, t.dataset.mid); break

    /*
     * 起点卡上的示例指令：**只填草稿，不发**。
     * 填完把焦点和光标送到输入框末尾 —— 点一下就能接着改，
     * 否则用户还得自己再点一次输入框（这种小摩擦一次就够让人不想用）。
     */
    case 'fill-draft': {
      const cid = t.dataset.cid
      const mid = t.dataset.mid
      if (!cid || !mid) break
      state.drafts[`${cid}:${mid}`] = t.dataset.text || ''
      rerenderMain()
      const ta = byId(`ta-${cid}:${mid}`)
      if (ta) {
        ta.focus()
        const n = ta.value.length
        try { ta.setSelectionRange(n, n) } catch { /* 类型不支持就算了，焦点已经过去了 */ }
      }
      break
    }

    // ── 首页页签与成员卡片 ──
    case 'home-tab':
      if (state.homeTab !== t.dataset.tab) { state.homeTab = t.dataset.tab; render(); saveState() }
      break
    case 'home-solo': createChat([t.dataset.id]); break
    /*
     * 工作台左栏勾/取消一个分工。
     * 只改 state 再重渲染，**不碰输入框以外的任何东西** —— 目标还写在 textarea 里，
     * 重渲染会把它擦掉。所以这里把当前值先收回来再放回去（见 homeReRender 的说明）。
     */
    case 'wb-role': {
      const role = t.dataset.role
      if (!role) break
      state._roles = state._roles.includes(role)
        ? state._roles.filter((r) => r !== role)
        : [...state._roles, role]
      // 勾选顺序 = 目录顺序，这样右栏预览的顺序不会随点击乱跳
      state._roles = roleList().map((r) => r.label).filter((l) => state._roles.includes(l))
      rerenderHomeKeepGoal()
      break
    }
    // 单独页签里的 WorkBuddy 卡：打开「交给主脑」弹窗（不是开聊天 —— 主脑没有 CLI）
    case 'orch-handoff': openHandoffModal(); break
    case 'do-handoff': {
      const goal = String(byId('handoffGoal')?.value || '').trim()
      if (!goal) return toast('先写个目标', 'err')
      await handOffToOrchestrator(goal)
      break
    }

    /*
     * 「已交给主脑」弹窗里的一条退路：改用本软件里实测可用的成员来拆。
     * 主脑那条路要用户切到 WorkBuddy 里粘一句话；这个按钮把同一件事交回本软件 ——
     * 换掉拆解者、把刚才那个目标带回输入框，用户接着点「拆解」就能在这儿跑完。
     */
    case 'plan-in-app': {
      const goal = String(state._handoffGoal || '').trim()
      const av = state.members.filter((m) => m.available)
      const pick = av.find((m) => m.id === 'claude') || av[0]
      if (!pick) return toast('现在没有实测可用的成员 —— 先补一个成员的 Key，或者继续交给主脑', 'err')
      state._planner = pick.id
      closeModal()
      openNewTaskModal()
      const box = byId('goalBox')
      if (box && goal) { box.value = goal; box.focus() }
      toast(`已换成 ${pick.name} —— 就在本软件里拆解和执行`, 'ok')
      break
    }

    /*
     * 复制「交给主脑」那句话。
     *
     * 用 navigator.clipboard —— 界面本来就跑在 http://127.0.0.1 上（安全上下文），
     * 这个 API 可用。但**不假设它一定成功**：万一被权限策略拦下，
     * 退化成"帮你把那行选中"，用户按 Ctrl+C 一样能拿到 —— 比一句"复制失败"有用。
     */
    case 'copy-handoff': {
      const line = state._handoff || ''
      try {
        await navigator.clipboard.writeText(line)
        toast('已复制 —— 粘贴到 WorkBuddy 对话里就行', 'ok')
      } catch {
        const el = byId('handoffLine')
        if (el) {
          const range = document.createRange()
          range.selectNodeContents(el)
          const sel = getSelection()
          sel.removeAllRanges()
          sel.addRange(range)
        }
        toast('自动复制被拦下了，已经帮你选中 —— 按 Ctrl+C', 'err')
      }
      break
    }

    // ── 文件树 ──
    case 'tree-into': await loadTree(t.dataset.path); break
    case 'tree-up': {
      const parts = state.treeDir.split('/').filter(Boolean)
      parts.pop()
      await loadTree(parts.join('/') || '.')
      break
    }
    case 'open-file': await openFileInEditor(t.dataset.path); break

    // ── 弹窗通用 ──
    case 'close-modal': closeModal(); break

    /*
     * ── 渲染崩溃面板上的两个按钮（见 renderMainSafe）──
     *
     * 这两个是**用户被锁在外面时唯一能按到的东西**，所以它们自己绝对不能依赖
     * 任何可能已经坏掉的状态：不读 state.tasks、不读 state.active，只做这两件事。
     * 「重开」用 reload 而不是再调一次 render()：崩掉的原因可能还在
     * state 里（比如某个字段是坏的），原地重试常常原样再崩一次 ——
     * 而重新加载会把存档**重新规范化一遍**（loadState → normalizeTask），
     * 那才是真正的修复路径。所以"重开"比"重试"更可能救人。
     */
    case 'crash-retry': render(); break
    case 'crash-reset': {
      try { localStorage.removeItem(LS_KEY) } catch { /* 存不了就算了，重开一样是干净的 */ }
      location.reload()
      break
    }

    // ── 成员管理 ──
    case 'test-member': {
      t.textContent = '测试中…'
      t.disabled = true
      try {
        const r = await api(`/api/probe?id=${encodeURIComponent(t.dataset.id)}`)
        const m = memberById(t.dataset.id)
        if (m) {
          m.available = !!r.available
          m.version = r.version || ''
          m.reason = r.reason || ''
        }
        openMembersModal()
        toast(r.available ? `${memberName(t.dataset.id)} 可用 ${r.version || ''}` : `${memberName(t.dataset.id)} 不可用：${r.reason}`, r.available ? 'ok' : 'err')
      } catch (err) {
        t.textContent = '测试'
        t.disabled = false
        toast(`测试失败：${err.message}`, 'err')
      }
      break
    }
    case 'reprobe-all': {
      closeModal()
      await fetchMembers(true)
      openMembersModal()
      break
    }
    case 'add-member': openAddMemberModal(); break
    case 'member-notes': openMemberNotes(t.dataset.id); break
    /* 点不可用成员卡：看它缺什么（**不是**开聊 —— 开聊必然失败） */
    case 'member-fix': openMemberFixModal(t.dataset.id); break

    case 'submit-member': {
      const member = {
        id: byId('nmId')?.value.trim(),
        name: byId('nmName')?.value.trim(),
        command: byId('nmCmd')?.value.trim(),
        argsTemplate: (byId('nmArgs')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
        promptMode: byId('nmMode')?.value,
        defaultPermission: byId('nmPerm')?.value,
        capabilities: (byId('nmCaps')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      }
      try {
        const r = await api('/api/members/add', { method: 'POST', body: { member } })
        if (r.ok) {
          toast(`已添加 ${r.name}（探活通过 ${r.version || ''}）`, 'ok')
          await fetchMembers(true)
          openMembersModal()
        } else {
          openModal(`
            <h3>添加失败，已回滚</h3>
            <div class="sub">探活没通过，配置里没有留下这条记录。原因：${esc(r.reason)}</div>
            <pre style="white-space:pre-wrap;font-size:11px;max-height:40vh;overflow:auto">${esc(r.raw || '')}</pre>
            <div class="modal-actions"><button class="btn-lg primary" data-act="close-modal">知道了</button></div>`)
        }
      } catch (err) {
        toast(`添加失败：${err.message}`, 'err')
      }
      break
    }

    // ── 新建会话 ──
    case 'create-chat': {
      const ids = [...document.querySelectorAll('.chat-pick:checked')].map((x) => x.value)
      createChat(ids)
      break
    }

    // ── 新建协同 ──
    /*
     * 保存一个 Key：交给服务端写 `.env`，然后**当场**刷新成员列表。
     *
     * 值只去不返 —— 提交后立刻清空输入框，不进 state、不回显、不写日志。
     * 所以这里连"上次填了什么"都拿不到，这是有意的：一个能显示密钥的界面，
     * 也就意味着密钥会出现在 DOM、日志、以及别人的屏幕截里。
     */
    case 'save-key': {
      const input = byId('keyInput')
      const key = byId('keyVar')?.value || input?.dataset.key || ''
      const value = String(input?.value || '').trim()
      if (!key) return toast('没有可填的变量名', 'err')
      if (!value) return toast('先粘贴 Key', 'err')

      const wasOff = new Set(state.members.filter((m) => !m.available).map((m) => m.id))
      const origin = t.textContent
      t.disabled = true
      t.textContent = '保存并重探…'
      if (input) input.value = ''      // 先清掉，别让明文留在 DOM 里等着被下一次重渲染带出来
      try {
        const r = await api('/api/env', { method: 'POST', body: { key, value } })
        if (Array.isArray(r.members)) state.members = r.members
        if (Array.isArray(r.roles)) state.roles = r.roles
        const nowOn = (r.members || []).filter((m) => m.available && wasOff.has(m.id))
        const stillOff = (r.members || []).filter((m) => !m.available)
        render()
        saveState()
        if (r.error) {
          // 写入成功但重探本身出错 —— 这两件事必须分开说，否则会被当成"Key 填错了"
          toast(`已写入 ${key}，但重探失败：${r.error}`, 'err')
          t.disabled = false; t.textContent = origin
        } else if (nowOn.length) {
          closeModal()
          toast(`${key} 已写入 — ${nowOn.map((m) => m.name).join('、')} 现在可用了`, 'ok')
        } else {
          // 没激活任何成员：把刷新后的实测原因**当场**摆出来，别让用户猜
          const why = stillOff.map((m) => `${m.name}：${listText(m.reason, 40)}`).join('；')
          toast(`已写入 ${key}，但没有成员因此变得可用${why ? ` —— ${why}` : ''}`, 'err')
          t.disabled = false; t.textContent = origin
          rerenderFixModal()
        }
      } catch (e) {
        toast(`写 .env 失败：${e.message}`, 'err')
        t.disabled = false; t.textContent = origin
      }
      break
    }
    case 'do-plan': await doPlan(); break
    case 'back-to-goal': openNewTaskModal(); break
    case 'replan': await doPlan(planDraft?.goal); break
    case 'plan-toggle': {
      const ta = t.closest('.plan-row')?.querySelector('.plan-prompt')
      if (ta) {
        ta.style.display = ta.style.display === 'none' ? '' : 'none'
        t.textContent = ta.style.display === 'none' ? '编辑指令' : '收起指令'
      }
      break
    }
    case 'plan-del': t.closest('.plan-row')?.remove(); break
    case 'plan-add': {
      const box = byId('planRows')
      let n = box.children.length + 1
      const taken = new Set([...box.querySelectorAll('.plan-row')].map((r) => r.dataset.sid))
      while (taken.has(`s${n}`)) n++
      const blank = {
        id: `s${n}`,
        memberId: state.members.find((m) => m.available)?.id || '',
        role: '执行者', prompt: '', title: '（手动添加）', dependsOn: [],
      }
      const div = document.createElement('div')
      div.innerHTML = planRowHtml(blank, box.children.length)
      const row = div.firstElementChild
      box.appendChild(row)
      row.querySelector('.plan-toggle')?.click()
      break
    }
    case 'confirm-task': await confirmTask(); break

    // ── 协同任务 ──
    case 'stop-task': {
      const task = activeTask()
      if (!task) break
      const pending = Object.values(task.cards).filter((c) => c.status === 'run' || c.status === 'wait').length
      if (!confirm(`停止会中断 ${pending} 个未完成的子任务。确定？`)) break
      task._ac?.abort()
      break
    }
    case 'open-report': {
      const task = activeTask()
      if (!task) break
      openModal(`
        <h3>运行轨迹报告</h3>
        <div class="sub">${esc(task.goal)}</div>
        <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11.5px;max-height:60vh;overflow:auto">${esc(task.markdown || '（本次没有拿到报告）')}</pre>
        <div class="modal-actions"><button class="btn-lg primary" data-act="close-modal">关闭</button></div>`)
      break
    }
    case 'retry-card':
    case 'swap-card':
    case 'skip-card': {
      const task = state.tasks.find((x) => x.id === t.dataset.tid) || activeTask()
      const id = t.dataset.id
      if (!task || !task.cards[id]) return toast('找不到这张卡片', 'err')
      if (task.status === 'running') return toast('这个任务还在跑，等它跑完再动单张卡片', 'err')
      if (t.dataset.act === 'swap-card') { openSwapModal(task, id); break }
      if (t.dataset.act === 'skip-card') { openSkipModal(task, id); break }
      toast(`重跑 [${id}]：已经成功的步骤不会重跑`, 'ok')
      await retryCard(task, id, 'retry')
      break
    }

    case 'swap-to': {
      const task = state.tasks.find((x) => x.id === t.dataset.tid)
      const id = t.dataset.id
      const mid = t.dataset.mid
      closeModal()
      if (!task) return toast('找不到这个任务', 'err')
      await retryCard(task, id, 'swap', mid)
      break
    }

    case 'skip-confirm': {
      const task = state.tasks.find((x) => x.id === t.dataset.tid)
      const id = t.dataset.id
      closeModal()
      if (!task) return toast('找不到这个任务', 'err')
      await retryCard(task, id, 'skip')
      break
    }

    // ── 冲突卡片 ──
    case 'conflict-mode': {
      const c = window.__conflict
      if (!c) break
      const rows = simpleDiff(c.current.text, c.mine)
      byId('conflictBody').innerHTML = rows.map((r) => {
        const color = r.type === 'del' ? 'var(--fail)' : r.type === 'add' ? 'var(--done)' : 'var(--text-faint)'
        const mark = r.type === 'del' ? '- ' : r.type === 'add' ? '+ ' : '  '
        return `<div style="color:${color}">${esc(mark + r.text)}</div>`
      }).join('')
      break
    }
    case 'conflict-take-theirs': {
      const c = window.__conflict
      if (!c) break
      state.editor = { path: c.path, original: c.current.text, mtimeMs: c.current.mtimeMs, dirty: false }
      window.__conflict = null
      closeModal()
      renderEditor()
      const v = byId('fileView')
      if (v) v.value = c.current.text
      toast('已载入磁盘上的版本', 'ok')
      break
    }
    case 'conflict-keep-mine': {
      const c = window.__conflict
      if (!c) break
      try {
        const r = await api('/api/write', { method: 'POST', body: { path: c.path, text: c.mine } })
        state.editor = { path: c.path, original: c.mine, mtimeMs: r.mtimeMs, dirty: false }
        window.__conflict = null
        closeModal()
        renderEditor()
        toast('已强制覆盖', 'ok')
      } catch (err) {
        toast(`覆盖失败：${err.message}`, 'err')
      }
      break
    }
  }
})

// 复选框 / 下拉 / 输入：只能走 change，click 委托接不住
document.addEventListener('change', async (e) => {
  const t = e.target
  // 切档位时立刻重算「这一单里哪些成员不吃这一档」—— 提示不能停留在上一个档位的结论上
  if (t.dataset?.act === 'plan-perm') {
    const el = byId('planPermCaveat')
    if (el) el.textContent = planPermCaveat(planDraft, t.value)
    return
  }
  // 换拆解者时，按钮文案和说明必须跟着换 ——「交给主脑」和「拆解」是两条完全不同的路
  if (t.dataset?.act === 'planner-sel') {
    const orch = state.orchestrator
    const isOrch = !!orch && t.value === orch.id
    const home = t.id === 'homePlannerSel'
    const btn = byId(home ? 'homePlanBtn' : 'planBtn')
    if (btn) btn.textContent = isOrch ? '交给主脑' : '拆解'
    const hint = byId(home ? 'homePlannerHint' : 'plannerHint')
    if (hint) hint.textContent = plannerHintText(t.value)
    return
  }
  // 换要填哪个变量名 —— 那句「这一个 Key 同时激活 Trae 和豆包」得跟着换，别停在上一项上
  if (t.id === 'keyVar') {
    const note = document.querySelector('[data-kf-shared]')
    if (note) note.innerHTML = keySharedNote(t.value)
    return
  }
  /*
   * 工作台上的执行参数。
   * 这两个和「执行计划确认」表里的 `#taskPerm` / `#taskPolicy` 是**同一份 state**，
   * 只是能在出手之前先定好 —— 确认表打开时读的正是这里写进去的值，不会有两套。
   */
  if (t.dataset?.act === 'wb-perm' || t.dataset?.act === 'wb-policy') {
    if (t.dataset.act === 'wb-perm') state.permission = t.value
    else state.failurePolicy = t.value
    saveState()
    return
  }
  /*
   * 计划表里换成员 / 换角色 —— 那一行的角色说明和能力匹配结论必须**当场**跟着变。
   * 不重画的话，「✓ 实测可用」会停在换人之前的那一对组合上：
   * 用户刚把一步从 Claude 换成豆包，屏幕上却说没问题，这就是界面在替错误的组合背书。
   * 只重画这一行的结论块，**不整块重渲染** —— 输入框里正在编辑的指令会被擦掉。
   */
  if (t.classList?.contains('plan-member') || t.classList?.contains('plan-role')) {
    const row = t.closest('.plan-row')
    const note = row?.querySelector('[data-role-note]')
    if (note) {
      note.innerHTML = planRoleNoteHtml(
        row.querySelector('.plan-role')?.value,
        row.querySelector('.plan-member')?.value,
      )
    }
    return
  }
  if (t.dataset?.act === 'toggle-broadcast') {
    state.broadcast[t.dataset.chat] = t.checked
    rerenderMain()
    return
  }
  if (t.dataset?.act === 'toggle-member') {
    try {
      await api('/api/members/update', { method: 'POST', body: { id: t.dataset.id, patch: { enabled: t.checked } } })
      await fetchMembers(true)
      openMembersModal()
      toast(t.checked ? `已启用 ${memberName(t.dataset.id)}` : `已禁用 ${memberName(t.dataset.id)}`, 'ok')
    } catch (err) {
      toast(`改配置失败：${err.message}`, 'err')
    }
    return
  }
  if (t.dataset?.act === 'set-perm') {
    try {
      await api('/api/members/update', { method: 'POST', body: { id: t.dataset.id, patch: { defaultPermission: t.value } } })
      const m = memberById(t.dataset.id)
      if (m) m.defaultPermission = t.value
      toast(`${memberName(t.dataset.id)} 默认档改为 ${permLabel(t.value)}`, 'ok')
    } catch (err) {
      toast(`改配置失败：${err.message}`, 'err')
    }
  }
})

document.addEventListener('input', (e) => {
  const t = e.target
  if (t.classList?.contains('ta')) {
    state.drafts[`${t.dataset.cid}:${t.dataset.mid}`] = t.value
    // 自动增高
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 180) + 'px'
    // 只更新发送按钮可用性，不整块重渲染 —— 重渲染会打断输入
    const btn = t.parentElement?.querySelector('.send-btn')
    if (btn) btn.disabled = !t.value.trim() || !!state.chats.find((c) => c.id === t.dataset.cid)?.busy?.[t.dataset.mid]
    return
  }
  if (t.id === 'fileView' && state.editor) {
    if (!state.editor.dirty) {
      state.editor.dirty = true
      byId('unsavedDot').hidden = false
    }
  }
})

// 快捷键
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); return }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    if (state.editorOpen && state.editor?.dirty) { e.preventDefault(); saveEditorFile() }
    return
  }
  /*
   * 发送：**回车直接发**，Shift+回车换行；Ctrl/Cmd+回车照旧也发（老习惯不用改）。
   *
   * 原来这里只认 Ctrl+回车，而**界面上没有任何一个地方写过这件事** ——
   * 用户按回车没反应，只会得出"这个软件发不出消息"的结论（2026-10-02 实测反馈）。
   * 一个必须靠猜才能发现的快捷键，等于没有这个快捷键。
   *
   * ⚠️ 必须让开输入法：打中文时，回车是"选定候选词"，不是"发送"。
   * 合成期间浏览器会把 isComposing 置真（有的输入法只给 keyCode 229），
   * 两个信号都要认 —— 否则打中文每选一次词，就会把半句话发出去。
   */
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    const ta = document.activeElement
    if (!ta?.classList?.contains('ta')) return
    if (e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSend(ta.dataset.cid, ta.dataset.mid)
    return
  }
  // 首页用 ← / → 在「单独 / 协同」之间切页签。
  // 两道闸，少了哪道都会误伤：
  //  1. 只在首页（active 是空白页）且**没有弹窗**时 —— 弹窗里按方向键是人家弹窗的事；
  //  2. 焦点不能在输入区（输入框 / 下拉 / 文本域 / 可编辑元素）——
  //     在目标输入框里按 ← 是想移动光标，不是要换页。
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (state.active.type !== 'blank') return
    if (byId('modalRoot')?.classList.contains('open')) return
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
    const next = e.key === 'ArrowLeft' ? 'solo' : 'coop'
    if (state.homeTab !== next) { state.homeTab = next; render(); saveState() }
  }
})

// ══════════════════════════════════════════ 顶栏交互

byId('permBtn').addEventListener('click', () => {
  const i = PERMS.findIndex((p) => p.id === state.permission)
  state.permission = PERMS[(i + 1) % PERMS.length].id
  renderTopbar()
  rerenderMain()
  saveState()
  toast(`权限档：${permLabel(state.permission)} —— ${permHint(state.permission)}`)
})

byId('editorToggle').addEventListener('click', () => {
  state.editorOpen = !state.editorOpen
  renderTopbar()
  renderEditor()
  if (state.editorOpen) loadTree(state.treeDir)
  saveState()
})

byId('closeEditor').addEventListener('click', () => {
  state.editorOpen = false
  renderTopbar()
  renderEditor()
  saveState()
})

byId('membersBtn').addEventListener('click', openMembersModal)

byId('projectBtn').addEventListener('click', async () => {
  const next = prompt('切换工作目录（绝对路径）', state.workdir)
  if (!next || next === state.workdir) return
  try {
    const r = await api('/api/workdir', { method: 'POST', body: { workdir: next } })
    state.workdir = r.workdir
    state.projectName = r.workdir.split(/[\\/]/).filter(Boolean).pop() || r.workdir
    state.treeDir = '.'
    state.editor = null
    byId('fileTree').dataset.loaded = ''
    render()
    saveState()
    toast(`工作目录：${r.workdir}`, 'ok')
  } catch (e) {
    toast(`切换失败：${e.message}`, 'err')
  }
})

byId('newChatBtn').addEventListener('click', openNewChatModal)
byId('newTaskBtn').addEventListener('click', openNewTaskModal)
byId('miniNewChat').addEventListener('click', openNewChatModal)
byId('miniNewTask').addEventListener('click', openNewTaskModal)
/*
 * 回选择页。没有它，从首页点进会话之后就被"锁"在会话里了 ——
 * 想换一个成员只能另开新会话弹窗，回不到那张选择页。
 */
const goHome = () => {
  state.active = { type: 'blank', id: null }
  render()
  saveState()
}
byId('homeBtn').addEventListener('click', goHome)
byId('miniHome').addEventListener('click', goHome)
byId('expandSidebar').addEventListener('click', () => {
  state.sidebarMini = false
  renderTopbar()
  saveState()
})

// 编辑器区宽度拖拽
;(function initResizer() {
  const rz = byId('resizer')
  let dragging = false
  rz.addEventListener('mousedown', (e) => {
    dragging = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const w = Math.min(520, Math.max(160, window.innerWidth - e.clientX))
    document.documentElement.style.setProperty('--editor-w', w + 'px')
    byId('editorPane').style.width = w + 'px'
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })
})()

// 点击空白处关弹窗（点内容区不关）
byId('modalRoot').addEventListener('click', (e) => {
  if (e.target === byId('modalRoot')) closeModal()
})

// ══════════════════════════════════════════ 启动

async function fetchMembers(force = false) {
  state.probing = true
  if (!state.chats.length && state.active.type === 'blank') renderMain()
  try {
    const r = await api(`/api/members${force ? '?force=1' : ''}`)
    state.members = r.members
    // 目录跟着成员一起刷新：服务端是唯一真相源，前端只做展示
    if (Array.isArray(r.roles)) state.roles = r.roles
    if (Array.isArray(r.envKeys)) state.envKeys = r.envKeys
    state.workdir = r.workdir
    state.projectName = r.projectName
    state.configPath = r.configPath
    state.orchestrator = r.orchestrator
  } catch (e) {
    toast(`读成员列表失败：${e.message}`, 'err')
  } finally {
    state.probing = false
    state.probed = true
    render()
    saveState()
  }
}

;(async function boot() {
  loadState()
  render()
  await fetchMembers(false)
})()

// 暴露给控制台调试 / 冒烟脚本用。
// runTask 也放出来是有意的：测试要跑的必须是**界面自己那条通道**，
// 而不是另写一份 fetch —— 否则测的是测试脚本，不是界面。
window.AgentHub = {
  state, render, rerenderMain, api, memberName, runTask, onTaskEvent, loadTree, openFileInEditor,
  // 交互入口也暴露出来：界面冒烟测试要能直接驱动"重试 / 换人 / 跳过"这几条路，
  // 而它们都得先在弹窗里做选择 —— 靠模拟点击一路摸 DOM 太脆。
  retryCard, openSwapModal, openSkipModal, closeModal,
  // 计划弹窗的渲染入口同理：要断言"档位在这一单里生不生效"，得先造出一份计划。
  // 靠点击「拆解」去造会真的调一次规划者 —— 验证一句提示不值得花那个钱。
  renderPlanTable,
  // 计划的当前草稿与最近一次拆解诊断 —— 实跑脚本（tests/real-run.mjs）要读，
  // 否则"这次是硬解析出来的还是抢救出来的"只能靠猜。
  // setter 是给测试注入草稿用的（渲染入口只从这份草稿取数）。
  get planDraft() { return planDraft },
  set planDraft(v) { planDraft = v },
  get planDiag() { return state._lastPlanDiag },
}
