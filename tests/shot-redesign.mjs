#!/usr/bin/env node
/**
 * 一次性截图工具：把改版的四个关键界面各截一张。
 *
 * 用法：UI_URL=http://127.0.0.1:8799 SHOT_DIR=D:/.../shots node tests/shot-redesign.mjs
 *
 * 为什么要有它：界面冒烟 130+ 条断言盯的全是**行为**，一条都不管"长什么样"。
 * 改版这种事只能靠眼睛验收，而屏幕上没人盯着的时候，截图是唯一的验收手段。
 * 同一个脚本对**改版前**的副本跑一遍，就有了 before / after 的对照。
 *
 * 四个状态对应四种不同的版式骨架，不是随便挑的：
 *   1. 首页（选择页）—— 英雄区 + 卡片网格 + 最近
 *   2. 协同页签 —— 表单式布局
 *   3. 空会话 —— 起点卡（改版新加的）
 *   4. 协同任务 —— 任务头数字 + 进度条 + 卡片链四种状态
 */
import process from 'node:process'
import { launchBrowser, closeBrowser, newPage, sleep } from './lib/browser.mjs'

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.CDP_PORT || 0)   // 0 = 自动挑端口
const SHOT_DIR = process.env.SHOT_DIR || '.'
/** 文件名前缀，用来区分 before / after（同一批图放一个目录里更好比） */
const TAG = process.env.SHOT_TAG || 'after'

let browser = null
try {
  browser = await launchBrowser({ port: CDP_PORT })
  const page = await newPage(browser.port, UI_URL)
  /*
   * ★ 等成员探活跑完再截。探活要真跑每个 CLI 的 `--version`，冷启动几秒很正常；
   *   只睡固定时间会截到"还没有成员"的空首页 —— 那不是版式问题，是还没加载完，
   *   拿它当 before/after 对照会得出完全错误的结论（第一版就踩了）。
   */
  for (let i = 0; i < 40; i++) {
    const n = await page.cdp.eval(`return document.querySelectorAll('.member-card').length`).catch(() => 0)
    if (n > 0) break
    await sleep(400)
  }
  await sleep(400)

  // ① 首页（单独页签，默认）
  await page.shot(SHOT_DIR, `${TAG}-1-首页-单独`)

  // ② 首页协同页签
  await page.cdp.eval(`document.querySelectorAll('.home-tab')[1].click(); return 1`)
  await sleep(400)
  await page.shot(SHOT_DIR, `${TAG}-2-首页-协同`)
  await page.cdp.eval(`document.querySelectorAll('.home-tab')[0].click(); return 1`)
  await sleep(300)

  // ③ 空会话：起点卡 + 左栏两行条目
  await page.cdp.eval(`
    document.querySelector('.member-card:not(.orch-card)').click();
    return 1
  `)
  await sleep(500)
  await page.shot(SHOT_DIR, `${TAG}-3-会话-起点卡`)

  // ④ 协同任务：造一份四种状态齐全的任务，看任务头的数字与卡片链
  await page.cdp.eval(`
    const A = window.AgentHub;
    const mk = (id, title, memberId, role, status, extra = {}) => ({
      id, title, memberId, role, status, prompt: '【' + id + '】' + title + ' —— 这是给该成员的具体指令',
      startedAt: 0, durationMs: 4231, text: status === 'skip' ? '' : '（这一步的产出会印在这里）',
      cost: { usd: 0.0123, outputTokens: 812 }, quality: { level: 'ok', codes: [], note: '' },
      changedFiles: status === 'done' ? ['src/utils.js'] : null,
      degradedUpstream: [], skipKind: status === 'skip' ? 'blocked' : '', _tid: 'shot-t', ...extra,
    });
    const subtasks = [
      { id: 's1', title: '读代码、定测试范围', memberId: 'claude', role: '代码主笔', prompt: 'p1', dependsOn: [] },
      { id: 's2', title: '补单元测试', memberId: 'cursor', role: '测试', prompt: 'p2', dependsOn: ['s1'] },
      { id: 's3', title: '写 README 章节', memberId: 'qoder', role: '文档书写', prompt: 'p3', dependsOn: ['s1'] },
      { id: 's4', title: '汇总交付', memberId: 'dsh', role: '执行者', prompt: 'p4', dependsOn: ['s2', 's3'] },
    ];
    A.state.tasks.unshift({
      id: 'shot-t', title: '给工具模块补单测', goal: '给 src/utils.js 的 5 个导出函数补单元测试，并写一份 README 章节说明覆盖了什么',
      plan: { goal: '给工具模块补单测', subtasks }, permission: 'execute', failurePolicy: 'skip-blocked',
      status: 'running', cardOrder: subtasks.map(s => s.id),
      cards: {
        s1: mk('s1', '读代码、定测试范围', 'claude', '代码主笔', 'done'),
        s2: mk('s2', '补单元测试', 'cursor', '测试', 'fail'),
        s3: mk('s3', '写 README 章节', 'qoder', '文档书写', 'skip'),
        s4: mk('s4', '汇总交付', 'dsh', '执行者', 'run'),
      },
      summary: null, markdown: '', startedAt: Date.now(),
      logs: [
        { t: '18:40:01', text: '已连接执行通道' },
        { t: '18:40:01', text: '计划校验通过，分 3 批执行' },
        { t: '18:40:02', text: '▶ [s1] Claude / 代码主笔 开始' },
        { t: '18:40:06', text: '■ [s1] Claude ok · 4.2s · 改动 1 文件' },
        { t: '18:40:07', text: '▶ [s2] Cursor / 测试 开始' },
        { t: '18:40:11', text: '■ [s2] Cursor failed · 4.2s' },
        { t: '18:40:12', text: '⊘ [s3] 未执行 · 依赖的 s1 没有可用产出' },
      ],
    });
    A.state.active = { type: 'task', id: 'shot-t' };
    A.render();
    return 1
  `)
  await sleep(500)
  await page.shot(SHOT_DIR, `${TAG}-4-协同任务`)

  console.log('截图完成 →', SHOT_DIR)
} catch (e) {
  console.error('截图失败：' + e.message)
  process.exitCode = 1
} finally {
  await closeBrowser(browser)
}
