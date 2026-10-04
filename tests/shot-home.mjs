#!/usr/bin/env node
/**
 * 一次性截图工具：把首页的两个页签都截下来。
 * 用法：UI_URL=... SHOT_DIR=... node tests/shot-home.mjs
 */
import process from 'node:process'
import { launchBrowser, closeBrowser, newPage, sleep } from './lib/browser.mjs'

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.CDP_PORT || 0)   // 0 = 自动挑端口
const SHOT_DIR = process.env.SHOT_DIR || '.'

let browser = null
try {
  browser = await launchBrowser({ port: CDP_PORT })
  const page = await newPage(browser.port, UI_URL)
  await sleep(600)
  await page.shot(SHOT_DIR, '首页-1-单独工作')
  await page.cdp.eval(`document.querySelectorAll('.home-tab')[1].click(); return 1`)
  await sleep(400)
  await page.shot(SHOT_DIR, '首页-2-协同任务')
  console.log('截图完成')
} catch (e) {
  console.error('截图失败：' + e.message)
  process.exitCode = 1
} finally {
  await closeBrowser(browser)
}
