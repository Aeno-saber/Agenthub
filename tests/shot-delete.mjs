#!/usr/bin/env node
/**
 * 一次性截图：左栏的删除入口（悬停态）与删除确认框。
 * 用法：UI_URL=... SHOT_DIR=... node tests/shot-delete.mjs
 *
 * 悬停态必须用**真鼠标**（Input.dispatchMouseEvent）来摆 ——
 * 改 class 是摆不出来的，:hover 由浏览器算。
 */
import { launchBrowser, closeBrowser, newPage, sleep } from './lib/browser.mjs'

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.CDP_PORT || 0)   // 0 = 自动挑端口
const SHOT_DIR = process.env.SHOT_DIR || '.'

let browser = null
try {
  browser = await launchBrowser({ port: CDP_PORT })
  const page = await newPage(browser.port, UI_URL)
  await sleep(800)
  await page.waitFor(`return !!(window.AgentHub && window.AgentHub.state.members.length)`)

  // 摆出"攒了几条垃圾会话"的样子
  await page.cdp.eval(`
    const S = window.AgentHub.state;
    S.sidebarMini = false;
    S.homeTab = 'solo';
    S.chats = [
      { id: 'd1', title: 'Claude', memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} },
      { id: 'd2', title: 'Claude', memberIds: ['claude'], threads: { claude: [] }, busy: {}, lastStatus: {} },
      { id: 'd3', title: 'Qoder + Cursor', memberIds: ['qoder', 'cursor'], threads: { qoder: [], cursor: [] }, busy: {}, lastStatus: {} },
    ];
    S.tasks = [];
    S.active = { type: 'chat', id: 'd1' };
    window.AgentHub.render();
    return 1
  `)
  await sleep(400)

  // 真鼠标移到第 2 行上，让 × 显形
  const at = await page.cdp.eval(`
    const row = document.querySelector('#chatList .item[data-id="d2"]');
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width - 30), y: Math.round(r.top + r.height / 2) }
  `)
  await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 })
  await sleep(300)
  await page.shot(SHOT_DIR, '左栏-删除入口（悬停显形）')

  // 删除确认框
  await page.cdp.eval(`document.querySelector('#chatList .item[data-id="d2"] .item-del').click(); return 1`)
  await sleep(350)
  await page.shot(SHOT_DIR, '删除确认框')
  console.log('截图完成')
} catch (e) {
  console.error('截图失败：' + e.message)
  process.exitCode = 1
} finally {
  await closeBrowser(browser)
}
