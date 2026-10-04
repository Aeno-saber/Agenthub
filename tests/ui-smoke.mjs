#!/usr/bin/env node
/**
 * 界面冒烟 —— 在真浏览器里把 AgentHub 界面跑一遍
 *
 * ## 为什么不用 Playwright / Puppeteer
 *
 * 本机装了火绒实时防护，装那种带浏览器下载的依赖又慢又容易被拦（见 README 的环境说明）。
 * 而验证"界面能不能用"这件事，其实只需要三样东西，Node 22 全都自带了：
 *   · 一个 Chromium —— 系统里有 Edge
 *   · CDP 协议 —— 就是 WebSocket 上的 JSON-RPC
 *   · WebSocket 客户端 —— Node 22 内置了全局 WebSocket
 * 所以这里是零依赖的：起了 Edge 的 headless，直连 CDP，跑断言，收工。
 * 别为了验证一个零依赖项目，先往项目里塞 200MB 的浏览器二进制。
 *
 * ## 它验什么
 *
 * 不验"长得好看"，验**会不会一打开就是空白页**——前端 JS 一个笔误就够让整页白掉，
 * 而 HTTP 层怎么看都是 200。所以核心是两件事：
 *   1. 控制台里有没有未捕获异常 / error 级日志（白页的根因都在这儿）
 *   2. DOM 里该出现的元素在不在，以及**点得动**（新建会话、新建协同、编辑器）
 *
 * 用法：
 *   node ui/server.js &            # 先起界面服务
 *   node tests/ui-smoke.mjs        # 再跑这个
 *
 * 可选环境变量：UI_URL（默认 http://127.0.0.1:8787）、EDGE_PATH、CDP_PORT（一般别设，见 lib/browser.mjs）
 */
import process from 'node:process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { launchBrowser, closeBrowser, newPage, sleep } from './lib/browser.mjs'

/*
 * 成员总数**从配置里读**，不写死。
 *
 * 原先这个文件里有 7 处硬编码的 6（可用数、顶栏计数、HUD、成员管理行数…）。
 * 2026-10-02 加 Codex 成员时它们的代价露出来了：加一个成员要改 7 个数字，
 * 而"顺手把断言改成能过"正是假绿的温床 —— 漏掉一处，断言就再也盯不住东西了。
 */
const TOTAL_MEMBERS = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config', 'members.json')
    return JSON.parse(readFileSync(p, 'utf8')).members.length
  }
  catch { return 0 }
})()

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:8787'
// 0 = 让浏览器自己挑端口。固定端口踩过坑：上一轮跑崩残留的浏览器还占着它，
// 于是这一轮静默连到旧实例上（带着旧 localStorage），首页整个不渲染 —— 假红。
const CDP_PORT = Number(process.env.CDP_PORT || 0)
/** 设了这个目录就把界面截图存进去（顺带把界面给你看一眼，不用自己开浏览器） */
const SHOT_DIR = process.env.SHOT_DIR || ''

// ── 断言 ──
const results = []
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`)
}
const warnings = []

// ── 浏览器会话（CDP 底座在 tests/lib/browser.mjs）──
let page = null

/** 存一张界面截图。没人盯着屏幕时，它是唯一能看出"界面到底长什么样"的手段。 */
const shot = (name) => (SHOT_DIR && page ? page.shot(SHOT_DIR, name) : Promise.resolve())

/**
 * 等所有列都不忙（等真实对话跑完）。
 * 先等它"忙起来"再等它"闲下来" —— 点击到 fetch 真正发出之间有几十毫秒空隙，
 * 直接查 busy 会立刻拿到 false，然后你就对着一个空面板截图。
 */
async function waitIdle(tries = 400) {
  const busyOf = () => page.eval(`
    const c = window.AgentHub.state.chats[0]
    return !c || c.memberIds.some(id => c.busy?.[id])
  `).catch(() => false)

  for (let i = 0; i < 25; i++) {
    if (await busyOf()) break
    await sleep(200)
  }
  for (let i = 0; i < tries; i++) {
    if (!(await busyOf())) return true
    await sleep(500)
  }
  console.log('  （等待超时：还有列在跑）')
  return false
}

// ── 主流程 ──
let browser = null

async function main() {
  // 界面服务必须先活着，否则后面全是误导性的失败
  try {
    const r = await fetch(UI_URL)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`界面服务没起来（${UI_URL}）：${e.message}`)
    console.error('先跑：node ui/server.js --workdir D:/app/AgentHub')
    process.exit(2)
  }

  browser = await launchBrowser({ port: CDP_PORT })
  page = await newPage(browser.port, UI_URL)
  const cdp = page.cdp
  const consoleErrors = page.errors
  const pageErrors = page.exceptions

  console.log('\n── 1. 页面骨架 ──')
  check('顶栏存在', await cdp.eval(`return !!document.querySelector('.topbar')`))
  check('左栏存在', await cdp.eval(`return !!document.querySelector('#sidebar')`))
  check('主区存在', await cdp.eval(`return !!document.querySelector('#main')`))
  check('编辑器区存在', await cdp.eval(`return !!document.querySelector('#editorPane')`))
  check('前端脚本已挂载', await cdp.eval(`return typeof window.AgentHub === 'object'`))

  console.log('\n── 2. 成员探活（等后端把 6 个成员探完）──')
  let probed = false
  for (let i = 0; i < 160; i++) {
    probed = await cdp.eval(`return (window.AgentHub?.state?.members?.length || 0) > 0`).catch(() => false)
    if (probed) break
    await sleep(250)
  }
  check('成员列表已载入', probed)
  const members = await cdp.eval(`return window.AgentHub.state.members.map(m => ({id:m.id, ok:!!m.available, why:(m.reason||'').slice(0,60), hasPermSupport: !!m.permissionSupport, writeCapable: m.writeCapable}))`)
  check(`成员数 = 配置里的 ${TOTAL_MEMBERS} 个`, members.length === TOTAL_MEMBERS, `实际 ${members.length}`)
  /*
   * ★ 「我连着的这个服务，跑的是仓库里这份代码吗？」
   *
   * 这条是踩出来的：2026-09-29 审计权限档位时改了 `/api/members`，
   * 而 8787 上还跑着**几小时前起的旧服务** —— 新加的两条界面断言因此报空值。
   * 排查花掉的几分钟全在"怀疑自己的断言写错了"，而真相是测试压根没测到新代码。
   *
   * 这类假红比假绿还费时间：假绿至少不会误导你改错地方。
   * 所以这里用一个**只可能由新代码满足**的字段做哨兵 —— 旧服务不可能返回它。
   */
  const staleService = members.filter((m) => !m.hasPermSupport).map((m) => m.id)
  check(
    '★★ 连着的服务是当前代码（每个成员都得带 permissionSupport）',
    staleService.length === 0,
    staleService.length
      ? `${staleService.join('、')} 没有该字段 —— 8787 上跑的多半是改动前起的旧服务，请重启（测试测的不是当前代码）`
      : ''
  )
  const okCount = members.filter((m) => m.ok).length
  /*
   * 这条断言原先是「至少 4 个实测可用」，2026-09-29 真跑之后改掉了。
   *
   * 失败过一次：trae 从 ✅ 变成 ❌，可用数 4 → 3。但那**不是退化，是修复** ——
   * trae 的探活原本走 `--version`，根本不碰 API Key，所以永远报绿（假绿），
   * 直到执行阶段才炸出 openai.OpenAIError: Missing credentials。
   * 加了 requiredEnv 前置检查后它如实显示"缺少 DOUBAO_API_KEY"。
   *
   * 教训：**"几个成员可用"是环境事实，不是代码性质** —— 写死阈值会让断言随
   * 密钥配置漂移，而且它红的时候恰恰可能是修好的时候。
   * 所以这里只保证三个纯 CLI 成员（不依赖任何 API Key）在线，
   * 真正的正确性交给下面那两条：不可用必须给原因、计数必须自洽。
   */
  check(
    '至少 3 个纯 CLI 成员可用（claude/codex/cursor/qoder 不需要 API Key）',
    okCount >= 3,
    `实测可用 ${okCount}/${TOTAL_MEMBERS}：` + members.map((m) => `${m.id}${m.ok ? '✅' : '❌'}`).join(' ')
  )
  check(
    '不可用成员必须给出原因（不能只丢个灰点）',
    members.filter((m) => !m.ok).every((m) => m.why && m.why.length > 0),
    members.filter((m) => !m.ok).map((m) => `${m.id}: ${m.why}`).join(' | ')
  )
  const countText = await cdp.eval(`return document.getElementById('memberCount').textContent`)
  check('顶栏成员计数与实测一致', countText === `${okCount}/${TOTAL_MEMBERS}`, `顶栏显示 ${countText}`)

  console.log('\n── 3. 首页 = 选择页（单独 / 协同 两页签）──')
  /*
   * 2026-09-29 第十轮：首页不再是"一句标语 + 两个按钮"的广告牌，
   * 而是把「选择 agent」直接铺上来，用页签分开，**默认「单独工作」**。
   * 钉的点：默认页签、卡片数 = 可用成员数、点卡片直接开聊（不再弹窗）、
   * 协同页签与弹窗同一份逻辑但 id 是两套、方向键可切换。
   */
  check('首页有两个页签', await cdp.eval(`return document.querySelectorAll('.home-tab').length === 2`))
  check('★★ 默认选中的是「单独工作」（首页不是广告牌，上来就能点）', await cdp.eval(`
    const tabs = [...document.querySelectorAll('.home-tab')];
    return tabs[0]?.classList.contains('on') && tabs[0].textContent.trim() === '单独工作'
  `))
  const cardCount = await cdp.eval(`return document.querySelectorAll('.member-card').length`)
  // 卡片 = 主脑 1 张 + 实测可用的 + **不可用的虚线卡**。
  // 不可用的也占一张卡是有意的（见下一节的「不占卡片位，但也不消失」）：
  // 「装了但没配好」和「根本没这个成员」是两件事，前者只差一步，藏起来用户就永远不知道该去配。
  // 所以这个数必须把不可用的算进去 —— 只算可用数的话，一有成员掉线这条就假红。
  const unavailCount = members.filter((m) => !m.ok).length
  check('★ 单独页签的卡片数 = 主脑 + 可用数 + 不可用虚线卡数',
    cardCount === okCount + 1 + unavailCount,
    `卡片 ${cardCount} 张（主脑 1 + 可用 ${okCount} + 不可用 ${unavailCount}）`)
  check('★★ 单独页签第一张卡是 WorkBuddy 主脑卡（点它不开聊天，走「交给主脑」）', await cdp.eval(`
    const first = document.querySelector('.member-card');
    return first?.classList.contains('orch-card') && first.textContent.includes('WorkBuddy')
      && first.textContent.includes('主脑') && first.dataset.act === 'orch-handoff'
  `))
  check('★ HUD 状态行在线（科幻元素不许只是装饰：NODES 数必须是真的）', await cdp.eval(`
    const hud = document.querySelector('.home-hud');
    return !!hud && hud.textContent.includes('ONLINE') && hud.textContent.includes('${okCount}/${TOTAL_MEMBERS} NODES')
  `))
  check('★★ 卡片徽标用的是真实应用图标（不只字母），且各自有底色', await cdp.eval(`
    const badges = [...document.querySelectorAll('.member-card:not(.orch-card) .mc-badge')];
    const imgs = badges.map(b => b.querySelector('img.mc-img'));
    // 没加载失败的（加载中 complete=false 也算；失败的特征是 complete=true 且 naturalWidth=0）
    const ok = imgs.filter((i) => i && (i.complete === false || i.naturalWidth > 0));
    const colors = new Set(badges.map(b => getComputedStyle(b).backgroundColor));
    return badges.length >= 4 && ok.length >= 4 && colors.size >= 3
  `))
  check('不可用成员一行带过、附原因（不占卡片位，但也不消失）', await cdp.eval(`
    const el = document.querySelector('.home-unavail');
    return !el || (el.textContent.includes('暂不可用') && el.textContent.length > 10)
  `))
  check('★ 点成员卡片 → 直接创建单聊（中间没有弹窗）', await cdp.eval(`
    document.querySelector('.member-card:not(.orch-card)').click();
    return new Promise((r) => setTimeout(() => {
      const c = window.AgentHub.state.chats[0];
      r(!!c && c.memberIds.length === 1 && !document.getElementById('modalRoot').classList.contains('open')
        && !!document.querySelector('.chat-single'))
    }, 300))
  `))
  check('★★ 主脑卡点开的是「交给主脑」弹窗，不是聊天（引擎调不动主脑，不许装作能聊）', await cdp.eval(`
    document.getElementById('homeBtn').click();
    return new Promise((r) => setTimeout(() => {
      document.querySelector('.orch-card').click();
      setTimeout(() => {
        const goal = document.getElementById('handoffGoal');
        const modal = document.getElementById('modalRoot');
        r(!!goal && modal.classList.contains('open') && !document.querySelector('.chat-single'))
      }, 200)
    }, 200))
  `))
  await cdp.eval(`document.querySelector('[data-act="close-modal"]')?.click(); return 1`)
  await sleep(120)
  check('★★ 回了首页才能换人：homeBtn 一按回到选择页（这是"换另一个"的通路）', await cdp.eval(`
    const btn = document.getElementById('homeBtn');
    return !!btn && !!document.querySelector('.home')
  `))
  // 清理刚才创建的会话，别影响后面章节的计数（4/5 节走弹窗再建一个）
  await cdp.eval(`
    const A = window.AgentHub;
    A.state.chats = []; A.state.active = { type: 'blank', id: null };
    A.render(); return 1
  `)
  await sleep(150)

  console.log('\n── 3b. 首页协同页签：与弹窗同一份逻辑，id 是两套 ──')
  await cdp.eval(`document.querySelectorAll('.home-tab')[1].click(); return 1`)
  await sleep(150)
  const coopHome = await cdp.eval(`return JSON.stringify({
    goalBox: !!document.getElementById('homeGoalBox'),
    sel: document.getElementById('homePlannerSel')?.value || '',
    btn: document.getElementById('homePlanBtn')?.textContent.trim() || '',
    hint: (document.getElementById('homePlannerHint')?.textContent || '').slice(0, 30),
    // 弹窗那套 id 此刻**不许**出现在 DOM 里（id 撞了就是静默错对象）
    modalIdsLeaked: !!document.getElementById('goalBox') || !!document.getElementById('plannerSel'),
    orchId: window.AgentHub.state.orchestrator?.id || '',
    avail: window.AgentHub.state.members.filter((m) => m.available).map((m) => m.id),
  })`)
  const ch = JSON.parse(coopHome)
  check('★ 协同页签有目标输入框 + 谁来拆解 + 按钮', ch.goalBox && !!ch.sel && !!ch.btn, coopHome)
  check('★★ 协同页签默认选中「本软件内可用的成员」、按钮是「拆解」（默认不落到主脑上 —— 主脑没有 CLI，选它就得切软件）',
    ch.sel !== '' && ch.sel !== ch.orchId && ch.avail.includes(ch.sel) && ch.btn === '拆解', coopHome)
  check('★★ 弹窗那套 id 没有泄漏进首页（id 撞了就会静默错对象）', !ch.modalIdsLeaked, coopHome)
  check('★ 首页换拆解者 → 按钮文案跟着换（home 版的 planner-sel 处理）', await cdp.eval(`
    const sel = document.getElementById('homePlannerSel');
    sel.value = 'claude'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('homePlanBtn').textContent.trim() === '拆解'
  `))
  // 切回默认页签，顺手验证点按切换，再用方向键验证键盘切换
  await cdp.eval(`document.querySelectorAll('.home-tab')[0].click(); return 1`)
  await sleep(120)
  check('点页签能切回「单独」', await cdp.eval(`return document.querySelectorAll('.home-tab')[0].classList.contains('on')`))
  check('★ → 方向键切到「协同」，且输入框里有焦点时按方向键不会误切', await cdp.eval(`
    document.activeElement?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const toCoop = document.querySelectorAll('.home-tab')[1].classList.contains('on');
    // 焦点在目标输入框里时按 ←：是想移动光标，不是要换页 —— 不许切
    const box = document.getElementById('homeGoalBox');
    box.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const stayedInCoop = document.querySelectorAll('.home-tab')[1].classList.contains('on');
    // ⚠️ 顺序：必须先 blur 再 dispatch —— 上一轮这里先 dispatch 后 blur，
    // 焦点还在输入框里，事件被闸正确挡下，断言自己把自己测红了。
    box.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const backAfterBlur = document.querySelectorAll('.home-tab')[0].classList.contains('on');
    return toCoop && stayedInCoop && backAfterBlur
  `))
  await cdp.eval(`window.AgentHub.state.homeTab = 'solo'; window.AgentHub.render(); return 1`)

  // ════════════════════════════════════════════════════════════════════════
  // 3c. 协同工作台 —— 「协同任务单独开一个页面，左侧选主脑、分工再详细点」
  //
  // 用户的原话是两句：协同要**单独一个页面**，左栏选主脑和分工，而且**分工要再详细点**。
  // 所以这一节盯的不是"有没有这些控件"，而是三件更容易做假的事：
  //   ① 左栏真的是决策区、右栏真的是结果区（并排两栏，不是把控件堆成一列）；
  //   ② 分工选项**就是角色目录本身**，每条都带职责/能力要求 —— 不是几个光秃秃的标签；
  //   ③ 勾选真的会改变右栏（预览卡当场出现/消失，且带交付物与"谁能干"）。
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 3c. 协同工作台：左边定分工，右边看结果 ──')
  await cdp.eval(`document.querySelectorAll('.home-tab')[1].click(); return 1`)
  await sleep(200)

  const wbLayout = await cdp.eval(`
    const wb = document.querySelector('.wb')
    const rail = document.querySelector('.wb-rail')
    const main = document.querySelector('.wb-main')
    if (!wb || !rail || !main) return null
    const r = rail.getBoundingClientRect()
    const m = main.getBoundingClientRect()
    return JSON.stringify({
      railW: Math.round(r.width),
      mainW: Math.round(m.width),
      // 并排 = 左栏的右边缘不越过右栏的左边缘，且右栏确实更宽
      sideBySide: r.right <= m.left + 1 && m.width > r.width,
      railLeft: r.left < m.left,
    })
  `)
  const wbl = JSON.parse(wbLayout || 'null')
  check('★★ 协同页签是一整页工作台（左栏决策 + 右栏结果并排）', !!wbl && wbl.sideBySide && wbl.railLeft,
    wbLayout || '没找到 .wb / .wb-rail / .wb-main')

  const railSecs = await cdp.eval(`
    return JSON.stringify({
      titles: [...document.querySelectorAll('.wb-rail .wb-sec-title')].map((e) => e.textContent.trim()),
      idx: [...document.querySelectorAll('.wb-rail .wb-idx')].map((e) => e.textContent.trim()),
    })
  `)
  const rs = JSON.parse(railSecs)
  check('★ 左栏四块决策齐了：谁来拆解 / 分工 / 成员池 / 执行参数',
    rs.titles.join(',') === '谁来拆解,分工,成员池,执行参数', railSecs)
  check('★ 四块带 01–04 的序号（一眼看出这是"按顺序想清楚"的四步）',
    rs.idx.join(',') === '01,02,03,04', railSecs)

  /*
   * 分工选项必须是**目录本身**。
   * 这条防的是最省事的假实现：左栏摆几个写死的中文标签（"写代码""做评审"），
   * 看着像分工，实际上和引擎里那份角色目录毫无关系 —— 勾了也不会进提示词。
   */
  const picks = await cdp.eval(`
    const all = [...document.querySelectorAll('.role-pick')]
    const first = all[0]
    return JSON.stringify({
      n: all.length,
      catalog: (window.AgentHub.state.roles || []).length,
      labels: all.map((p) => p.querySelector('.rp-name')?.textContent.trim() || ''),
      catalogLabels: (window.AgentHub.state.roles || []).map((r) => r.label),
      // 每一条都得写清"这件事做什么""要什么能力"，否则"分工再详细点"就是空话
      thin: all.filter((p) => (p.querySelector('.rp-duty')?.textContent || '').length < 6
        || (p.querySelector('.rp-need')?.textContent || '').length < 2).length,
      firstDuty: first?.querySelector('.rp-duty')?.textContent.trim() || '',
      firstNeed: first?.querySelector('.rp-need')?.textContent.trim() || '',
      isButton: all.every((p) => p.dataset.act === 'wb-role' && p.dataset.role),
    })
  `)
  const pk = JSON.parse(picks)
  check('★★ 分工选项就是角色目录本身（不是几个写死的标签）',
    pk.n === pk.catalog && pk.n >= 8 && pk.labels.join(',') === pk.catalogLabels.join(','), picks)
  check('★ 每个分工都写着职责与能力要求（这就是"再详细点"的落点）',
    pk.thin === 0, `过短的有 ${pk.thin} 条；第一条：${pk.firstDuty} / ${pk.firstNeed}`)
  check('每个分工都是可点的按钮且带着自己的角色名（不是纯装饰）', pk.isButton, picks)

  const beforePick = await cdp.eval(`
    return JSON.stringify({
      picked: (window.AgentHub.state._roles || []).length,
      cards: document.querySelectorAll('.role-card').length,
      empty: !!document.querySelector('.wb-main .wb-empty'),
    })
  `)
  const bp = JSON.parse(beforePick)
  check('★ 默认一个分工都不勾，右栏说的是"不勾就由规划者自己挑"（不是留一片空白）',
    bp.picked === 0 && bp.cards === 0 && bp.empty, beforePick)

  /*
   * 勾选 → 右栏当场出现预览卡。
   * 注意：这里**同时**验证了"分工预览"存在，且卡片上写的是**职责 + 交付物 + 谁能干**三样。
   * 交付物是关键 —— 只写"负责测试"的话，规划者会拆出"写点测试"这种验收不了的活。
   */
  await cdp.eval(`
    const byRole = (label) => [...document.querySelectorAll('.role-pick')].find((p) => p.dataset.role === label)
    byRole('文档书写').click()
    byRole('代码主笔').click()
    return 1
  `)
  await sleep(180)
  const afterPick = await cdp.eval(`
    const cards = [...document.querySelectorAll('.role-card')]
    return JSON.stringify({
      roles: (window.AgentHub.state._roles || []),
      on: [...document.querySelectorAll('.role-pick.on')].map((p) => p.dataset.role),
      pressed: [...document.querySelectorAll('.role-pick.on')].every((p) => p.getAttribute('aria-pressed') === 'true'),
      cards: cards.map((c) => ({
        name: c.querySelector('.rc-name')?.textContent.trim() || '',
        keys: [...c.querySelectorAll('.rc-k')].map((k) => k.textContent.trim()),
        fit: c.querySelector('.rc-fit')?.textContent.trim() || '',
        fitCls: c.querySelector('.rc-fit')?.className || '',
      })),
      count: document.querySelector('.wb-rail .wb-count')?.textContent.trim() || '',
      // 右栏不许再挂着"还没选分工"那句
      emptyGone: !document.querySelector('.wb-main .wb-empty'),
    })
  `)
  const ap = JSON.parse(afterPick)
  check('★★ 点一个分工 = 右栏当场出现一张预览卡（勾选真的改变了结果区）',
    ap.cards.length === 2 && ap.count === '已选 2', afterPick)
  /*
   * ★★ 顺序归一。
   * 上面是**先点文档书写、后点代码主笔**，而卡片顺序必须是**目录顺序**（代码主笔在前）。
   * 不归一的话，"已选"这个列表的顺序会随点击顺序乱跳 —— 同一套勾选，两个人看到两种顺序，
   * 而且发给引擎的那个数组也跟着乱（提示词里的【指定分工】会跟着乱）。
   */
  check('★★ 勾选顺序按目录归一（后点的不一定排后面）',
    ap.roles.join(',') === '代码主笔,文档书写', `实际 ${JSON.stringify(ap.roles)}`)
  check('★ 勾上的按钮有 .on 与 aria-pressed=true（状态不只在内存里，也在 DOM 上）',
    ap.on.length === 2 && ap.pressed, afterPick)
  check('★★ 每张预览卡都写着职责 + 交付物（只写"负责测试"是没法验收的）',
    ap.cards.every((c) => c.keys.join(',') === '职责,交付物') && ap.cards.every((c) => c.keys.length === 2),
    JSON.stringify(ap.cards.map((c) => c.keys)))
  check('★★ 预览卡还给出"谁能干"的实测结论（规划者提示词里那两条约束，第一次显示给用户）',
    ap.cards.every((c) => /实测可用|没有实测可用/.test(c.fit)),
    JSON.stringify(ap.cards.map((c) => c.fit)))
  /*
   * 交叉核对：卡片上那句"实测可用：X、Y"必须是**真的** ——
   * 拿成员的能力标签重算一遍，和界面显示的比。界面上写着一句没人验证过的"可用"，
   * 就等于把用户往"勾了也跑不通"的坑里推。
   */
  const fitTruth = await cdp.eval(`
    const A = window.AgentHub
    const avail = A.state.members.filter((m) => m.available)
    const out = {}
    for (const c of document.querySelectorAll('.role-card')) {
      const label = c.querySelector('.rc-name').textContent.trim()
      const info = (A.state.roles || []).find((r) => r.label === label)
      const real = avail.filter((m) => (info.needs || []).every((n) => (m.capabilities || []).includes(n))
        && (!info.write || m.writeCapable !== false)).map((m) => m.name)
      out[label] = { shown: c.querySelector('.rc-fit').textContent, real }
    }
    return JSON.stringify(out)
  `)
  const ft = JSON.parse(fitTruth)
  const fitOk = Object.entries(ft).every(([label, v]) => v.real.every((n) => v.shown.includes(n)) && (v.real.length > 0) === !/没有实测可用/.test(v.shown))
  check('★★ 卡片上"谁来干"是照能力标签真算出来的（不是一句没人核对过的"可用"）', fitOk, fitTruth)

  /*
   * ⚠️ 一次点一个，**每次都重新查一遍**。
   * 第一次写成 `[...querySelectorAll('.role-pick.on')].forEach(p => p.click())` ——
   * 点第一下就触发整块重渲染，数组里第二个节点已经是**游离**的，
   * 它上面的 click 不会冒泡到 document 上那个代理监听，于是只取消掉一个，
   * 断言报"没能全取消"。这种失败长得像功能坏了，其实是断言在操作一堆死节点。
   */
  await cdp.eval(`document.querySelector('.role-pick.on').click(); return 1`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.role-pick.on').click(); return 1`)
  await sleep(150)
  check('★ 再点一次能取消（勾选是可逆的，不会勾上就摘不掉）', await cdp.eval(`
    return (window.AgentHub.state._roles || []).length === 0
      && document.querySelectorAll('.role-card').length === 0
      && !!document.querySelector('.wb-main .wb-empty')
  `))

  // ── 成员池 + 填 Key 入口 ──
  const pool = await cdp.eval(`
    const chips = [...document.querySelectorAll('.pool-chip')]
    const off = [...document.querySelectorAll('.pool-chip.off')]
    return JSON.stringify({
      total: chips.length,
      members: window.AgentHub.state.members.length,
      on: chips.length - off.length,
      avail: window.AgentHub.state.members.filter((m) => m.available).length,
      offActs: off.map((c) => ({ id: c.dataset.id, act: c.dataset.act, text: c.textContent.trim() })),
      offNotButtons: off.filter((c) => c.tagName !== 'BUTTON').length,
    })
  `)
  const po = JSON.parse(pool)
  check('★ 成员池把不可用的成员也摆出来（"装了但没配好"和"根本没这个成员"是两件事）',
    po.total === po.members && po.on === po.avail, pool)
  check('★★ 不可用的成员在池子里就是"点这里补 Key"的按钮（不让用户自己去找 .env）',
    po.offNotButtons === 0 && po.offActs.length > 0 && po.offActs.every((o) => o.act === 'member-fix' && /补 Key/.test(o.text)),
    pool)

  await cdp.eval(`document.querySelector('.pool-chip.off').click(); return 1`)
  await sleep(220)
  const kf = await cdp.eval(`
    const form = document.querySelector('.key-form')
    const input = document.getElementById('keyInput')
    const sel = document.getElementById('keyVar')
    return JSON.stringify({
      hasForm: !!form,
      hasGoalBoxBehind: !!document.getElementById('homeGoalBox'),
      type: input ? input.type : '',
      placeholder: input ? input.placeholder : '',
      vars: sel ? [...sel.options].map((o) => o.value) : [],
      allowed: window.AgentHub.state.envKeys || [],
      btn: form ? (form.querySelector('[data-act="save-key"]')?.textContent.trim() || '') : '',
      shared: (form?.querySelector('[data-kf-shared]')?.textContent || '').trim(),
      /*
       * "值只去不返"：表单里不许回显任何**已保存的值**。
       * ⚠️ 判据必须是"输入控件里有没有内容"，不是"innerHTML 里有没有 ark/key 这些字样" ——
       * 变量名本身就长着 ARK_API_KEY 这副样子，拿字符串匹配去找，只会把白名单选项当成泄密。
       */
      echoes: [...(form ? form.querySelectorAll('input, textarea') : [])]
        .some((i) => String(i.value || '').length > 0 || i.hasAttribute('value')),
      noteTellsWhere: /127\\.0\\.0\\.1/.test(form ? form.textContent : '') && /\\.env/.test(form ? form.textContent : ''),
    })
  `)
  const k = JSON.parse(kf)
  check('★★ 点不可用成员 → 当场弹出填 Key 的表单（不用离开这一页去找 .env）',
    k.hasForm && !!k.hasGoalBoxBehind, kf)
  check('★★ Key 输入框是密码框（填的是密钥，不该被别人从屏幕上读走）',
    k.type === 'password' && k.placeholder.length > 0, kf)
  check('★★ 变量名只能从服务端白名单里选（填个别的名字进去会被拒，所以干脆不给填）',
    k.vars.length > 0 && k.vars.join(',') === k.allowed.join(','), `表单 ${k.vars.join(',')} / 白名单 ${k.allowed.join(',')}`)
  check('★ 表单说清了"服务只监听 127.0.0.1、Key 只落本地 .env"（写明文密钥这件事要讲在前面）',
    k.noteTellsWhere, kf)
  check('★★ 表单里没有任何一处回显已保存的 Key（值只去不返，不是没做完）', !k.echoes, kf)
  check('★ 有「保存并重探」按钮 —— 保存后必须真跑一次探活，而不是写进文件就算成功',
    k.btn === '保存并重探' && k.btn.length > 0, kf)

  /*
   * Trae 与豆包共用 `DOUBAO_API_KEY` 这件事必须在界面上说出来。
   * 不说的话，用户补完豆包发现 Trae 也亮了只会觉得莫名其妙，甚至去找一个不存在的"Trae 的 Key"。
   */
  const sharedVar = await cdp.eval(`
    const sel = document.getElementById('keyVar')
    const noteOf = () => (document.querySelector('[data-kf-shared]')?.textContent || '').trim()
    const pick = (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); return noteOf() }
    const doubao = pick('DOUBAO_API_KEY')
    const other = pick('CURSOR_API_KEY')
    return JSON.stringify({ doubao, other })
  `)
  const sv = JSON.parse(sharedVar)
  check('★★ 选 DOUBAO_API_KEY 时明说"这一个 Key 同时激活 Trae 和豆包"',
    /Trae/.test(sv.doubao) && /豆包/.test(sv.doubao) && sv.doubao.length > 20, JSON.stringify(sv))
  check('★ 换一个变量名，那句话就收回去（不许停在上一项的结论上）', sv.other === '', JSON.stringify(sv))

  /*
   * 保存这条路的**打桩**测试。
   *
   * ⚠️ 为什么要打桩：这是唯一会往真实 `.env` 里写东西的动作。
   * 拿一个假 Key 去打真接口，会在用户的 `.env` 里留下一个**坏变量**，
   * 而且它看起来像"配过了" —— 比不填更坏。所以这里只验界面这一侧的行为：
   * 提交前清空输入框、提交后不回显、失败时把实测原因摆出来。
   */
  console.log('\n── 3d. 填 Key：值只去不返，成功/失败都要有交代 ──')
  await cdp.eval(`
    window.__origFetch2 = window.fetch
    window.__envCalls = []
    window.__envFail = false
    // 记下真实的成员列表：下面为了验"卡片从虚线变实心"会造一个豆包可用的假回包，
    // 用完必须还回去 —— 否则后面每一节用的成员可用数和真实情况对不上（假绿）。
    window.__savedMembers = window.AgentHub.state.members
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/api/env')) {
        window.__envCalls.push(String(init && init.body))
        if (window.__envFail) {
          // 「写进去了但重探本身出错」这条路 —— 服务端用 r.error 表达它
          return new Response(JSON.stringify({ ok: false, error: '探活没过：missing DOUBAO_API_KEY' }), { status: 200 })
        }
        const payload = JSON.parse(String(init && init.body))
        const lifted = window.__savedMembers.map((m) => m.id === 'doubao'
          ? Object.assign({}, m, { available: true, reason: '' })
          : m)
        return new Response(JSON.stringify({ ok: true, key: payload.key, replaced: false, members: lifted, roles: window.AgentHub.state.roles }))
      }
      return window.__origFetch2(url, init)
    }
    return 1
  `)
  const typed = 'sk-not-a-real-key-0001'
  await cdp.eval(`
    // ⚠️ 上一节把变量名切成了 CURSOR_API_KEY（验"那句话要收回去"），这里必须切回来 ——
    // 否则提交的是另一个变量，下面的断言测的就不是它以为的那条路。
    const sel = document.getElementById('keyVar')
    sel.value = 'DOUBAO_API_KEY'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    const inp = document.getElementById('keyInput')
    inp.value = '${typed}'
    document.querySelector('[data-act="save-key"]').click()
    return 1
  `)
  await sleep(500)
  const afterSave = await cdp.eval(`
    const inp = document.getElementById('keyInput')
    return JSON.stringify({
      calls: window.__envCalls.length,
      body: window.__envCalls[0] || '',
      inputVal: inp ? inp.value : '(表单已关)',
      // 密钥不许出现在 state / localStorage / 页面文本里
      inState: JSON.stringify(window.AgentHub.state).indexOf('${typed}') >= 0,
      inStorage: JSON.stringify(localStorage).indexOf('${typed}') >= 0,
      inDom: document.body.innerHTML.indexOf('${typed}') >= 0,
      // 成功之后：弹窗收起、豆包从"点这里补 Key"变成池子里的正常一员
      modalOpen: document.getElementById('modalRoot').classList.contains('open'),
      doubaoStillOff: !!document.querySelector('.pool-chip.off[data-id="doubao"]'),
      offIds: [...document.querySelectorAll('.pool-chip.off')].map((c) => c.dataset.id),
      toasts: [...document.querySelectorAll('#toastRoot .toast')].map((t) => t.textContent),
    })
  `)
  const as = JSON.parse(afterSave)
  check('★ 提交时确实带着变量名和值打给了 /api/env',
    as.calls === 1 && JSON.parse(as.body).key === 'DOUBAO_API_KEY', as.body)
  check('★★ 提交后输入框立刻被清空（密钥不在屏幕上多停一秒）',
    as.inputVal === '' || as.inputVal === '(表单已关)', JSON.stringify(as.inputVal))
  check('★★ 密钥不回显：state / localStorage / 页面里都搜不到它',
    !as.inState && !as.inStorage && !as.inDom,
    JSON.stringify({ inState: as.inState, inStorage: as.inStorage, inDom: as.inDom }))
  /*
   * 衔接：填完 Key 之后必须**当场**看得出谁被激活了。
   * 这正是 Phase 3 要解决的问题 —— 原来卡片一直是虚线的，用户填完也不知道成没成。
   */
  check('★★ 保存成功后弹窗收起，被激活的成员当场从"补 Key"变回正常一员',
    !as.modalOpen && !as.doubaoStillOff && !as.offIds.includes('doubao'),
    `还关着的：${as.offIds.join('、') || '（无）'}`)
  check('★ toast 点名说清是谁被激活了（不是一句"保存成功"）',
    as.toasts.some((t) => /豆包/.test(t) && /可用/.test(t)), JSON.stringify(as.toasts))

  // 把成员列表还原成实测结果 —— 下面每一节用的可用数都得是真的
  await cdp.eval(`
    window.AgentHub.state.members = window.__savedMembers
    window.AgentHub.render()
    return 1
  `)
  await sleep(150)

  // 失败路径：探活没过时，必须把**实测原因**原样摆出来，而不是只弹一句"失败了"
  await cdp.eval(`window.__envFail = true; return 1`)
  await cdp.eval(`
    // 还原之后 trae 仍是不可用的那一个 —— 点它重开表单
    document.querySelector('.pool-chip.off').click()
    return 1
  `)
  await sleep(220)
  await cdp.eval(`
    document.getElementById('keyInput').value = 'sk-not-a-real-key-0002'
    document.querySelector('[data-act="save-key"]').click()
    return 1
  `)
  await sleep(400)
  const failState = await cdp.eval(`
    const toasts = [...document.querySelectorAll('#toastRoot .toast')].map((t) => t.textContent)
    return JSON.stringify({
      toasts,
      modalStillOpen: document.getElementById('modalRoot').classList.contains('open'),
    })
  `)
  const fs2 = JSON.parse(failState)
  check('★★ 探活没过时把实测原因原样说出来（不许只说"保存失败"）',
    fs2.toasts.some((t) => /DOUBAO_API_KEY/.test(t)), failState)
  check('★ 这一路弹窗留着不关（要在原地重试，而不是逼用户从头点一遍）', fs2.modalStillOpen, failState)
  await cdp.eval(`
    window.fetch = window.__origFetch2
    delete window.__origFetch2; delete window.__envCalls; delete window.__envFail
    delete window.__savedMembers
    return 1
  `)
  await cdp.eval(`document.querySelector('[data-act="close-modal"]')?.click(); return 1`)
  await sleep(150)
  await cdp.eval(`window.AgentHub.state.homeTab = 'solo'; window.AgentHub.render(); return 1`)

  console.log('\n── 4. 新建会话弹窗 ──')
  await cdp.eval(`document.getElementById('newChatBtn').click(); return 1`)
  await sleep(150)
  check('弹窗已打开', await cdp.eval(`return document.getElementById('modalRoot').classList.contains('open')`))
  const pickable = await cdp.eval(`return document.querySelectorAll('.chat-pick').length`)
  check('可选成员数 = 实测可用数', pickable === okCount, `可选 ${pickable} 个`)
  check('不可用成员已置灰且带原因', await cdp.eval(`
    const rows = [...document.querySelectorAll('.checkbox-item')].filter(r => r.querySelector('input[disabled]'));
    return rows.length > 0 && rows.every(r => r.textContent.trim().length > 2)
  `))

  console.log('\n── 5. 创建一个会话（单成员）──')
  await cdp.eval(`
    const cb = document.querySelector('.chat-pick');
    cb.checked = true;
    document.querySelector('[data-act="create-chat"]').click();
    return 1
  `)
  await sleep(300)
  check('弹窗已关闭', await cdp.eval(`return !document.getElementById('modalRoot').classList.contains('open')`))
  check('主区切到单会话视图', await cdp.eval(`return !!document.querySelector('.chat-single')`))
  check('左栏出现会话条目', await cdp.eval(`return document.querySelectorAll('#chatList .item').length === 1`))
  check('内容列有 720px 上限（ChatGPT 观感）', await cdp.eval(`
    const el = document.querySelector('.stream-inner');
    return !!el && getComputedStyle(el).maxWidth === '720px'
  `))
  check('输入框存在且发送键初始禁用', await cdp.eval(`
    const ta = document.querySelector('textarea.ta'); const b = document.querySelector('.send-btn');
    return !!ta && !!b && b.disabled === true
  `))

  console.log('\n── 6. 输入后发送键应可用（草稿状态生效）──')
  await cdp.eval(`
    const ta = document.querySelector('textarea.ta');
    ta.value = '你好';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 1
  `)
  await sleep(120)
  check('打上字后发送键可用', await cdp.eval(`return document.querySelector('.send-btn').disabled === false`))
  check('草稿写进了状态（重渲染不丢字）', await cdp.eval(`
    const ta = document.querySelector('textarea.ta');
    const k = ta.dataset.cid + ':' + ta.dataset.mid;
    return window.AgentHub.state.drafts[k] === '你好'
  `))
  // 强制重渲染一次（切权限档会触发），验证草稿和焦点都还在
  await cdp.eval(`document.getElementById('permBtn').click(); return 1`)
  await sleep(150)
  check('重渲染后草稿仍在输入框里', await cdp.eval(`return document.querySelector('textarea.ta').value === '你好'`))
  check('权限档切换已生效（按钮文字变了）', await cdp.eval(`
    return document.getElementById('permLabel').textContent !== ''
  `))
  const permNow = await cdp.eval(`return window.AgentHub.state.permission`)
  check('权限档进入下一档', permNow === 'execute', `当前 ${permNow}`)

  console.log('\n── 7. 新建协同弹窗（拆解入口）──')
  await cdp.eval(`document.getElementById('newTaskBtn').click(); return 1`)
  await sleep(150)
  check('目标输入框存在', await cdp.eval(`return !!document.getElementById('goalBox')`))
  /*
   * 候选 = **实测可用成员** + **主脑（WorkBuddy）**。
   * 2026-10-02 起成员排在前、主脑垫底：默认只落在成员上 —— 成员有 CLI，拆解 + 执行都在本软件里跑完；
   * 主脑那条路引擎调不动它，选了就得用户切到 WorkBuddy 里粘一句话。
   * （默认值的完整断言在 11g 节，这里只确认两拨都在候选里、且成员在前主脑在后。）
   */
  const planOpts = await cdp.eval(`
    const sel = document.getElementById('plannerSel');
    const opts = [...sel.options];
    return { count: opts.length, first: opts[0] ? opts[0].value : null,
             firstText: opts[0] ? opts[0].textContent : '',
             last: opts.length ? opts[opts.length - 1].value : null }
  `)
  check('规划者可选项 = 实测可用成员 + 主脑（成员在前，主脑垫底）',
    planOpts.count === okCount + 1 && planOpts.first !== 'workbuddy' && planOpts.last === 'workbuddy',
    `共 ${planOpts.count} 项（可用成员 ${okCount} + 主脑 1），第一项 ${planOpts.first}「${planOpts.firstText}」，末项 ${planOpts.last}`)
  check('拆解按钮存在', await cdp.eval(`return !!document.getElementById('planBtn')`))
  await cdp.eval(`document.querySelector('[data-act="close-modal"]').click(); return 1`)
  await sleep(120)
  check('弹窗可关闭', await cdp.eval(`return !document.getElementById('modalRoot').classList.contains('open')`))

  // ── 7b. 残缺计划（缺指令）必须当场可见 + 本地拦下 ──
  /*
   * 2026-09-29 第二轮真跑的现场：拆解输出被截断，抢救逻辑救出一个
   * 「有 3 个子任务、但第三个没有 prompt」的计划。界面照常渲染、照常放行，
   * 点「确认执行」才弹「服务端错误：计划校验失败 — 子任务 s3 缺少 prompt」。
   * 用户白点一次，而且**界面上完全没提示是哪一行缺**。
   *
   * 引擎侧已经加了元素级校验（残缺项直接不给放行），这里是第二道防线：
   * 万一计划还是残缺地到了界面上，也必须当场看得出来、并在本地就拦住。
   * 用 fetch 打桩造一个残缺计划 —— 零成本，不碰真实拆解。
   */
  console.log('\n── 7b. 残缺计划：当场可见 + 本地拦下 ──')
  const activeBefore = await cdp.eval(`return JSON.stringify(window.AgentHub.state.active)`)
  await cdp.eval(`
    window.__origFetch = window.fetch
    window.fetch = async (url, init) => {
      // ⚠️ 用 endsWith 而不是 includes：/api/plan/request（交给主脑）也包含 /api/plan，
      // 用 includes 会把"交给主脑"那条路也一起打桩掉，测出来的就不是各走各的。
      // ⚠️ 本行注释**绝对不能出现反引号**：整段是外层模板字符串，
      // 一个反引号就把字符串提前闭合，页面拿到的后半段变成非法 JS。
      if (String(url).endsWith('/api/plan')) {
        return new Response(JSON.stringify({
          plan: { goal: '残缺计划测试', subtasks: [
            { id: 's1', title: '正常的一行', memberId: 'claude', role: '评审', prompt: '做点正事', dependsOn: [] },
            { id: 's2', title: '缺指令的一行', memberId: 'claude', role: '评审', prompt: '', dependsOn: [] },
          ]},
          raw: '', rawLength: 0, repaired: false, durationMs: 1,
        }))
      }
      // ⚠️ /api/run 也必须打桩 —— 否则"补齐指令后点提交"会真的发起协同执行（真调成员、真花钱）
      if (String(url).includes('/api/run')) {
        const stream = new ReadableStream({
          start(c) {
            const enc = new TextEncoder()
            // 用 fromCharCode 拼换行：本段整体是一个模板字符串，
            // 直接写 \\n 会被外层解析成真换行、把页面里的代码搞成语法错误
            const NL = String.fromCharCode(10) + String.fromCharCode(10)
            const sse = (o) => 'data: ' + JSON.stringify(o) + NL
            c.enqueue(enc.encode(sse({ type: 'plan-start', goal: '测试' })))
            c.enqueue(enc.encode(sse({ type: 'plan-finish', summary: { subtaskCount: 2, okCount: 0, failedCount: 0, suspectCount: 0, durationMs: 1, totalCostUsd: 0 } })))
            c.close()
          },
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return window.__origFetch(url, init)
    }
    return 1
  `)
  await cdp.eval(`document.getElementById('newTaskBtn').click(); return 1`)
  await sleep(150)
  /*
   * ⚠️ 这里**显式**把拆解者切成一个成员，不吃默认值。
   *
   * 默认值本来就是成员（2026-10-02 起，见 11g 节），但主脑那条路引擎根本不会拆 —— 它没有 CLI，
   * 走的是"落盘一份待拆解请求"。这一节测的是「引擎代拆回来的残缺计划在界面上的呈现」，
   * 所以必须保证走的是成员那条路。不切的话，打桩的 /api/plan 永远不会被调用，后面所有断言都会连锁失败。
   */
  await cdp.eval(`
    const sel = document.getElementById('plannerSel');
    const orchId = window.AgentHub.state.orchestrator ? window.AgentHub.state.orchestrator.id : null;
    const m = [...sel.options].find(o => o.value !== orchId);
    sel.value = m.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('goalBox').value = '测试残缺计划';
    document.getElementById('planBtn').click();
    return 1
  `)
  await sleep(500)

  check('残缺行被标记出来（data-broken）', await cdp.eval(`return document.querySelectorAll('#planRows .plan-row[data-broken]').length === 1`))
  check('残缺行的指令框默认展开（不用再点一下）', await cdp.eval(`
    const row = document.querySelector('.plan-row[data-broken]')
    return !!row && row.querySelector('.plan-prompt').style.display !== 'none'
  `))
  check('表上有文字说明它缺什么', await cdp.eval(`
    const row = document.querySelector('.plan-row[data-broken]')
    return !!row && /没有指令/.test(row.textContent)
  `))

  // 失败策略：一个子任务失败之后，剩下的活怎么办。
  // 它决定了"已花的钱能不能换到成品"，所以必须让用户看得见、选得了，且默认值不能是那个翻过车的。
  const policySel = await cdp.eval(`
    const sel = document.getElementById('taskPolicy')
    if (!sel) return null
    return { options: [...sel.options].map(o => o.value), value: sel.value,
             text: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '' }
  `)
  check('计划确认框里有「失败策略」下拉', !!policySel)
  check('三种策略都在，且默认是 skip-blocked（不是当年翻车的 abort）',
    !!policySel && policySel.options.join(',') === 'skip-blocked,salvage,abort' && policySel.value === 'skip-blocked',
    policySel ? `实际 ${policySel.value} / ${policySel.options.join(',')}` : '没找到下拉')
  check('每个策略都写清了代价（不让用户凭猜选）',
    !!policySel && /依赖/.test(policySel.text) && policySel.text.length > 8,
    policySel ? policySel.text : '')

  const tasksBefore = await cdp.eval(`return window.AgentHub.state.tasks.length`)
  await cdp.eval(`document.querySelector('[data-act="confirm-task"]').click(); return 1`)
  await sleep(250)
  const tasksAfter = await cdp.eval(`return window.AgentHub.state.tasks.length`)
  check('点执行被本地拦下（没有产生任务，也没白跑一次服务端）', tasksAfter === tasksBefore, `之前 ${tasksBefore} / 之后 ${tasksAfter}`)
  const toastTexts = await cdp.eval(`return [...document.querySelectorAll('#toastRoot .toast')].map(t => t.textContent)`)
  check(
    '给出了点名的错误提示',
    toastTexts.some((x) => /s2/.test(x) && /指令/.test(x)),
    `实际 toast：${JSON.stringify(toastTexts)}`
  )

  // 复原：补上指令后应当可以正常提交（证明拦的是"残缺"而不是"一律不放行"）
  await cdp.eval(`
    const row = document.querySelector('.plan-row[data-broken]')
    row.querySelector('.plan-prompt').value = '补上的指令'
    return 1
  `)
  await cdp.eval(`document.querySelector('[data-act="confirm-task"]').click(); return 1`)
  await sleep(400)
  check('补齐指令后可以正常提交（拦的是残缺，不是一刀切）', await cdp.eval(`return window.AgentHub.state.tasks.length`) === tasksBefore + 1)

  await cdp.eval(`window.fetch = window.__origFetch; delete window.__origFetch; return 1`)
  // 复原视图：刚才 confirmTask 把当前视图切成 task 了，但后面几节还在用会话视图
  await cdp.eval(`window.AgentHub.state.active = ${activeBefore}; window.AgentHub.render(); return 1`)

  // ════════════════════════════════════════════════════════════════════════
  // 7c. 分工真的传下去了吗 + 派错人当场看得出来
  //
  // 3c 验的是"工作台上勾得动、看得见"，这一节验的是**勾了之后有没有用**：
  //   ① 勾的三个角色，原样进了 POST /api/plan 的请求体（半路丢一个就等于白勾）；
  //   ② 确认表里**每一行**都给出这个角色的职责与交付物（"分工再详细点"的落点）；
  //   ③ 把某一行派给一个干不了这活的人，界面上**当场**出警告 ——
  //      规划者的提示词一直在叮嘱模型别派错人，但结论从没显示给用户看过。
  //
  // ⚠️ 全程打桩：真的拆解要花钱、还依赖成员可用，而这里验的是界面与协议，不是模型。
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 7c. 分工传下去 + 派错人当场看得出来 ──')
  await cdp.eval(`
    window.__origFetch3 = window.fetch
    window.__planBody = null
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/api/plan')) {
        window.__planBody = String(init && init.body)
        const sent = JSON.parse(window.__planBody)
        // 按"指定的分工"回一个计划：一个角色一步，第二行故意派给豆包（它没有 code 能力、也不改文件）
        const avail = window.AgentHub.state.members.filter((m) => m.available).map((m) => m.id)
        const subtasks = (sent.roles || []).map((role, i) => ({
          id: 's' + (i + 1),
          title: role + '这一步',
          memberId: role === '文档书写' ? 'doubao' : (avail[0] || ''),
          role: role,
          prompt: '做' + role + '这件事',
          dependsOn: i ? ['s' + i] : [],
        }))
        return new Response(JSON.stringify({
          plan: { goal: sent.goal, subtasks: subtasks },
          raw: '', rawLength: 0, repaired: false, durationMs: 1,
        }))
      }
      // 确认执行之后的 /api/run 也要打桩 —— 否则这里会真的发起一次协同（真调成员、真花钱）
      if (String(url).includes('/api/run')) {
        const stream = new ReadableStream({
          start(c) {
            const enc = new TextEncoder()
            const NL = String.fromCharCode(10) + String.fromCharCode(10)
            const sse = (o) => 'data: ' + JSON.stringify(o) + NL
            c.enqueue(enc.encode(sse({ type: 'plan-start', goal: '测试分工' })))
            c.enqueue(enc.encode(sse({ type: 'plan-finish', summary: { subtaskCount: 3, okCount: 0, failedCount: 0, suspectCount: 0, durationMs: 1, totalCostUsd: 0 } })))
            c.close()
          },
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return window.__origFetch3(url, init)
    }
    return 1
  `)

  // 走工作台这条路（不是弹窗）—— 分工是从左栏勾出来的
  await cdp.eval(`
    const A = window.AgentHub
    A.state.homeTab = 'coop'
    A.state.active = { type: 'blank', id: null }
    A.state._roles = []
    A.render()
    return 1
  `)
  await sleep(200)
  await cdp.eval(`
    const byRole = (label) => [...document.querySelectorAll('.role-pick')].find((p) => p.dataset.role === label)
    byRole('代码主笔').click(); byRole('评审').click(); byRole('文档书写').click()
    // 规划者必须是**成员**（主脑那条路引擎根本不拆；虽然现在默认就落在成员上，这里仍显式切一次，不靠默认值兜）
    const sel = document.getElementById('homePlannerSel')
    const orch = window.AgentHub.state.orchestrator ? window.AgentHub.state.orchestrator.id : null
    const m = [...sel.options].find((o) => o.value !== orch)
    sel.value = m.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('homeGoalBox').value = '测试分工传参'
    document.getElementById('homePlanBtn').click()
    return 1
  `)
  await sleep(600)

  const sentBody = await cdp.eval(`return JSON.stringify({ body: window.__planBody, rows: document.querySelectorAll('#planRows .plan-row').length })`)
  const sb = JSON.parse(sentBody)
  check('★★ 工作台勾的三个分工原样进了拆解请求（半路丢一个就等于白勾）',
    !!sb.body && JSON.parse(sb.body).roles.join(',') === '代码主笔,评审,文档书写', sentBody)
  check('★ 拆解按钮点完恢复可用（不能停在"拆解中…"上再也点不动）', await cdp.eval(`
    const b = document.getElementById('homePlanBtn')
    return !!b && !b.disabled
  `))
  check('拆回来的计划进了确认表', sb.rows === 3, sentBody)

  const rowNotes = await cdp.eval(`
    const rows = [...document.querySelectorAll('#planRows .plan-row')]
    return JSON.stringify(rows.map((r) => ({
      role: r.querySelector('.plan-role')?.value || '',
      member: r.querySelector('.plan-member')?.value || '',
      memberText: (r.querySelector('.plan-member')?.selectedOptions[0]?.textContent || '').trim(),
      note: (r.querySelector('[data-role-note]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      misfit: [...r.querySelectorAll('.pr-misfit')].map((m) => m.textContent.trim()),
    })))
  `)
  const rn = JSON.parse(rowNotes)
  check('★★ 确认表每一行都写着这个角色的职责与交付物（"分工再详细点"的落点）',
    rn.every((r) => /职责/.test(r.note) && /交付物/.test(r.note)), rowNotes)
  check('★ 职责与交付物是**照着角色目录**写的，不是把角色名复述一遍',
    rn.every((r) => r.note.replace(/职责|交付物/g, '').length > 20), rowNotes)
  /*
   * ★★ 派错人必须当场可见。这里第二行是「文档书写」派给了豆包 ——
   * 豆包的能力标签只有 doc（这条角色它其实**够得着**），但它 writeCapable === false，
   * 而文档书写要改文件 —— 所以它该出的警告是"这一步要改文件，但豆包不操作本地文件"。
   */
  const misfitRow = rn.find((r) => r.member === 'doubao')
  check('★★ 派不动这活的人，那一行当场出警告（不含糊、不等到跑起来才失败）',
    !!misfitRow && misfitRow.misfit.length > 0, JSON.stringify(misfitRow))
  check('★ 警告说的是"为什么派不动"，而不是一句"建议换人"',
    !!misfitRow && /豆包/.test(misfitRow.misfit.join(' ')) && /文件|能力/.test(misfitRow.misfit.join(' ')),
    JSON.stringify(misfitRow && misfitRow.misfit))
  /*
   * ★★ 显示与提交必须是同一个人。
   * 豆包此刻**不可用**，所以它不在可用成员的下拉里 —— 只列可用成员的话，
   * 浏览器会把 select 显示成第一项（Claude），而警告还在说豆包：
   * 下拉说 Claude、警告说豆包，用户没法判断哪句是真的，而提交时读的是下拉的值。
   */
  check('★★ 下拉显示的必须就是那个被派的人（不能显示 Claude、警告豆包）',
    !!misfitRow && misfitRow.memberText.includes('豆包'), JSON.stringify(misfitRow && misfitRow.memberText))

  // 就地改角色 → 结论必须跟着变（不许停在旧组合上）
  const liveNote = await cdp.eval(`
    const row = [...document.querySelectorAll('#planRows .plan-row')].find((r) => r.querySelector('.plan-member').value === 'doubao')
    const sel = row.querySelector('.plan-role')
    const before = row.querySelector('[data-role-note]').textContent
    // 换成「调研」：它不要求任何能力、也不改文件 —— 豆包干得了，警告就该收回去
    sel.value = '调研'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    const after = row.querySelector('[data-role-note]').textContent
    // 对照必须是**目录里那条**，不是"文字里有没有出现角色名" ——
    // 说明文字里根本不写角色名（写的是职责），拿名字去找只会误判成没变。
    const duty = ((window.AgentHub.state.roles || []).find((r) => r.label === '调研') || {}).duty || ''
    return JSON.stringify({
      before: before.replace(/\\s+/g, ' ').slice(0, 40),
      after: after.replace(/\\s+/g, ' ').slice(0, 60),
      dutyMatched: !!duty && after.indexOf(duty) >= 0,
      stillWarns: row.querySelectorAll('.pr-misfit').length })
  `)
  const ln = JSON.parse(liveNote)
  check('★★ 在这一行里换个角色，职责/警告当场跟着变（不会停在旧组合的结论上）',
    ln.stillWarns === 0 && ln.dutyMatched && ln.before !== ln.after, liveNote)

  // 收尾：清掉这次的确认表与打桩，别把计划草稿留给后面几节
  await cdp.eval(`
    window.fetch = window.__origFetch3
    delete window.__origFetch3; delete window.__planBody
    document.querySelector('[data-act="close-modal"]')?.click()
    window.AgentHub.state.homeTab = 'solo'
    window.AgentHub.state._roles = []
    window.AgentHub.state.active = ${activeBefore}
    window.AgentHub.render()
    return 1
  `)
  await sleep(200)
  check('收尾：工作台的分工已清空、回到会话视图（不给后面几节留状态）', await cdp.eval(`
    const A = window.AgentHub
    return (A.state._roles || []).length === 0 && A.state.active.type !== 'blank'
  `))

  console.log('\n── 8. 成员管理弹窗 ──')
  await cdp.eval(`document.getElementById('membersBtn').click(); return 1`)
  await sleep(200)
  const rows = await cdp.eval(`return document.querySelectorAll('.member-row').length`)
  check('成员行数与配置一致', rows === TOTAL_MEMBERS, `实际 ${rows} 行 / 配置 ${TOTAL_MEMBERS} 个`)
  check('每行有「测试」按钮', await cdp.eval(`return document.querySelectorAll('[data-act="test-member"]').length === ${TOTAL_MEMBERS}`))
  check('每行有默认权限档下拉', await cdp.eval(`return document.querySelectorAll('.member-row select[data-act="set-perm"]').length === ${TOTAL_MEMBERS}`))
  // 计费口径必须透到界面 —— 实测 qoder 是按积分扣费的，界面以前挂的是 `free` 假标签
  check('★ 每行都标了计费口径（不再是 free）',
    await cdp.eval(`return [...document.querySelectorAll('.member-row')].every(r => r.textContent.includes('计费'))`))
  check('★ 成员管理弹窗里没有 free 这种假标签',
    await cdp.eval(`return !document.getElementById('modalRoot').textContent.includes('free')`))
  check('可添加自定义成员', await cdp.eval(`return !!document.querySelector('[data-act="add-member"]')`))
  await cdp.eval(`document.querySelector('[data-act="add-member"]').click(); return 1`)
  await sleep(150)
  check('自定义成员表单字段齐全', await cdp.eval(`
    return ['nmId','nmName','nmCmd','nmArgs','nmMode','nmPerm','nmCaps'].every(id => !!document.getElementById(id))
  `))
  check('★ 自定义成员的能力标签默认值不带 free（那是误导）',
    await cdp.eval(`return !/free/i.test(document.getElementById('nmCaps').value)`))
  await cdp.eval(`document.querySelector('[data-act="close-modal"]').click(); return 1`)
  await sleep(120)

  console.log('\n── 9. 编辑器区（文件树 + 打开文件）──')
  await cdp.eval(`document.getElementById('editorToggle').click(); return 1`)
  await sleep(600)
  check('编辑器已展开', await cdp.eval(`return !document.getElementById('editorPane').classList.contains('hidden')`))
  check('文件树读到了内容', await cdp.eval(`return document.querySelectorAll('#treeItems .ft-item').length > 0`),
    `条目数 ${await cdp.eval(`return document.querySelectorAll('#treeItems .ft-item').length`)}`)
  check('文件树能进入子目录', await cdp.eval(`return !!document.querySelector('[data-act="tree-into"]')`))
  const opened = await cdp.eval(`
    const f = document.querySelector('[data-act="open-file"]');
    if (!f) return 'no-file'
    f.click();
    await new Promise(r => setTimeout(r, 700));
    const v = document.getElementById('fileView');
    return (v.value || '').length > 0 ? 'ok' : 'empty'
  `)
  check('能打开并读到文件内容', opened === 'ok', `结果 ${opened}`)

  console.log('\n── 10. 广播：发出即渲染（回归）──')
  /*
   * 这条断言是补回来的 —— 截图曾经抓到过一个真 bug：
   * 广播路径里漏了一次 `render()`，点了「发送」之后界面**几秒钟毫无反应**，
   * 消息 / 忙碌态 / 「接收广播中」标记全都要等所有列跑完才一次性冒出来。
   * 单列路径没这毛病，所以只有多列才复现 —— 靠肉眼翻代码很难发现。
   *
   * 为了不让回归测试本身花钱，这里把页面的 fetch 打桩：/api/chat 一律走假响应、
   * 且故意慢 3 秒。这样"发出即渲染"是否成立，隔离得干干净净。
   */
  await cdp.eval(`window.AgentHub.state.editorOpen = false; window.AgentHub.render(); return 1`)
  await cdp.eval(`
    document.getElementById('newChatBtn').click();
    await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('.chat-pick')].slice(0, 2).forEach(x => { x.checked = true });
    document.querySelector('[data-act="create-chat"]').click();
    return 1
  `)
  await sleep(400)
  check('并排视图已渲染两列', await cdp.eval(`return document.querySelectorAll('.grid-col').length === 2`))
  check('并排时左栏自动收成图标条', await cdp.eval(`return document.getElementById('sidebar').classList.contains('mini')`))
  check('每列底部都有「发给全部」勾选框', await cdp.eval(`
    return document.querySelectorAll('.broadcast-bar input[type=checkbox][data-act="toggle-broadcast"]').length === 2
  `))

  await cdp.eval(`
    window.__origFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/api/chat')) {
        await new Promise(r => setTimeout(r, 3000));       // 故意慢，好观察"发出即渲染"
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          memberId: body.memberId, memberName: body.memberId, status: 'ok',
          text: '【测试桩】收到：' + body.prompt, cost: {}, durationMs: 3000,
          raw: { exitCode: 0, command: 'stub' },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return window.__origFetch(url, init);
    };
    return 1
  `)

  await cdp.eval(`
    const ta = document.querySelector('textarea.ta');
    ta.value = '广播回归测试指令';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const cb = document.querySelector('.broadcast-bar input[type=checkbox]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-act="send"]').click();
    return 1
  `)

  await sleep(600)   // 桩要 3 秒才回，此刻只该有"发出"的痕迹
  const immediate = await cdp.eval(`
    return {
      userBubbles: document.querySelectorAll('.msg-user .bubble').length,
      busyLines: document.querySelectorAll('.msg-tool').length,
      recvBadge: document.querySelectorAll('.recv-badge').length,
    }
  `)
  check('发出后立刻看到 2 条用户消息（而不是等跑完才冒出来）', immediate.userBubbles === 2, `实际 ${immediate.userBubbles}`)
  check('发出后立刻看到两列都在忙', immediate.busyLines === 2, `实际 ${immediate.busyLines}`)
  check('非发起列显示「接收广播中」', immediate.recvBadge >= 1, `实际 ${immediate.recvBadge}`)

  await sleep(3400)
  const after = await cdp.eval(`
    return {
      aiLines: document.querySelectorAll('.msg-ai').length,
      stubbed: [...document.querySelectorAll('.msg-ai')].filter(x => x.textContent.includes('【测试桩】')).length,
    }
  `)
  check('两列都拿到了各自的回复', after.aiLines === 2 && after.stubbed === 2, `ai 消息 ${after.aiLines} 条，其中桩回复 ${after.stubbed} 条`)

  // 还原打桩 + 清掉这条测试会话，别让它出现在后面的截图里
  await cdp.eval(`
    window.fetch = window.__origFetch;
    const S = window.AgentHub.state;
    S.chats = S.chats.filter(c => c.title.includes('+') ? false : true);
    S.active = { type: 'blank', id: null };
    S.broadcast = {};
    window.AgentHub.render();
    return 1
  `)

  // ── 10b. 回车发送（以及两条必须让开的情况） ──
  //
  // 起因：原来只有 Ctrl+回车能发，而**界面上没有任何地方写过这件事** ——
  // 用户按回车没反应，只会得出"这软件发不出消息"的结论（2026-10-02 实测反馈）。
  // 一个得靠猜才能发现的快捷键，等于没有这个快捷键。
  //
  // 三条一起钉：回车要能发；Shift+回车是换行、不是发送；
  // 中文输入法的合成期必须**不发** —— 否则打中文每选一次候选词就把半句话发出去。
  console.log('\n── 10b. 回车发送 ──')
  await cdp.eval(`
    window.__origFetch3 = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/api/chat')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          memberId: body.memberId, memberName: body.memberId, status: 'ok',
          text: '【回车厢】' + body.prompt, cost: {}, durationMs: 5,
          raw: { exitCode: 0, command: 'stub' },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return window.__origFetch3(url, init);
    };
    return 1
  `)

  const enterProbe = await cdp.eval(`
    const A = window.AgentHub;
    const single = A.state.chats.find(c => c.memberIds.length === 1);
    window.__enterChatId = single.id;
    window.__enterSnap = JSON.stringify(single);   // 用了之后还原，别给后面的断言留状态
    A.state.active = { type: 'chat', id: single.id };
    A.state.broadcast = {};
    A.render();
    await new Promise(r => setTimeout(r, 60));

    const ta = () => document.querySelector('textarea.ta');
    const users = () => document.querySelectorAll('.msg-user .bubble').length;
    const fire = (extra) => ta().dispatchEvent(new KeyboardEvent('keydown',
      Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, extra)));
    const type = (v) => { ta().value = v; ta().dispatchEvent(new Event('input', { bubbles: true })); };

    ta().focus();
    const focused = document.activeElement === ta();
    const before = users();

    // ① 合成期（打中文选词）按回车：必须不发
    type('中文输入中');
    fire({ isComposing: true });
    await new Promise(r => setTimeout(r, 60));
    const composingSent = users() !== before;
    const composingKeptText = ta().value;

    // ② Shift+回车：换行，不是发送
    fire({ shiftKey: true });
    await new Promise(r => setTimeout(r, 60));
    const shiftSent = users() !== before;

    // ③ 光按回车：发出去
    type('回车发送');
    fire({});
    await new Promise(r => setTimeout(r, 350));
    const after = users();
    const draftLeft = A.state.drafts[single.id + ':' + single.memberIds[0]] || '';

    return {
      focused, composingSent, composingKeptText, shiftSent,
      sent: after === before + 1,
      draftLeft,
      hint: (document.querySelector('.composer-hint') || {}).textContent || '',
    }
  `)
  check('输入框拿到了焦点（否则下面的回车都无从谈起）', enterProbe.focused)
  check('★★ 普通回车就把消息发出去了（不用记 Ctrl+回车）', enterProbe.sent && enterProbe.draftLeft === '', JSON.stringify(enterProbe))
  check('★ Shift+回车只换行，不发送', enterProbe.shiftSent === false)
  check('★★ 中文输入法合成期按回车不发，且已打的字要留着', enterProbe.composingSent === false && enterProbe.composingKeptText === '中文输入中', JSON.stringify(enterProbe))
  check('★ 发送方式写在输入框下面（不然又是个得靠猜的快捷键）', /回车发送/.test(enterProbe.hint), enterProbe.hint.slice(0, 90))

  // 还原打桩 + 把这条会话恢复到用之前的样子
  await cdp.eval(`
    window.fetch = window.__origFetch3; delete window.__origFetch3;
    const S = window.AgentHub.state;
    const i = S.chats.findIndex(c => c.id === window.__enterChatId);
    if (i >= 0) S.chats[i] = JSON.parse(window.__enterSnap);
    delete window.__enterSnap; delete window.__enterChatId;
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)
  // ── 11b. 协同卡片：文件改动三态（打桩，不花钱、不依赖成员可用） ──
  //
  // 引擎现在会自己采集文件改动（src/engine/changes.js）。
  // 界面必须把三种状态分得清清楚楚：有改动 / 完整采集但零改动 / 未采集。
  // 把"未采集"渲染成"无改动"，用户会以为这个成员什么都没干 —— 那是另一处假绿，
  // 只是从数据层搬到了给人看的那一层。
  console.log('\n── 11b. 协同卡片：文件改动三态 ──')
  const cfTexts = await cdp.eval(`
    const A = window.AgentHub;
    const task = { id:'cf-task', title:'文件改动三态', goal:'g', plan:{ goal:'g', subtasks:[] },
      permission:'execute', status:'running', cards:{}, cardOrder:[], logs:[],
      summary:null, markdown:'', startedAt: Date.now() };
    A.state.tasks.unshift(task);
    A.state.active = { type:'task', id: task.id };
    for (const [i, id] of ['c1','c2','c3'].entries()) {
      task.cards[id] = { id, title:'卡'+(i+1), memberId:'claude', role:'测试', prompt:'p',
        status:'run', startedAt: Date.now(), durationMs:0, text:'', cost:{}, quality:null, changedFiles:null };
      task.cardOrder.push(id);
    }
    A.render();
    const noop = () => {};
    const fin = (id, changedFiles) => A.onTaskEvent(task, {
      type:'subtask-finish', id, status:'ok', text:'产出', cost:{}, durationMs:10,
      quality:{ level:'ok', codes:[], note:'' }, changedFiles,
      memberName:'克劳德', role:'测试' }, noop);
    fin('c1', ['src/a.js','tests/b.mjs']);
    fin('c2', []);
    fin('c3', null);
    // 任务页是「左栏选一步 / 右栏看那一步」：右栏同时只显示一步的详情，
    // 所以要逐个选中再读，不能指望三张卡的改动说明同时挂在 DOM 上。
    const out = [];
    for (const id of ['c1','c2','c3']) {
      A.state.pickedStep = id;
      A.render();
      const el = document.querySelector('[data-changed-files]');
      out.push(el ? el.textContent : '');
    }
    return out
  `)
  const cf = (i) => String(cfTexts[i] || '')
  check('有改动 → 列出数量与文件名', cf(0).includes('改动 2 个文件') && cf(0).includes('src/a.js'), cf(0))
  check('完整采集但零改动 → 明确写「无（已完整采集）」', cf(1).includes('无（已完整采集）'), cf(1))
  check('★ 未采集 → 写「未采集」，绝不许写成「无改动」', cf(2).includes('未采集') && !cf(2).includes('已完整采集'), cf(2))

  // 清掉这张测试任务，别留在后面的截图里
  await cdp.eval(`
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'cf-task');
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)

  // ── 11b2. 任务跑动期间：只重画变动的那一块 ──
  //
  // 起因：任务视图原来每来一个事件就把整屏重建一遍（main.innerHTML = 一大串字符串），
  // 一个几十步、日志攒到几百行的任务，每个事件都要重新解析上千个节点 ——
  // 而事件是成串来的，同一帧里能重画好几轮。
  // 改成增量之后**必须有断言盯着**，否则"优化"很容易悄悄变成"少画了一条"。
  // 所以这里验的不是"长得对"，而是**节点身份**：没变的那块必须还是同一个节点。
  console.log('\n── 11b2. 任务视图：增量重画 ──')
  const inc = await cdp.eval(`
    const A = window.AgentHub;
    const task = { id:'inc-task', title:'增量重画', goal:'g',
      plan:{ goal:'g', subtasks:[
        { id:'i1', title:'第一步', memberId:'claude', prompt:'p' },
        { id:'i2', title:'第二步', memberId:'claude', prompt:'p' } ] },
      permission:'plan', status:'running', cards:{}, cardOrder:[], logs:[],
      summary:null, markdown:'', startedAt: Date.now() };
    A.state.tasks.unshift(task);
    A.state.active = { type:'task', id: task.id };
    A.render();

    const log = (text) => task.logs.push({ t: '00:00:00', text });
    A.onTaskEvent(task, { type:'plan-accepted', batches:[['i1','i2']] }, log);

    const main = document.getElementById('main');
    const railOf = () => [...main.querySelectorAll('.coop-steps [data-act="pick-step"]')];
    const before = {
      rail: railOf(),
      head: main.querySelector('.task-head'),
      right: main.querySelector('.coop-right'),
      logs: main.querySelector('#taskLogs'),
      logLines: main.querySelectorAll('#taskLogs > div').length,
    };

    // 只让 i2 结束 —— i1 从头到尾没动过
    A.onTaskEvent(task, { type:'subtask-finish', id:'i2', status:'ok', text:'产出',
      cost:{}, durationMs:10, quality:{ level:'ok', codes:[], note:'' }, changedFiles:null,
      memberName:'克劳德', role:'执行者' }, log);

    const after = { rail: railOf(), head: main.querySelector('.task-head'),
      right: main.querySelector('.coop-right'), logs: main.querySelector('#taskLogs'),
      logLines: main.querySelectorAll('#taskLogs > div').length };

    return {
      railCount: before.rail.length + '->' + after.rail.length,
      i1Kept: after.rail[0] === before.rail[0],
      i2Replaced: after.rail[1] !== before.rail[1],
      i2SaysDone: (after.rail[1] ? after.rail[1].textContent : '').indexOf('已完成') >= 0,
      i1StillWaiting: (after.rail[0] ? after.rail[0].textContent : '').indexOf('等待') >= 0,
      logsNodeKept: after.logs === before.logs,
      logGrew: after.logLines === before.logLines + 1,
      headTouched: after.head !== before.head,
      headSaysDone: (after.head ? after.head.textContent : '').indexOf('已完成') >= 0,
      rightKeptWhenUnchanged: after.right === before.right,
    }
  `)
  check('★★ 没变的那一步：节点身份原样保留（真的没重画它）', inc.i1Kept && inc.i1StillWaiting, JSON.stringify(inc))
  check('★ 变了的那一步：只换它自己', inc.i2Replaced && inc.i2SaysDone, inc.railCount)
  check('★ 日志区是同一个节点、只往后追加（不是整块重建）', inc.logsNodeKept && inc.logGrew, `节点保持=${inc.logsNodeKept} 新增行=${inc.logGrew}`)
  check('★ 任务头的数字跟着变（这一步不能省）', inc.headTouched && inc.headSaysDone)
  check('★ 没被选中、也没变动的那一栏：不重画', inc.rightKeptWhenUnchanged)

  // 清掉这张测试任务
  await cdp.eval(`
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'inc-task');
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)
  // ── 11c. 「未执行」与「上游缺口」：第三种状态不能在界面上长成"失败" ──
  //
  // 引擎侧已经分开了三种状态（成功 / 失败 / 没执行），界面如果又把它们合并成"失败"，
  // 前面白分。同一类问题在数据层/传递层/报告层/界面层各长一遍，每层都得单独钉。
  console.log('\n── 11c. 协同卡片：未执行（第三种状态）+ 上游缺口 ──')
  const skipProbe = await cdp.eval(`
    const A = window.AgentHub;
    const task = { id:'skip-task', title:'未执行与缺口', goal:'g',
      plan:{ goal:'g', subtasks:[
        { id:'k1', memberId:'claude', role:'测试', prompt:'PROMPT-K1' },
        { id:'k2', memberId:'claude', role:'测试', prompt:'PROMPT-K2', dependsOn:['k1'] },
        { id:'k3', memberId:'claude', role:'测试', prompt:'PROMPT-K3', dependsOn:['k1'] },
      ] },
      permission:'execute', failurePolicy:'salvage', status:'running',
      cards:{}, cardOrder:['k1','k2','k3'], logs:[], summary:null, markdown:'', startedAt: Date.now() };
    A.state.tasks.unshift(task); A.state.active = { type:'task', id: task.id };
    for (const id of task.cardOrder) {
      task.cards[id] = { id, title:'卡'+id, memberId:'claude', role:'测试', prompt:'PROMPT-'+id.toUpperCase(),
        status:'run', startedAt: Date.now(), durationMs:0, text:'', cost:{}, quality:null,
        changedFiles:null, degradedUpstream:[], skipKind:'', _tid: task.id };
    }
    A.render();
    // 事件处理里的 log 回调要真接上，否则"日志里怎么说的"那一条就测了个空
    const noop = (text) => { task.logs.push({ t: '00:00:00', text }) };
    // k1 挂了
    A.onTaskEvent(task, { type:'subtask-finish', id:'k1', status:'failed', text:'挂了的说明',
      cost:{}, durationMs:5, quality:{ level:'ok', codes:[], note:'' }, changedFiles:null,
      degradedUpstream:[], memberName:'克劳德', role:'测试' }, noop);
    // k2 因为依赖断了 → 引擎没调用它
    A.onTaskEvent(task, { type:'subtask-skip', id:'k2', skipKind:'blocked',
      text:'未执行：依赖的 k1 没有可用产出', memberName:'克劳德', role:'测试' }, noop);
    // k3 带缺口跑完了
    A.onTaskEvent(task, { type:'subtask-finish', id:'k3', status:'ok', text:'带缺口的产出',
      cost:{}, durationMs:5, quality:{ level:'ok', codes:[], note:'' }, changedFiles:[],
      degradedUpstream:['k1'], memberName:'克劳德', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'plan-finish', summary:{ subtaskCount:3, executedCount:2, okCount:1,
      failedCount:1, suspectCount:0, skippedCount:1, skippedByKind:{ blocked:1, aborted:0, budget:0 },
      degradedCount:1, costUnknownCount:2, creditsReportedCount:0, totalCredits:0,
      tokenReportedCount:0, durationMs:10, totalCostUsd:0 } }, noop);
    A.render();
    /*
     * 左栏一条 .step 承载"状态"，右栏 .coop-right 承载"这一步说了什么"。
     * 右栏一次只显示选中的那一步，所以逐条选中再读 —— 断言的原意（三种状态
     * 在界面上必须长得不一样）一条没变，只是换到了新的两栏结构上。
     * ⚠️ 这段注释里不能出现反引号：整个片段是外层模板字符串拼出来的，
     *    一个反引号就会把它提前闭合（browser.mjs 顶部记着同样的坑）。
     */
    const pick = (id) => {
      A.state.pickedStep = id; A.render();
      const step = document.querySelector('.step[data-id="' + id + '"]');
      const right = document.querySelector('.coop-right');
      return {
        stepText: step ? step.textContent : '',
        stepClass: step ? step.className : '',
        rightText: right ? right.textContent : '',
        rightClass: right ? right.className : '',
        labels: right ? [...right.querySelectorAll('.turn-label')].map(x => x.textContent) : [],
      };
    };
    const k1 = pick('k1'), k2 = pick('k2'), k3 = pick('k3');
    return {
      failText: k1.rightText, failClass: k1.stepClass,
      skipText: k2.rightText, skipClass: k2.stepClass,
      gapText: k3.rightText, gapClass: k3.stepClass,
      connectors: [...k1.labels, ...k2.labels, ...k3.labels],
      badges: [...document.querySelectorAll('.task-head .badge')].map(x => x.textContent),
      logs: task.logs.map(l => l.text),
    }
  `)

  check('真失败的卡片仍然是「失败」', skipProbe.failClass.includes('fail') && skipProbe.failText.includes('失败'), skipProbe.failText.slice(0, 60))
  check('★ 未执行的卡片标「未执行」，且**不带 fail 样式**（红卡片会让人去点重试）',
    skipProbe.skipText.includes('未执行') && skipProbe.skipClass.includes('skip') && !skipProbe.skipClass.includes('fail'),
    `class=${skipProbe.skipClass} / ${skipProbe.skipText.slice(0, 60)}`)
  check('★ 未执行的卡片不印指令、不印产出（那两格本来就是空的）',
    !skipProbe.skipText.includes('PROMPT-K2') && skipProbe.skipText.includes('没有花费、也没有产出'),
    skipProbe.skipText.slice(0, 120))
  check('未执行的卡片写明是哪一类原因', skipProbe.skipText.includes('依赖断链'), skipProbe.skipText.slice(0, 80))
  check('★ 带缺口跑完的卡片必须和干净的完成长得不一样',
    skipProbe.gapText.includes('上游缺口') && skipProbe.gapText.includes('k1') && skipProbe.gapClass.includes('done'),
    skipProbe.gapText.slice(0, 100))
  check('依赖断了的时候，连线上不再说"产出已注入"',
    skipProbe.connectors.some(t => t.includes('没有可用产出')) && !skipProbe.connectors.some(t => t.includes('已注入')),
    JSON.stringify(skipProbe.connectors))
  check('任务头把「未执行」「带缺口」都标出来',
    skipProbe.badges.some(b => b.includes('1 步未执行')) && skipProbe.badges.some(b => b.includes('1 步带缺口')),
    JSON.stringify(skipProbe.badges))
  check('任务头显示这次用的失败策略',
    skipProbe.badges.some(b => b.includes('失败策略')), JSON.stringify(skipProbe.badges))
  check('日志里「未执行」和「失败」分开说',
    skipProbe.logs.some(l => /全部结束：1\/3 成功 · 1 失败 · 1 未执行/.test(l)) &&
    skipProbe.logs.some(l => /未执行的原因：1 条依赖断链/.test(l)),
    JSON.stringify(skipProbe.logs.slice(-3)))

  await cdp.eval(`
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'skip-task');
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)

  // ── 11d. 单卡片重跑：重试 / 换人 / 跳过 ──
  //
  // 这条功能存在的唯一理由是**别重复花已经花过的钱**。
  // 界面上要能验到的两件事：① 请求把 taskId 带上了（不然服务端找不到现场）；
  // ② 重跑之后，卡住的下游卡片会自己变成"已完成"，而不是界面还挂着旧的"未执行"。
  console.log('\n── 11d. 单卡片重跑（重试 / 换人 / 跳过）──')

  const retryProbe = await cdp.eval(`
    const A = window.AgentHub;
    const task = { id:'retry-task', title:'单卡片重跑', goal:'g',
      plan:{ goal:'g', subtasks:[
        { id:'r1', memberId:'claude', role:'测试', prompt:'p1' },
        { id:'r2', memberId:'qoder', role:'测试', prompt:'p2', dependsOn:['r1'] },
        { id:'r3', memberId:'qoder', role:'测试', prompt:'p3', dependsOn:['r2'] },
      ] },
      permission:'execute', failurePolicy:'skip-blocked', status:'running',
      cards:{}, cardOrder:['r1','r2','r3'], logs:[], summary:null, markdown:'', startedAt: Date.now() };
    A.state.tasks.unshift(task); A.state.active = { type:'task', id: task.id };
    for (const id of task.cardOrder) {
      task.cards[id] = { id, title:'卡'+id, memberId: id === 'r1' ? 'claude' : 'qoder', role:'测试',
        prompt:'p', status:'run', startedAt: Date.now(), durationMs:0, text:'', cost:{}, quality:null,
        changedFiles:null, degradedUpstream:[], skipKind:'', _tid: task.id };
    }
    A.render();
    const noop = (text) => { task.logs.push({ t:'00:00:00', text }) };
    // r1 成功、r2 挂了、r3 依赖 r2 所以没执行
    A.onTaskEvent(task, { type:'subtask-finish', id:'r1', status:'ok', text:'第一步的产出',
      cost:{}, durationMs:5, quality:{level:'ok',codes:[],note:''}, changedFiles:[], degradedUpstream:[],
      memberName:'Claude', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'subtask-finish', id:'r2', status:'failed', text:'第二步挂了',
      cost:{}, durationMs:5, quality:{level:'ok',codes:[],note:''}, changedFiles:null, degradedUpstream:[],
      memberName:'Qoder', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'subtask-skip', id:'r3', skipKind:'blocked',
      text:'未执行：依赖的 r2 没有可用产出', memberName:'Qoder', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'plan-finish', summary:{ subtaskCount:3, executedCount:2, okCount:1,
      failedCount:1, suspectCount:0, skippedCount:1, skippedByKind:{blocked:1,aborted:0,budget:0,user:0},
      degradedCount:0, costUnknownCount:2, creditsReportedCount:0, totalCredits:0, tokenReportedCount:0,
      durationMs:10, totalCostUsd:0 } }, noop);
    task.status = 'done';
    A.render();

    // 打桩 /api/retry：把"r2 这次成了、r3 跟着跑起来"这条真实的续跑序列推回来
    window.__origFetch2 = window.fetch;
    window.__retryBodies = [];
    window.fetch = async (url, init) => {
      const u = String(url);
      if (!u.includes('/api/retry')) return window.__origFetch2(url, init);
      window.__retryBodies.push(JSON.parse(init.body));
      const enc = new TextEncoder(); const NL = '\\n\\n';
      const sse = (o) => 'data: ' + JSON.stringify(o) + NL;
      const stream = new ReadableStream({ start(c) {
        const ok = { quality:{level:'ok',codes:[],note:''}, changedFiles:[] };
        c.enqueue(enc.encode(sse({ type:'open' })));
        c.enqueue(enc.encode(sse({ type:'resume-ack', id:'r2', action:'retry', memberId:null })));
        c.enqueue(enc.encode(sse({ type:'resume-start', goal:'g', onlyId:'r2',
          previous:{ subtaskCount:3, okCount:1, skippedCount:1 } })));
        c.enqueue(enc.encode(sse({ type:'subtask-start', id:'r2', memberName:'Qoder', role:'测试', degradedUpstream:[] })));
        c.enqueue(enc.encode(sse({ type:'subtask-finish', id:'r2', status:'ok', text:'这次成了',
          cost:{}, durationMs:7, memberName:'Qoder', role:'测试', ...ok })));
        c.enqueue(enc.encode(sse({ type:'subtask-start', id:'r3', memberName:'Qoder', role:'测试', degradedUpstream:[] })));
        c.enqueue(enc.encode(sse({ type:'subtask-finish', id:'r3', status:'ok', text:'下游也跑完了',
          cost:{}, durationMs:7, memberName:'Qoder', role:'测试', ...ok })));
        c.enqueue(enc.encode(sse({ type:'plan-finish', reason:'resume', summary:{ subtaskCount:3,
          executedCount:3, okCount:3, failedCount:0, suspectCount:0, skippedCount:0,
          skippedByKind:{blocked:0,aborted:0,budget:0,user:0}, degradedCount:0, costUnknownCount:0,
          creditsReportedCount:0, totalCredits:0, tokenReportedCount:0, durationMs:30, totalCostUsd:0 } })));
        c.enqueue(enc.encode(sse({ type:'plan-updated', plan:task.plan })));
        c.close();
      } });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    return { cardsBefore: [...document.querySelectorAll('.step')].map(c => c.className) }
  `)

  check('重跑前：r1 已完成、r2 失败、r3 未执行',
    retryProbe.cardsBefore[0].includes('done') &&
    retryProbe.cardsBefore[1].includes('fail') &&
    retryProbe.cardsBefore[2].includes('skip'),
    JSON.stringify(retryProbe.cardsBefore))

  // 点 r2 那一步的「重试」。
  // 两栏结构里重试/换人/跳过只出现在**当前选中那一步**的右栏，所以要先在左栏选中 r2
  // ——用户也是这么点的（先看是哪一步挂了，再决定怎么办）。
  await cdp.eval(`
    const A = window.AgentHub
    A.state.pickedStep = 'r2'
    A.render()
    const btn = document.querySelector('[data-act="retry-card"]')
    if (!btn) throw new Error('选中失败的 r2 之后，右栏没有出现「重试」按钮')
    btn.click()
    return 1
  `)
  await sleep(500)

  const retryAfter = await cdp.eval(`
    const task = window.AgentHub.state.tasks.find(t => t.id === 'retry-task')
    return {
      bodies: window.__retryBodies,
      cardsAfter: [...document.querySelectorAll('.step')].map(c => c.className),
      logs: task.logs.map(l => l.text),
    }
  `)
  check('★ 重试请求带上了 taskId（不然服务端找不到运行现场，只能整单重跑）',
    retryAfter.bodies.length === 1 && retryAfter.bodies[0].taskId === 'retry-task' &&
    retryAfter.bodies[0].id === 'r2' && retryAfter.bodies[0].action === 'retry',
    JSON.stringify(retryAfter.bodies))
  check('★★ 失败的那一步重跑成功 → 卡片变回「已完成」，不再是红的',
    retryAfter.cardsAfter[1].includes('done') && !retryAfter.cardsAfter[1].includes('fail'),
    retryAfter.cardsAfter.join(' / '))
  check('★★ 被卡住的下游自己跑起来了 —— 界面必须跟着更新（不然用户以为还卡着）',
    retryAfter.cardsAfter[2].includes('done') && !retryAfter.cardsAfter[2].includes('skip'),
    retryAfter.cardsAfter.join(' / '))
  check('日志里明说"已经成功的步骤不会重跑"',
    retryAfter.logs.some(l => /已经成功的步骤不会重跑/.test(l)),
    JSON.stringify(retryAfter.logs.slice(-4)))
  check('日志里说清这次是补跑哪一步、此前什么状态',
    retryAfter.logs.some(l => /接着跑：补跑 \[r2\] 及其后续/.test(l)) &&
    retryAfter.logs.some(l => /此前 1\/3 成功 · 1 未执行/.test(l)),
    JSON.stringify(retryAfter.logs.slice(-4)))

  // 换人弹窗：只列实测可用的成员，且排除当前成员
  const swapModal = await cdp.eval(`
    const A = window.AgentHub;
    const t = A.state.tasks.find(x => x.id === 'retry-task')
    A.openSwapModal(t, 'r2')
    const txt = document.getElementById('modalRoot').textContent
    const picks = [...document.querySelectorAll('[data-act="swap-to"]')].map(b => b.dataset.mid)
    const body = { txt, picks }
    A.closeModal()
    return body
  `)
  check('换人弹窗排除当前成员、只给可用的（换成自己就是"重试"，那是另一个按钮）',
    !swapModal.picks.includes('qoder') && swapModal.picks.length > 0,
    JSON.stringify(swapModal.picks))
  check('换人弹窗说明"其它已成功的步骤不会被重跑"',
    /已经成功的其它步骤/.test(swapModal.txt), swapModal.txt.slice(0, 120))

  // 跳过弹窗：必须把"下游会带缺口继续跑"说清楚，否则用户想不到这一层
  const skipModal = await cdp.eval(`
    const A = window.AgentHub;
    const t = A.state.tasks.find(x => x.id === 'retry-task')
    A.openSkipModal(t, 'r2')
    const txt = document.getElementById('modalRoot').textContent
    A.closeModal()
    return txt
  `)
  check('★★ 跳过弹窗点明下游会带着缺口继续跑（并会花新的钱）',
    /确认这一步的产出不要了/.test(skipModal) && /r3/.test(skipModal) && /缺口|缺 r2/.test(skipModal),
    skipModal.slice(0, 200))
  check('跳过弹窗说明报告里会记成「已由用户跳过」',
    /已由用户跳过/.test(skipModal), skipModal.slice(0, 200))

  // 确认跳过：走一遍真实通道，验证 action 传对了、界面状态跟着变
  const skipAfter = await cdp.eval(`
    const A = window.AgentHub;
    const t = A.state.tasks.find(x => x.id === 'retry-task')
    A.openSkipModal(t, 'r2')
    document.querySelector('[data-act="skip-confirm"]').click()
    return 1
  `)
  await sleep(450)
  const skipState = await cdp.eval(`
    const task = window.AgentHub.state.tasks.find(t => t.id === 'retry-task')
    return {
      bodies: window.__retryBodies,
      logs: task.logs.map(l => l.text),
      summary: task.summary,
    }
  `)
  check('★ 确认跳过发出的 action 是 skip，而不是 retry',
    skipState.bodies.some(b => b.action === 'skip' && b.id === 'r2'),
    JSON.stringify(skipState.bodies))

  await cdp.eval(`
    window.fetch = window.__origFetch2; delete window.__origFetch2; delete window.__retryBodies;
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'retry-task');
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)

  // ── 11e. 「结论不完整」的两条警告：任务头与完成日志都不能只报一半 ──
  //
  // 报告层（trace.js 的 toMarkdown）把 `degradedCount` 与 `suspectCount` 当成**成对**警告：
  // 「带缺口」说的是"输入少了一块"，「产出可疑」说的是"进程正常退出但内容不像是有效结果"。
  // 任务头原来只标了前一个 —— 于是 3 条产出全部可疑的任务，在头部看起来是干净完成的
  // （单卡片上的 ⚠️ 得逐张翻才看得到）。完成日志同理。
  console.log('\n── 11e. 任务头与完成日志：带缺口 + 产出可疑 ──')
  const susProbe = await cdp.eval(`
    const A = window.AgentHub;
    const task = { id:'sus-task', title:'可疑产出', goal:'g',
      plan:{ goal:'g', subtasks:[
        { id:'x1', memberId:'claude', role:'测试', prompt:'P1' },
        { id:'x2', memberId:'claude', role:'测试', prompt:'P2' },
      ] },
      permission:'execute', failurePolicy:'skip-blocked', status:'running',
      cards:{}, cardOrder:['x1','x2'], logs:[], summary:null, markdown:'', startedAt: Date.now() };
    A.state.tasks.unshift(task); A.state.active = { type:'task', id: task.id };
    for (const id of task.cardOrder) {
      task.cards[id] = { id, title:'卡'+id, memberId:'claude', role:'测试', prompt:'P'+id,
        status:'run', startedAt: Date.now(), durationMs:0, text:'', cost:{}, quality:null,
        changedFiles:null, degradedUpstream:[], skipKind:'', _tid: task.id };
    }
    A.render();
    const noop = (text) => { task.logs.push({ t: '00:00:00', text }) };
    A.onTaskEvent(task, { type:'subtask-finish', id:'x1', status:'ok', text:'可疑产出',
      cost:{}, durationMs:5, quality:{ level:'suspect', codes:['placeholder'], note:'像是占位符' },
      changedFiles:[], degradedUpstream:[], memberName:'克劳德', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'subtask-finish', id:'x2', status:'ok', text:'带缺口又可疑',
      cost:{}, durationMs:5, quality:{ level:'suspect', codes:['placeholder'], note:'像是占位符' },
      changedFiles:[], degradedUpstream:['k1'], memberName:'克劳德', role:'测试' }, noop);
    A.onTaskEvent(task, { type:'plan-finish', summary:{ subtaskCount:2, executedCount:2, okCount:2,
      failedCount:0, suspectCount:2, skippedCount:0, skippedByKind:{ blocked:0, aborted:0, budget:0, user:0 },
      degradedCount:1, costUnknownCount:0, creditsReportedCount:0, totalCredits:0,
      tokenReportedCount:0, durationMs:10, totalCostUsd:0.5, finishedAt:'2026-09-29T13:00:00.000Z' } }, noop);
    A.render();
    const badges = [...document.querySelectorAll('.task-head .badge')];
    return {
      badges: badges.map(x => x.textContent),
      warnBadges: badges.filter(x => x.classList.contains('warn')).map(x => x.textContent),
      logs: task.logs.map(l => l.text),
    }
  `)
  check('★ 任务头必须标出「产出可疑」—— 报告里它和「带缺口」是成对的，头部不能只报一半',
    susProbe.badges.some(b => b.includes('2 步产出可疑')), JSON.stringify(susProbe.badges))
  check('★ 「带缺口」和「产出可疑」用同一种警告样式（都是琥珀虚线，都不是红）',
    susProbe.warnBadges.length === 2, JSON.stringify(susProbe.warnBadges))
  check('★ 完成日志里也必须说"产出可疑"，否则 2/2 成功看着像个干净收尾',
    susProbe.logs.some(l => /全部结束：2\/2 成功 · 0 失败.*2 个产出可疑/.test(l)),
    JSON.stringify(susProbe.logs.slice(-2)))

  await cdp.eval(`
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'sus-task');
    S.active = { type: 'blank', id: null };
    window.AgentHub.render();
    return 1
  `)

  // ── 11f. 权限档位：这一档在这个成员身上到底生效了吗 ──
  //
  // 起因（2026-09-29 审计 `node tests/perm-audit.mjs`）：实测 trae 的 readonly 与 plan
  // 传下去的参数**一模一样**（都是空 `[]`），dsh 更是四档全空 ——
  // 而界面上原本一律写「只读 —— 能读，不改文件、不跑命令」。
  // 那是界面的承诺，不是成员的事实。**一个不说这件事的界面等于在帮着说谎。**
  //
  // 这组断言盯两件事，**后半句才是关键**：
  //   ① 该警告时必须警告；
  //   ② 不该警告时**一句都不许多说** —— 一个永远显示警告的提示会被立刻当成噪音忽略掉，
  //      那正是不如不提示的情况。所以每条都配了正向对照。
  console.log('\n── 11f. 权限档位：档位是否真的生效 ──')
  const permProbe = await cdp.eval(`
    const A = window.AgentHub;
    const out = {};
    const caveat = () => document.getElementById('planPermCaveat')?.textContent ?? '';

    // ① 协同弹窗：计划里只有 trae，档位选「只读」
    A.planDraft = { goal:'g', subtasks:[{ id:'p1', memberId:'trae', role:'测试', prompt:'x' }] };
    A.state.permission = 'readonly';
    A.renderPlanTable('g');
    out.traeReadonly = caveat();

    // 切到 trae 真能吃下的执行档（--must-patch）→ 提示必须立刻消失，
    // 不许停留在上一个档位的结论上
    const sel = document.getElementById('taskPerm');
    sel.value = 'execute';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    out.traeExecute = caveat();

    // ② 正向对照：换成 claude（四档齐全）→ 任何档位都不该有提示
    A.planDraft = { goal:'g', subtasks:[{ id:'p1', memberId:'claude', role:'测试', prompt:'x' }] };
    A.state.permission = 'readonly';
    A.renderPlanTable('g');
    out.claudePlan = caveat();

    // ③ 单成员对话的 composer-hint
    //
    // ⚠️ 必须先把 active 切到这条会话 —— 11e 收尾时把视图设成了空白页，
    // 直接 render() 出来的是空状态，一个 .composer-hint 都不会有（那就是本轮第一次跑红的原因）。
    const chat = A.state.chats[0];
    if (chat) {
      const savedIds = chat.memberIds.slice();
      const hint = () => [...document.querySelectorAll('.composer-hint')].map(x => x.textContent).join(' | ');

      A.state.active = { type: 'chat', id: chat.id };
      chat.memberIds = ['trae'];
      A.state.permission = 'readonly';
      A.render();
      out.traeChat = hint();

      chat.memberIds = ['claude'];
      A.render();
      out.claudeChat = hint();
      out.claudeChatHasCaveat = !!document.querySelector('.composer-hint .hint-caveat');

      chat.memberIds = savedIds;
    } else {
      out.traeChat = '(没有会话可取 —— 这条断言失去了前提)';
    }

    A.closeModal();
    A.state.permission = 'plan';
    A.render();
    return out;
  `)
  check('★★ 协同弹窗：计划里有 trae + 选只读档 → 必须提示「这一档对它不生效」',
    /没有「只读」档对应的参数/.test(permProbe.traeReadonly),
    JSON.stringify(permProbe.traeReadonly))
  check('★ 切到 trae 真吃得下的执行档 → 提示立刻消失（不许停留在上一个档位的结论上）',
    permProbe.traeExecute === '', JSON.stringify(permProbe.traeExecute))
  check('★ 正向对照：claude 四档齐全 → 弹窗里一句都不许多说',
    permProbe.claudePlan === '', JSON.stringify(permProbe.claudePlan))
  check('★★ 单成员对话：trae + 只读档 → composer-hint 里也要警告',
    /不受这一档约束/.test(permProbe.traeChat), JSON.stringify(permProbe.traeChat))
  check('★ 正向对照：claude + 只读档 → composer-hint 不许出现警告元素',
    !permProbe.claudeChatHasCaveat, JSON.stringify(permProbe.claudeChat))

  // ── 11g. 主脑可选，但**默认落在成员上** ──
  //
  // 主脑（WorkBuddy）没有 CLI —— **引擎调不动它**。所以「选主脑」的语义不是"引擎去问它"，
  // 而是"引擎不拆，把目标交给它（走 MCP 反向通道）"。两条路必须分得清：
  //   · 主脑 → 落盘一份待拆解请求 + 给一句能交给 WorkBuddy 的话；
  //   · 成员 → 引擎用它代拆，立刻出计划表，在本软件里跑完。
  // 2026-10-02 起**默认必须落在实测可用的成员上**：主脑那条路要用户切到 WorkBuddy 里粘一句话，
  // 不满足"就在这个软件里干活"。主脑仍在候选里（给想走反向通道的人留门），只是不再当默认。
  console.log('\n── 11g. 主脑可选（默认落在成员上）──')
  const orchProbe = await cdp.eval(`
    const A = window.AgentHub;
    const out = {};
    A.closeModal();
    A.state._planner = null;            // 清掉历史选择，测的是"首次打开时的默认值"

    document.getElementById('newTaskBtn').click();
    const sel = document.getElementById('plannerSel');
    out.orch = A.state.orchestrator ? A.state.orchestrator.id : null;
    out.options = [...sel.options].map(o => ({ v: o.value, t: o.textContent }));
    out.availIds = A.state.members.filter(m => m.available).map(m => m.id);
    out.orchInOptions = [...sel.options].some(o => o.value === out.orch);
    out.defaultValue = sel.value;
    out.defaultIsMember = sel.value !== out.orch;

    // 切到主脑：按钮文案与说明都必须跟着换（「交给主脑」≠「拆解」）
    sel.value = out.orch;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    out.btnTextWhenOrch = document.getElementById('planBtn').textContent.trim();
    out.hintWhenOrch = document.getElementById('plannerHint').textContent;

    // 再切到一个普通成员：文案必须跟着换回来
    const memberOpt = [...sel.options].find(o => o.value !== out.orch);
    sel.value = memberOpt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    out.memberId = memberOpt.value;
    out.btnTextWhenMember = document.getElementById('planBtn').textContent.trim();
    out.hintWhenMember = document.getElementById('plannerHint').textContent;

    // 切回主脑，填目标，真的点一次「交给主脑」
    sel.value = A.state.orchestrator.id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('goalBox').value = '主脑拆分路径冒烟：把目标交给 WorkBuddy';
    document.getElementById('planBtn').click();
    return out;
  `)
  check('★ 主脑仍在候选里（想走反向通道的人有门）',
    orchProbe.orch === 'workbuddy' && orchProbe.orchInOptions,
    `orchestrator=${orchProbe.orch} 在候选里=${orchProbe.orchInOptions} 候选=${JSON.stringify(orchProbe.options)}`)
  check('★★ 默认不选主脑 —— 落在实测可用的成员上（那条路才在本软件里拆解 + 跑完）',
    orchProbe.defaultIsMember && orchProbe.defaultValue !== '' && orchProbe.availIds.includes(orchProbe.defaultValue),
    `默认=${orchProbe.defaultValue}（可用成员 ${JSON.stringify(orchProbe.availIds)}）`)
  check('★ 选主脑时按钮是「交给主脑」，选成员时是「拆解」—— 两条路不许长一个样',
    orchProbe.btnTextWhenOrch === '交给主脑' && orchProbe.btnTextWhenMember === '拆解',
    `主脑=${orchProbe.btnTextWhenOrch} 成员=${orchProbe.btnTextWhenMember}`)
  check('★ 说明文字也要跟着换：主脑那条必须点破"引擎调不动它"',
    /没有命令行/.test(orchProbe.hintWhenOrch) && !/没有命令行/.test(orchProbe.hintWhenMember),
    `主脑=${String(orchProbe.hintWhenOrch).slice(0, 40)}… 成员=${String(orchProbe.hintWhenMember).slice(0, 40)}…`)

  // 点完「交给主脑」是异步的（要落盘），等它出结果
  const handoff = await cdp.eval(`
    const el = await (async () => {
      for (let i = 0; i < 60; i++) {
        const t = document.querySelector('#modalRoot h3');
        if (t && t.textContent.includes('已交给主脑')) {
          const line = document.getElementById('handoffLine');
          return { title: t.textContent, line: line ? line.textContent : '',
                   path: (document.querySelector('.path-line') || {}).textContent || '',
                   hasCopyBtn: !!document.querySelector('[data-act="copy-handoff"]') };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    })();
    return el;
  `)
  check('★★ 点「交给主脑」→ 真的落盘并给出可交给 WorkBuddy 的那句话',
    !!handoff && /\.agenthub[\\/]inbox[\\/]plan-\d+\.json/.test(handoff.path) &&
      /处理 \.agenthub\/inbox\/plan-\d+\.json 里待拆解的任务/.test(handoff.line) && handoff.hasCopyBtn,
    JSON.stringify(handoff))

  /*
   * 界面里显示了一个路径 ≠ 文件真的写出来了。
   * 「我已经把活交给主脑」这句话的全部分量就在这个文件上，所以去磁盘上核对一次。
   */
  check('★★ 那份待拆解请求在磁盘上真的存在（"我交过了"要有证据，不是弹个提示）',
    !!handoff?.path && existsSync(handoff.path),
    handoff?.path || '（弹窗里没给出路径）')

  await cdp.eval(`window.AgentHub.closeModal(); window.AgentHub.state._planner = null; window.AgentHub.render(); return 1`)

  // 清掉这次冒烟造出来的那份假请求 —— 它是个测试目标，不该留在用户的收件箱里
  if (handoff?.path && existsSync(handoff.path)) { try { rmSync(handoff.path) } catch {} }

  console.log('\n── 11h. 删除会话（不可恢复，所以要先说清楚）──')

  /*
   * 造两条自己的会话来测：一条单删、一条留着验证"没误删别人"。
   * 不借前面几节造的会话 —— 那些的数量随别的测试变动，断言会莫名其妙地脆。
   */
  await cdp.eval(`
    const S = window.AgentHub.state;
    S.chats.unshift({ id: 'del-a', title: '删除测试 A', memberIds: ['claude'], threads: { claude: [{ role: 'user', text: 'hi' }] }, busy: {}, lastStatus: {} });
    S.chats.unshift({ id: 'del-b', title: '删除测试 B', memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} });
    window.AgentHub.render();
    return 1
  `)
  await sleep(150)

  check('每条会话行都有删除按钮', await cdp.eval(`
    const rows = [...document.querySelectorAll('#chatList .item')];
    return rows.length >= 2 && rows.every(r => !!r.querySelector('.item-del'))
  `))

  const opacityOf = `(b) => b ? getComputedStyle(b).opacity : 'none'`
  const idleOpacity = await cdp.eval(`
    const b = document.querySelector('#chatList .item:not(.active) .item-del');
    return (${opacityOf})(b)
  `)
  check('平时不显形（一屏小 × 太吵）', idleOpacity === '0', `opacity=${idleOpacity}`)

  /*
   * ★ 真鼠标移上去——不是"改个 class 看看"。
   * CDP 的 Input.dispatchMouseEvent 会让浏览器真的算出 :hover，
   * 所以这条断言验的是 CSS 里那条 `.item:hover .item-del` 规则真的生效。
   *
   * ⚠️ 先把左栏**展开**：前面的广播小节会把左栏收成图标条（`.sidebar-full` 不显示），
   * 那时 `getBoundingClientRect()` 全是 0，鼠标等于移到了左上角 ——
   * 断言会以"移了但没显形"的形式**假红**（第一次跑就是这么红的）。
   */
  await cdp.eval(`
    if (window.AgentHub.state.sidebarMini) { window.AgentHub.state.sidebarMini = false; window.AgentHub.render() }
    return 1
  `)
  await sleep(200)
  const delRow = await cdp.eval(`
    const row = document.querySelector('#chatList .item:not(.active)');
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: row.dataset.id, w: Math.round(r.width), h: Math.round(r.height) }
  `)
  check('左栏已展开、这一行有真实尺寸（否则下面的悬停等于没测）',
    delRow.w > 0 && delRow.h > 0, `${delRow.w}×${delRow.h}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: delRow.x, y: delRow.y, buttons: 0 })
  await sleep(220)
  const hoverState = await cdp.eval(`
    const row = document.querySelector('#chatList .item[data-id="${delRow.id}"]');
    const b = row.querySelector('.item-del');
    return { opacity: getComputedStyle(b).opacity, hovered: row.matches(':hover') }
  `)
  check('浏览器真的把鼠标算在了这一行上', hoverState.hovered === true)
  check('鼠标移到这一行，删除按钮才显形', hoverState.opacity === '1', `opacity=${hoverState.opacity}`)

  // 当前项也要能显形：它的 × 平时留 55% 淡显，悬停时必须跟别的一样亮
  const activeRow = await cdp.eval(`
    const S = window.AgentHub.state;
    S.active = { type: 'chat', id: 'del-a' };
    S.sidebarMini = false;
    window.AgentHub.render();
    const row = document.querySelector('#chatList .item[data-id="del-a"]');
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width - 14), y: Math.round(r.top + r.height / 2) }
  `)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: activeRow.x, y: activeRow.y, buttons: 0 })
  await sleep(220)
  check('悬停「当前打开的那一条」时 × 也要全亮（不然最该点的一行最不清楚）', await cdp.eval(`
    const b = document.querySelector('#chatList .item[data-id="del-a"] .item-del');
    return getComputedStyle(b).opacity === '1'
  `))

  const activeBeforeDel = await cdp.eval(`return window.AgentHub.state.active.id`)
  await cdp.eval(`document.querySelector('#chatList .item[data-id="del-a"] .item-del').click(); return 1`)
  await sleep(150)
  check('点 × 打开的是删除确认框（不是把会话打开）', await cdp.eval(`
    const open = document.getElementById('modalRoot').classList.contains('open');
    const h = document.querySelector('#modalRoot h3')?.textContent || '';
    return open && h.includes('删除会话')
  `))
  check('× 没有穿透到整行（当前打开的会话没被换掉）',
    (await cdp.eval(`return window.AgentHub.state.active.id`)) === activeBeforeDel, `active=${activeBeforeDel}`)
  check('确认框里写清了"不可恢复"和"文件不动"', await cdp.eval(`
    const t = document.querySelector('#modalRoot .modal')?.textContent || '';
    return t.includes('不可恢复') && t.includes('文件不会被删')
  `))

  await cdp.eval(`document.querySelector('#modalRoot [data-act="close-modal"]').click(); return 1`)
  await sleep(150)
  check('取消 = 什么都没删', await cdp.eval(`return window.AgentHub.state.chats.some(c => c.id === 'del-a')`))

  // 顺手给它留一份草稿和广播开关：删除时这些瞬态必须一起清掉
  await cdp.eval(`
    const S = window.AgentHub.state;
    S.drafts['del-a:claude'] = '这是一段草稿';
    S.broadcast['del-a'] = true;
    document.querySelector('#chatList .item[data-id="del-a"] .item-del').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#modalRoot [data-act="del-confirm"]').click();
    return 1
  `)
  await sleep(250)
  check('确认后这条会话没了', await cdp.eval(`return !window.AgentHub.state.chats.some(c => c.id === 'del-a')`))
  check('左栏 DOM 同步少了一行', await cdp.eval(`return !document.querySelector('#chatList .item[data-id="del-a"]')`))
  check('它的草稿/广播开关一起清了（不留垃圾键）', await cdp.eval(`
    const S = window.AgentHub.state;
    return !Object.keys(S.drafts).some(k => k.startsWith('del-a:')) && !('del-a' in S.broadcast)
  `))
  check('**落盘了**（刷新页面不会把它带回来）', await cdp.eval(`
    const raw = JSON.parse(localStorage.getItem('agenthub.ui.v1') || '{}');
    return !(raw.chats || []).some(c => c.id === 'del-a')
  `))
  check('别的那条没被误删', await cdp.eval(`return window.AgentHub.state.chats.some(c => c.id === 'del-b')`))

  // 删掉的正好是当前打开的那条 → 必须回到选择页，不能留在白屏上
  await cdp.eval(`
    window.AgentHub.state.active = { type: 'chat', id: 'del-b' };
    window.AgentHub.render();
    document.querySelector('#chatList .item[data-id="del-b"] .item-del').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#modalRoot [data-act="del-confirm"]').click();
    return 1
  `)
  await sleep(250)
  check('删的是当前打开的那条 → 退回选择页（不留白屏）', await cdp.eval(`
    return window.AgentHub.state.active.type === 'blank' && !!document.querySelector('.home')
  `))

  /*
   * ── 11h2. 「下次直接删除，不再提示」（用户原话：「这里加一个下次直接删除不提示」）──
   *
   * 一条**偏好**，坑都在两头，所以两头都要钉：
   *   ① 关上之后必须真的不再问 —— 否则用户白勾一次；
   *   ② 关上之后必须**有路回去** —— 否则「不再提示」就是一张单程票，
   *      而这一整个删除弹窗的立场恰恰是"不可恢复的事必须先说清楚"。
   *
   * ②是这一节真正在防的东西。它唯一的恢复入口挂在"删除成功"那条 toast 上，
   * 而 toast 默认 4.2 秒自毁 —— 一个刚看清就消失的按钮等于没有按钮
   * （所以实现里带按钮的 toast 延长到 9s，这条也一并验了）。
   */
  console.log('\n── 11h2. 删除不再确认（以及：它必须能改回来）──')

  // 偏好是**独立**的 localStorage 键，别的用例可能动过它 —— 从干净状态开始
  await cdp.eval(`localStorage.removeItem('agenthub.delconfirm.v1'); window.AgentHub.render(); return 1`)
  await sleep(120)

  await cdp.eval(`
    const S = window.AgentHub.state;
    for (const id of ['na-1', 'na-2']) {
      S.chats.unshift({ id, title: '不再提示测试 ' + id, memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} });
    }
    window.AgentHub.render();
    return 1
  `)
  await sleep(150)

  await cdp.eval(`document.querySelector('#chatList .item[data-id="na-1"] .item-del').click(); return 1`)
  await sleep(150)
  check('删除弹窗里有「下次直接删除，不再提示」', await cdp.eval(`
    const t = document.querySelector('#modalRoot .modal')?.textContent || '';
    return !!document.querySelector('#modalRoot #delNoAsk') && t.includes('下次直接删除')
  `))
  check('默认**不勾**（默认落在安全的那一侧：先确认）',
    await cdp.eval(`return document.querySelector('#delNoAsk').checked === false`))

  await cdp.eval(`
    document.querySelector('#delNoAsk').checked = true;
    document.querySelector('#modalRoot [data-act="del-confirm"]').click();
    return 1
  `)
  await sleep(250)
  check('勾选后这一次仍然按确认流程删掉了（不会半路改成直删）',
    await cdp.eval(`return !window.AgentHub.state.chats.some(c => c.id === 'na-1')`))
  check('偏好写进了 localStorage', await cdp.eval(`return localStorage.getItem('agenthub.delconfirm.v1') === 'off'`))

  // ── 回头路 ──
  check('★ toast 上给了「恢复确认」的入口', await cdp.eval(`
    return !!document.querySelector('#toastRoot .toast-act[data-act="ask-on"]')
  `))
  check('左栏底部出现了把确认改回来的开关（偏好不是暗处的一个 bit）', await cdp.eval(`
    const b = document.getElementById('askSwitch');
    // ★ 查**屏幕上是否真的看得见**，不是 hidden 属性。
    //   属性对、实际被 display:flex 顶掉，是真实发生过的一种错法：
    //   那个开关"永远显示着"，而删除确认其实开着 —— 界面在替用户声明一个不成立的状态。
    //   只查属性的话，这条会绿着把一个可见的 bug 放过去。
    return !!b && b.getBoundingClientRect().height > 0
  `))

  // ── ① 关了之后真的不再问 ──
  await cdp.eval(`document.querySelector('#chatList .item[data-id="na-2"] .item-del').click(); return 1`)
  await sleep(200)
  check('★ 再点 × 不再弹确认框，直接就删了', await cdp.eval(`
    const open = document.getElementById('modalRoot').classList.contains('open');
    const gone = !window.AgentHub.state.chats.some(c => c.id === 'na-2');
    return !open && gone
  `))

  // ── ② 关掉之后必须能改回来 ──
  await cdp.eval(`document.querySelector('#toastRoot .toast-act[data-act="ask-on"]').click(); return 1`)
  await sleep(220)
  check('点了「恢复确认」→ 偏好回到默认（键被删掉，不是留个 false）',
    await cdp.eval(`return localStorage.getItem('agenthub.delconfirm.v1') === null`))
  check('左栏那个开关自己收回去了（不留一个已经失效的入口）', await cdp.eval(`
    const b = document.getElementById('askSwitch');
    return !!b && b.getBoundingClientRect().height === 0   // 同上：认屏幕，不认属性
  `))
  check('那条 toast 也自己撤掉了（免得看着像"还能再点一次"）',
    await cdp.eval(`return !document.querySelector('#toastRoot .toast-act[data-act="ask-on"]')`))

  await cdp.eval(`
    const S = window.AgentHub.state;
    S.chats.unshift({ id: 'na-3', title: '恢复之后', memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} });
    window.AgentHub.render();
    document.querySelector('#chatList .item[data-id="na-3"] .item-del').click();
    return 1
  `)
  await sleep(200)
  check('★ 恢复之后点 × 又重新弹确认框了（"恢复"改的是行为，不只是个标记）', await cdp.eval(`
    return document.getElementById('modalRoot').classList.contains('open')
      && !!document.querySelector('#modalRoot [data-act="del-confirm"]')
  `))
  await cdp.eval(`
    document.querySelector('#modalRoot [data-act="del-confirm"]').click();
    await new Promise(r => setTimeout(r, 150));
    return 1
  `)
  await sleep(250)

  /*
   * 把偏好**故意置成 off** 留给下一节。
   * 11i 要在"已经关掉确认"的前提下点「清空」，那条断言才能顺带证明
   * 「整组清空不吃这条偏好」—— 一次干掉几十条和删掉一条不是同一个量级，
   * 不共用一份授权（用户勾的时候想的是"别老问我要不要删这一条"）。
   */
  await cdp.eval(`localStorage.setItem('agenthub.delconfirm.v1', 'off'); return 1`)
  check('（为下一节布下的前置）偏好已置为"不再确认"',
    await cdp.eval(`return localStorage.getItem('agenthub.delconfirm.v1') === 'off'`))

  console.log('\n── 11i. 清空：一次删掉一整组 ──')

  check('前置确认：此刻"单条删除不再确认"是开着的', await cdp.eval(`
    return localStorage.getItem('agenthub.delconfirm.v1') === 'off'
  `))

  await cdp.eval(`
    const S = window.AgentHub.state;
    for (let i = 0; i < 3; i++) S.chats.push({ id: 'cl' + i, title: '清空测试 ' + i, memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} });
    window.AgentHub.render(); return 1
  `)
  await sleep(150)
  check('有会话时，分组标题上出现「清空」', await cdp.eval(`return !!document.querySelector('#chatGroupTitle .group-clear')`))

  /*
   * ★ 先把鼠标挪开再验透明度。
   * 11h 那几节用真鼠标跑过 `:hover`，鼠标就**留在左栏上**没动过；
   * 而 `.group:hover .group-clear { opacity: 1 }` —— 于是"平时也看得见"这条会偶发地红
   * （实测出现过一次：同一条断言在两次完整跑里一红一绿，那就是 flaky，不是回归）。
   * 断言验的是"没有悬停时的默认可见度"，那就必须真的没有悬停。
   */
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 620, buttons: 0 })
  await sleep(200)
  check('「清空」平时就看得见（不跟行内 × 一样藏到悬停后面）', await cdp.eval(`
    const b = document.querySelector('#chatGroupTitle .group-clear');
    const o = b ? Number(getComputedStyle(b).opacity) : 0;
    return o > 0.2 && o < 1
  `))
  await cdp.eval(`document.querySelector('#chatGroupTitle .group-clear').click(); return 1`)
  await sleep(150)
  check('清空同样要先确认，且写明总数', await cdp.eval(`
    const open = document.getElementById('modalRoot').classList.contains('open');
    const t = document.querySelector('#modalRoot .modal')?.textContent || '';
    return open && t.includes('清空') && /全部删除/.test(t)
  `))
  await cdp.eval(`document.querySelector('#modalRoot [data-act="clear-confirm"]').click(); return 1`)
  await sleep(250)
  check('确认后会话全清', await cdp.eval(`return window.AgentHub.state.chats.length === 0`))
  check('空列表给出提示语', await cdp.eval(`return !!document.querySelector('#chatList .empty-hint')`))
  check('没东西可清时「清空」不再出现', await cdp.eval(`return !document.querySelector('#chatGroupTitle .group-clear')`))

  /*
   * ★ 先把「删除前先确认」改回默认，再验任务行的删除。
   *   上面为了验 11i 的「整组清空不吃这条偏好」，把它故意置成了 off；
   *   沿用 off 的话点 × 会**直接删掉、根本不弹框**，下面那句点 del-confirm 就会落空
   *   （原来就是踩在这儿：报的是"读 null 的 click"，看着像行没渲染，其实是没弹框）。
   *   这一小节要验的是任务行也能走确认弹窗那条路，所以状态得先摆正。
   */
  await cdp.eval(`
    localStorage.removeItem('agenthub.delconfirm.v1');
    window.AgentHub.render(); return 1
  `)

  await cdp.eval(`
    window.AgentHub.state.tasks.unshift({
      id: 'del-t', goal: '删除测试任务',
      plan: { subtasks: [{ id: 's1', title: 'x', memberId: 'claude', dependsOn: [] }] },
      status: 'done', cards: { s1: { status: 'ok', memberId: 'claude' } }, cardOrder: ['s1'],
      logs: [], batches: [], startedAt: Date.now(),
    });
    window.AgentHub.render(); return 1
  `)
  await sleep(150)
  check('协同任务行也有删除按钮', await cdp.eval(`return !!document.querySelector('#taskList .item[data-id="del-t"] .item-del')`))
  await cdp.eval(`
    document.querySelector('#taskList .item[data-id="del-t"] .item-del').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('#modalRoot [data-act="del-confirm"]').click();
    return 1
  `)
  await sleep(250)
  check('协同任务也能删掉', await cdp.eval(`
    return !window.AgentHub.state.tasks.some(t => t.id === 'del-t')
      && !document.querySelector('#taskList .item[data-id="del-t"]')
  `))

  // ── 11j. 改版后的新结构：每一条都必须能失败 ──
  //
  // 2026-09-30 版式重做（用户：「页面还是太素，布局也不够好」）。
  // 这一节盯的全是**改版新加的东西**，而它们有一个共同点：
  // 坏了不会报错、页面上也照样有东西 —— 只是变成没人看得懂或干脆是个摆设。
  //   · 面包屑：三条分支必须和 renderMain 对得上，写错就是"顶着会话名显示选择页"；
  //   · 起点卡的示例 chip：**最容易写错的方向是"顺手自动发送"**，
  //     那是在用户还没看清第一个字的时候替他花一次真钱 —— 所以专门打桩抓它；
  //   · 「接着上次」：必须是真入口，不是装饰；
  //   · 任务头的数字与进度条：数字要真算、进度条要真能显示（`<span>` 的 inline 陷阱）。
  console.log('\n── 11j. 改版后的新结构 ──')

  await cdp.eval(`
    const S = window.AgentHub.state;
    S.sidebarMini = false;                 // 上一节可能把左栏收成图标条了，底部这条测的是展开态
    S.active = { type: 'blank', id: null };
    window.AgentHub.render(); return 1
  `)
  await sleep(200)
  check('★ 面包屑在选择页时说「选择页」',
    (await cdp.eval(`return document.getElementById('crumb').textContent.trim()`)) === '选择页',
    await cdp.eval(`return document.getElementById('crumb').textContent`))

  // 进一个会话 —— 面包屑必须跟着换（顶栏原来只有一个永远不变的工作目录名）
  await cdp.eval(`document.querySelector('.member-card:not(.orch-card)').click(); return 1`)
  await sleep(350)
  const crumbChat = await cdp.eval(`return document.getElementById('crumb').textContent.replace(/\\s+/g, ' ').trim()`)
  // 分隔符靠 CSS 的 gap 拉开，textContent 里因此没有空格 —— 正则要容忍这一点
  check('★★ 进会话后面包屑变成「会话 › 成员名」',
    /^会话\s*›\s*\S+/.test(crumbChat), JSON.stringify(crumbChat))

  // 左栏条目：两行，且第二行是真数据
  const side1 = await cdp.eval(`
    const el = document.querySelector('#chatList .item');
    if (!el) return null;
    return {
      name: (el.querySelector('.item-title .name') || {}).textContent || '',
      sub: (el.querySelector('.item-sub') || {}).textContent || '',
      delInsideTitle: !!el.querySelector('.item-title .item-del'),
    }
  `)
  check('左栏条目是两行（标题行 + 副信息行）', !!side1 && side1.sub.length > 0, JSON.stringify(side1))
  check('★ 副信息行是真数据（成员名 + 对话条数），不是占位文字',
    !!side1 && side1.sub.includes('Claude') && side1.sub.includes('条'), JSON.stringify(side1 && side1.sub))
  check('★ 行内 × 长在标题行里 —— 点它和点整行仍然分得开（靠结构，不靠 stopPropagation）',
    !!side1 && side1.delInsideTitle === true)

  // 起点卡：示例 chip 只许填草稿
  const chipBefore = await cdp.eval(`
    const A = window.AgentHub;
    const chat = A.state.chats.find(c => c.id === A.state.active.id);
    const mid = chat.memberIds[0];
    return { chips: document.querySelectorAll('.start-card .chip').length,
             msgs: (chat.threads[mid] || []).length,
             hasTitle: !!document.querySelector('.start-card .start-title') }
  `)
  check('空会话给的是「起点卡」（标题 + 示例），不再是一行小字',
    chipBefore.hasTitle && chipBefore.chips >= 3, JSON.stringify(chipBefore))

  // 打桩：只要有人真的发指令就会留下痕迹 —— 这正是"不许自动花钱"要抓的
  await cdp.eval(`
    window.__chatHits = 0;
    window.__origFetchChip = window.fetch;
    window.fetch = (u, i) => {
      if (String(u).includes('/api/chat')) window.__chatHits++;
      return window.__origFetchChip(u, i);
    };
    return 1
  `)
  await cdp.eval(`document.querySelector('.start-card .chip').click(); return 1`)
  await sleep(450)
  const afterChip = await cdp.eval(`
    const A = window.AgentHub;
    const chat = A.state.chats.find(c => c.id === A.state.active.id);
    const mid = chat.memberIds[0];
    return {
      draft: A.state.drafts[chat.id + ':' + mid] || '',
      taValue: (document.querySelector('textarea.ta') || {}).value || '',
      hits: window.__chatHits,
      msgs: (chat.threads[mid] || []).length,
    }
  `)
  check('★★ 点示例 = 把文字填进输入框（用户还得能改）',
    afterChip.draft.length > 0 && afterChip.taValue === afterChip.draft, JSON.stringify(afterChip))
  check('★★ 点示例**不会**直接发出去 —— 自动发送是在用户没看清时替他花钱',
    afterChip.hits === 0 && afterChip.msgs === chipBefore.msgs, JSON.stringify(afterChip))
  await cdp.eval(`window.fetch = window.__origFetchChip; return 1`)

  // 首页「接着上次」：必须是真入口
  await cdp.eval(`document.getElementById('homeBtn').click(); return 1`)
  await sleep(300)
  const recent1 = await cdp.eval(`
    const it = document.querySelector('.recent-item');
    return it ? { id: it.dataset.id, act: it.dataset.act,
                  name: (it.querySelector('.recent-name') || {}).textContent || '' } : null
  `)
  check('首页底部列出「接着上次」（有会话时才出现）',
    !!recent1 && recent1.act === 'open-chat', JSON.stringify(recent1))
  await cdp.eval(`document.querySelector('.recent-item').click(); return 1`)
  await sleep(300)
  check('★★ 点「接着上次」真的进得去那一条（不是装饰）',
    (await cdp.eval(`return window.AgentHub.state.active.id`)) === recent1?.id &&
    (await cdp.eval(`return !!document.querySelector('.chat-single')`)),
    `active=${await cdp.eval(`return window.AgentHub.state.active.id`)}`)

  // 侧栏底部「回到选择页」：位置也要对（它是"离开"动作，压在最下面）
  const footPos = await cdp.eval(`
    const b = document.getElementById('homeBtn');
    if (!b) return null;
    const bar = b.closest('.side-foot');
    if (!bar) return { inFoot: false };
    const r = bar.getBoundingClientRect();
    return { inFoot: true, bottomGap: Math.round(innerHeight - r.bottom) };
  `)
  check('★「回到选择页」在侧栏底部（离开动作不跟「新建」抢同一块注意力）',
    !!footPos && footPos.inFoot && footPos.bottomGap < 40, JSON.stringify(footPos))
  await cdp.eval(`document.getElementById('homeBtn').click(); return 1`)
  await sleep(250)
  check('点它回到选择页', await cdp.eval(`
    return window.AgentHub.state.active.type === 'blank' && !!document.querySelector('.home')
  `))

  // 任务头：数字要真算，进度条要真能显示
  await cdp.eval(`
    window.AgentHub.state.tasks.unshift({
      id: 'stat-t', title: '统计冒烟', goal: '统计冒烟',
      plan: { goal: 'g', subtasks: ['s1','s2','s3','s4'].map(id => ({ id, title: id, memberId: 'claude', role: '测试', prompt: 'p', dependsOn: [] })) },
      permission: 'plan', failurePolicy: 'skip-blocked', status: 'running',
      cardOrder: ['s1','s2','s3','s4'],
      // 这几张卡**故意不写 memberId**：状态是从 localStorage 读回来的，
      // 里面可能有旧版本写下的残缺卡片。渲染路径必须容得下（画个占位徽标），
      // 不能因为一个字段缺失就把整块 innerHTML 抛掉变成白屏。
      cards: {
        s1: { id:'s1', status:'done', cost:{ usd: 0.25 } },
        s2: { id:'s2', status:'fail', cost:{ usd: 0.25 } },
        s3: { id:'s3', status:'skip', cost:{} },
        s4: { id:'s4', status:'run',  cost:{} },
      },
      logs: [], summary: null, startedAt: Date.now(),
    });
    window.AgentHub.state.active = { type: 'task', id: 'stat-t' };
    window.AgentHub.render(); return 1
  `)
  await sleep(300)
  const stats1 = await cdp.eval(`
    const nums = [...document.querySelectorAll('.task-head .stat')].map(s => ({
      n: (s.querySelector('.stat-n') || {}).textContent || '',
      l: (s.querySelector('.stat-l') || {}).textContent || '' }));
    const fill = document.querySelector('.task-head .prog-fill');
    return {
      nums,
      fillW: fill ? fill.getBoundingClientRect().width : -1,
      trackW: fill ? fill.parentElement.getBoundingClientRect().width : -1,
      crumb: document.getElementById('crumb').textContent.replace(/\\s+/g, ' ').trim(),
    }
  `)
  check('★ 任务头给出「已完成 N/M」与花费（原来只有一排徽章，得去数卡片）',
    stats1.nums.some((x) => x.n === '1/4' && x.l === '已完成') &&
    stats1.nums.some((x) => x.n === '$0.5000'),
    JSON.stringify(stats1.nums))
  check('★ 进度条按「已处理」算（成功+失败+未执行 = 3/4），不是按成功算 —— 否则全失败的任务永远停在 0%',
    stats1.trackW > 0 && Math.abs(stats1.fillW / stats1.trackW - 0.75) < 0.02,
    `fill=${Math.round(stats1.fillW)} / track=${Math.round(stats1.trackW)}`)
  check('★ 面包屑在协同任务里说「协同 › 任务名」',
    /^协同\s*›\s*\S+/.test(stats1.crumb), JSON.stringify(stats1.crumb))

  await cdp.eval(`
    const S = window.AgentHub.state;
    S.tasks = S.tasks.filter(t => t.id !== 'stat-t');
    S.chats = [];
    S.active = { type: 'blank', id: null };
    window.AgentHub.render(); return 1
  `)
  await sleep(200)

  // ════════════════════════════════════════════════════════════════════════
  // 11k. ★★ 老存档：一个"回来接着用"的人，界面进得去吗
  //
  // 这一节是**补上的一个盲区**，而且盲区很致命：
  //
  // 上面 200 多条断言全都跑在**全新 profile** 上 —— localStorage 是空的，
  // 于是每一条渲染路径拿到的都是当前代码自己写出来的、形状完全正确的数据。
  // 可真实用户不是这样：他的 localStorage 里躺着**上一个版本的代码**写下的存档。
  // 老版本没有某个字段时，`JSON.stringify` 会干脆不写那个键，读回来是 `undefined`，
  // 而且**不报错** —— 直到某一行直接下标访问它。
  //
  // 2026-09-30 实测到的现场（用户报「打不开」）：一份没有 `cards` 的老任务，
  // `renderTaskView` 里 `task.cards[picked]` 抛 TypeError → render() 中途断掉 →
  // `#main` 是空的。更坏的是 `state.active` **也被存着**，所以每次打开都崩在同一个地方：
  // 用户被彻底锁在门外，连"进界面把那条删掉"都做不到。
  //
  // 两件事一起验：① 老存档能被规范化后正常渲染；② 万一还是崩了，必须给一块
  // **看得见的错误面板 + 自救按钮**，而不是一片白。
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── 11k. 老存档：回来接着用的人进得去界面吗 ──')
  const legacyState = await cdp.eval(`
    // 上一版代码可能没写过这些键：cards / cardOrder / logs，以及会话的 threads
    const legacy = {
      permission: 'execute', failurePolicy: 'skip-blocked',
      homeTab: 'coop', active: { type: 'task', id: 't-legacy' },
      chats: [{ id: 'c-legacy', title: '老会话', memberIds: ['claude'], lastStatus: 'done',
        threads: { claude: [{ role: 'user', text: '老消息' }, { role: 'assistant', text: '老回复' }] } }],
      tasks: [
        { id: 't-legacy', goal: '上一轮做的任务', status: 'done', startedAt: 1,
          plan: { goal: '上一轮做的任务', subtasks: [
            { id: 's1', title: '老步骤', memberId: 'claude', role: '写代码', prompt: 'do it', dependsOn: [], status: 'done' },
            // 这一步**故意不写 status**：老存档里常常没有。补出来的卡片该显示「等待」，
            // 而不是替它编一个「已完成」—— 不确定的时候，说"还没有结论"才是诚实的。
            { id: 's2', title: '老步骤2', memberId: 'ghost', role: '评审', prompt: 'x', dependsOn: ['s1'] },
          ] },
          summary: { totalCostUsd: 0.5 } },
        // 更狠的一份：连 plan 都没有，只有 id 和 goal
        { id: 't-bare', goal: '残缺的老任务' },
      ],
    }
    localStorage.setItem('agenthub.ui.v1', JSON.stringify(legacy))
    return 1
  `)
  await page.goto(UI_URL)
  await sleep(2500)

  const afterLegacy = await cdp.eval(`
    return JSON.stringify({
      hasHub: typeof window.AgentHub === 'object',
      mainLen: (document.getElementById('main')?.textContent || '').trim().length,
      mainStart: (document.getElementById('main')?.innerHTML || '').slice(0, 60),
      // 崩了的话这里会有东西（renderMainSafe 的面板）
      crashPanel: !!document.querySelector('.render-crash'),
      // 老任务应该被规范化（卡片按计划步骤补出来），左栏真的画出了两步
      steps: [...document.querySelectorAll('.task-view .step')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
      crumbs: (document.getElementById('crumb')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    })
  `)
  const al = JSON.parse(afterLegacy)
  check('★★ 带老存档打开：主区有内容（不是一片白）',
    al.hasHub && al.mainLen > 0 && !al.crashPanel, afterLegacy)
  check('★★ 老任务被规范化后正常渲染（缺 cards / 缺 plan 的都不许把界面打挂）',
    al.steps.length === 2 && !al.crashPanel, afterLegacy)
  /*
   * ★ 补出来的卡片不许编状态。
   * s1 自己记着 done → 显示「已完成」；s2 没记 → 显示「等待」。
   * 如果这里两个都成了「已完成」，说明补卡片时替历史编了结论 ——
   * 那比左栏空着更坏：用户会以为这一步跑过、有产出，去找一个不存在的产出。
   */
  check('★ 补出来的步骤不编状态：记着的照显示，没记的说「等待」',
    /已完成/.test(al.steps[0] || '') && /等待/.test(al.steps[1] || ''),
    JSON.stringify(al.steps))
  check('★ 老存档里的任务照旧进得去（面包屑说的是这个任务，不是"已删除"）',
    /协同/.test(al.crumbs) && !/已删除/.test(al.crumbs), JSON.stringify(al.crumbs))

  /*
   * 第二条防线：**万一还是崩了，用户必须能自救**。
   * 这里人为把 state 弄坏（模拟任何一种"代码没想到的存档形状"），
   * 断言一定是"看得见的错误面板 + 两个按钮"，而不是白屏。
   */
  const crashPanel = await cdp.eval(`
    const A = window.AgentHub
    // 造一个渲染期必然抛异常的状态：active 指向一个 id 对得上、但 cards 被换成 null 的任务
    A.state.tasks.push({ id: 't-boom', goal: '炸一下', status: 'done',
      plan: { subtasks: [{ id: 'x1', title: 't', memberId: 'claude', role: '评审', prompt: 'p' }] },
      cards: null, cardOrder: ['x1'], logs: [], summary: null, markdown: '' })
    A.state.active = { type: 'task', id: 't-boom' }
    /*
     * 调的是 render()，而且**故意不加 try** —— 这一节要证明的正是
     * "异常不许冒到调用方"。原来的 render() 是一串同步调用，中间一抛，
     * 后面的全不执行、异常一路冒到 boot() 外面 = 白屏。现在它必须自己兜住。
     */
    try { A.render() } catch (e) { return JSON.stringify({ threw: true, msg: String(e) }) }
    return JSON.stringify({
      threw: false,
      panel: !!document.querySelector('.render-crash'),
      title: (document.querySelector('.crash-title')?.textContent || '').trim(),
      msg: (document.querySelector('.crash-msg')?.textContent || '').slice(0, 80),
      retry: !!document.querySelector('[data-act="crash-retry"]'),
      reset: !!document.querySelector('[data-act="crash-reset"]'),
      // 按钮自己不能依赖已经坏掉的状态
      saysDataSafe: /都还在/.test(document.querySelector('.crash-sub')?.textContent || ''),
      warnsReset: /丢掉/.test(document.querySelector('.crash-note')?.textContent || ''),
    })
  `)
  const cp = JSON.parse(crashPanel)
  check('★★ 渲染真的崩了时，不许白屏 —— 必须给一块看得见的错误面板',
    cp.threw === false && cp.panel === true && cp.title.length > 0, crashPanel)
  check('★ 面板把原始报错写出来（不然没人能修它）', (cp.msg || '').length > 10, JSON.stringify(cp.msg))
  check('★★ 面板上有「重试渲染」和「清掉本机存档并重开」——被锁在外面的人得有路可走',
    cp.retry && cp.reset, crashPanel)
  check('★ 面板说清了两件事：数据还在、清存档会丢什么（不吓人也不撒谎）',
    cp.saysDataSafe && cp.warnsReset, crashPanel)

  // 「重试渲染」真的会重新画（不是个死按钮）
  const retried = await cdp.eval(`
    const A = window.AgentHub
    const t = A.state.tasks.find((x) => x.id === 't-boom')
    t.cards = {}                      // 把坏掉的地方修好，再看重试能不能救回来
    document.querySelector('[data-act="crash-retry"]').click()
    return JSON.stringify({
      panel: !!document.querySelector('.render-crash'),
      mainLen: (document.getElementById('main')?.textContent || '').trim().length,
    })
  `)
  const rt = JSON.parse(retried)
  check('★ 点「重试渲染」真的会重画（不是个死按钮）',
    rt.panel === false && rt.mainLen > 0, retried)

  // 收尾：清掉这一节造的东西，恢复成干净状态给最后一节用
  await cdp.eval(`
    const A = window.AgentHub
    A.state.tasks = A.state.tasks.filter((t) => t.id !== 't-boom' && t.id !== 't-legacy' && t.id !== 't-bare')
    A.state.chats = []
    A.state.active = { type: 'blank', id: null }
    localStorage.removeItem('agenthub.ui.v1')
    A.render()
    return 1
  `)
  await sleep(200)

  /*
   * ★ 这里必须**明确清掉**一条我们自己制造的 console.error。
   *
   * 上面那节故意让渲染崩了一次，而 renderMainSafe 的职责之一就是把原始报错
   * `console.error` 出来（不然没人能修它）。所以此刻 consoleErrors 里躺着的那条
   * **不是意外，是这一节的预期产物** —— 不清掉的话，下面"控制台干净度"会报红，
   * 而那个红是假的。清掉什么、为什么清，写在这里。
   *
   * 顺序也是有意选的：这一节放在"控制台干净度"**之前**，
   * 于是老存档 + 崩溃面板这两条新路径产生的**其它**报错（如果有）照样会被 11 节抓住。
   */
  const selfInflicted = consoleErrors.filter((e) => /主区渲染失败/.test(e))
  for (const e of selfInflicted) consoleErrors.splice(consoleErrors.indexOf(e), 1)

  console.log('\n── 11. 控制台干净度 ──')
  const realErrors = [...pageErrors, ...consoleErrors].filter(
    (t) => !/favicon|ERR_PROXY|ResizeObserver loop/i.test(t)
  )
  check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || '))
  check('没有 error 级控制台日志', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '))
  if (realErrors.length) warnings.push(...realErrors)

  // ── 可选：截图存档（SHOT_DIR=某目录）
  if (SHOT_DIR) {
    console.log('\n── 附件：界面截图 ──')

    /*
     * 关键：**显式设定状态，不要靠"点一下切换"**。
     * 踩过的坑：界面把 editorOpen / chats / permission 都存进了 localStorage，
     * 跑完前面几节测试再 Page.reload，恢复出来的是"上次那个样子"，
     * 于是 `click()` 变成了关闭编辑器 —— 截出来的图和文件名对不上。
     * 所以这里先清 localStorage 拿干净底子，再逐项把状态摆到位。
     */
    await cdp.eval(`localStorage.removeItem('agenthub.ui.v1'); location.reload(); return 1`)
    for (let i = 0; i < 200; i++) {
      const ready = await cdp.eval(`return !!(window.AgentHub && window.AgentHub.state.members.length)`).catch(() => false)
      if (ready) break
      await sleep(250)
    }
    await sleep(500)
    await shot('1-空状态')

    await cdp.eval(`document.getElementById('membersBtn').click(); return 1`)
    await sleep(300)
    await shot('2-成员管理')
    await cdp.eval(`document.querySelector('[data-act="close-modal"]').click(); return 1`)

    await cdp.eval(`
      document.getElementById('newTaskBtn').click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('goalBox').value = '给 src/utils.js 的 5 个导出函数补单元测试，并写一段 README 说明测试覆盖了什么';
      return 1
    `)
    await sleep(300)
    await shot('3-新建协同-拆解入口')
    await cdp.eval(`document.querySelector('[data-act="close-modal"]').click(); return 1`)
    await sleep(150)

    // 编辑器：直接把状态摆成"展开"，而不是点一下（点一下可能正好把它关掉）
    await cdp.eval(`window.AgentHub.state.editorOpen = true; window.AgentHub.render(); return 1`)
    await sleep(900)
    await cdp.eval(`
      const f = document.querySelector('#treeItems [data-act="open-file"]');
      f?.click();
      await new Promise(r => setTimeout(r, 800));
      return 1
    `)
    await sleep(400)
    await shot('4-编辑器区')

    if (process.env.SHOT_REAL === '1') {
      // 真发指令，让截图里是真实对话而不是我编的假数据
      console.log('  （SHOT_REAL=1：真发指令，会产生少量 API 费用）')
      await cdp.eval(`window.AgentHub.state.editorOpen = false; window.AgentHub.render(); return 1`)

      // 单会话
      await cdp.eval(`
        document.getElementById('newChatBtn').click();
        await new Promise(r => setTimeout(r, 200));
        document.querySelectorAll('.chat-pick')[0].checked = true;
        document.querySelector('[data-act="create-chat"]').click();
        return 1
      `)
      await sleep(400)
      await cdp.eval(`
        const ta = document.querySelector('textarea.ta');
        ta.value = '用一句话说明 HTTP 语境下的幂等性，只回一句话';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-act="send"]').click();
        return 1
      `)
      await waitIdle()
      await shot('5-单会话-真实对话')

      // 并排 + 广播
      await cdp.eval(`
        document.getElementById('newChatBtn').click();
        await new Promise(r => setTimeout(r, 200));
        const picks = [...document.querySelectorAll('.chat-pick')].slice(0, 3);
        picks.forEach(x => { x.checked = true });
        document.querySelector('[data-act="create-chat"]').click();
        return 1
      `)
      await sleep(500)
      await cdp.eval(`
        const ta = document.querySelector('textarea.ta');
        ta.value = '用一句话说明什么是反向代理';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // 勾选框必须**派发 change** —— 直接改 .checked 应用是看不见的
        // （应用的状态在 change 处理器里更新，这是我自己踩过的坑）
        const cb = document.querySelector('.broadcast-bar input[type=checkbox]');
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-act="send"]').click();
        return 1
      `)
      await sleep(900)
      await shot('6-并排会话-广播中')
      await waitIdle()
      await shot('7-并排会话-广播完成')

      // 协同任务监控台：真跑一次 2 步依赖链，让监控台是"跑出来的"而不是摆拍的
      await cdp.eval(`
        const plan = {
          goal: '说明 HTTP 语境下的幂等性',
          subtasks: [
            { id:'s1', title:'一句话定义', memberId:'claude', role:'文档书写',
              prompt:'用一句话说清 HTTP 语境下什么是幂等。只输出那一句话，不要任何前后说明。', dependsOn:[] },
            { id:'s2', title:'一个反例', memberId:'qoder', role:'评审',
              prompt:'针对上面那句话，指出一个容易被误解的点，并给一个反例。只输出两句。', dependsOn:['s1'] },
          ],
        }
        const t = { id:'shot-task', title:'说明 HTTP 语境下的幂等性', goal: plan.goal, plan,
          permission:'readonly', status:'running', cards:{}, cardOrder:[], logs:[],
          summary:null, markdown:'', startedAt: Date.now() }
        window.AgentHub.state.tasks.unshift(t)
        window.AgentHub.state.active = { type:'task', id: t.id }
        window.AgentHub.render()
        // 用界面自己的 runTask，不另写 fetch —— 否则测的是测试脚本而不是界面
        window.__shotDone = false
        window.AgentHub.runTask(t).then(() => { window.__shotDone = true })
        return 1
      `)
      await sleep(3500)
      await shot('8-协同任务-运行中')
      for (let i = 0; i < 200; i++) {
        if (await cdp.eval(`return !!window.__shotDone`)) break
        await sleep(500)
      }
      await sleep(500)
      await shot('9-协同任务-完成')
    } else {
      console.log('  （未设 SHOT_REAL=1，跳过需要真实对话的截图）')
    }
  }

  // ── 汇总 ──
  const pass = results.filter((r) => r.pass).length
  const fail = results.length - pass
  console.log('')
  console.log(`─── 界面冒烟：${pass} 通过 / ${fail} 失败 ───`)
  if (warnings.length) {
    console.log('控制台噪音（前 5 条）：')
    warnings.slice(0, 5).forEach((w) => console.log('  ' + String(w).slice(0, 300)))
  }
  return fail === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (e) {
  // 打完整栈 —— 只印 message 的话，"api is not defined" 这种根本看不出是**哪一步**挂的
  console.error('\n冒烟跑挂了：' + e.message)
  console.error(String(e.stack || '').split('\n').slice(0, 12).join('\n'))
  process.exitCode = 1
} finally {
  try { page?.close() } catch {}
  await closeBrowser(browser)
}
