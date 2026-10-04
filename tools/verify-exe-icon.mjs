#!/usr/bin/env node
/**
 * 验证一个 .exe 里**真的嵌着**指定 .ico 的图标。
 *
 * ## 为什么需要这个东西
 *
 * 打包脚本用 rcedit 给 AgentHub.exe 设图标。"跑了 rcedit、命令退出码 0"
 * 证明不了什么 —— 图标资源没写进去、写进去的是别的文件、写进了错误的位置，
 * 命令照样成功。打包脚本里每一道关卡的自证哲学（见 package-app.mjs 文件头）
 * 同样适用于这里：**要么拿出"exe 里的字节 = ico 里的字节"的实物证据，要么算红。**
 *
 * ## 怎么验（两步，都是逐字节比较，不看"存在即可"的弱信号）
 *
 *  1. 解析 PE 的资源目录树（.rsrc）：RT_GROUP_ICON(14) 列出这个 exe 实际使用的
 *     每个图标条目（id + 字节数），RT_ICON(3) 是真正的图像数据。
 *  2. 解析 .ico 文件得到它自己的条目，要求：
 *     **exe 的 group 条目数 == ico 条目数，且按 group 的 id 找到的每一块
 *     RT_ICON 数据与 ico 的对应条目逐字节相等。**
 *     只查"RT_ICON 里有没有我们的某一块"不够 —— 老图标残留同样能骗过它。
 *
 * ## 反假绿
 *
 * 解析器最危险的失败方式不是报错，而是**安静地返回空集**（RVA 换算错、
 * 目录树没走对），然后"我们的图标不在里面"恰好又是真的 —— 检查全绿但什么都没查。
 * 所以这里有三道下界：PE 签名必须找到、资源目录必须有 RT_GROUP_ICON 且 ≥1、
 * group 条目数必须等于 ico 条目数。任何一条不满足直接红，不给"通过"。
 *
 * CLI 用法：node tools/verify-exe-icon.mjs <exe> <ico>
 * 也可当模块用（tests/icon.test.mjs 引它）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RT_ICON = 3
const RT_GROUP_ICON = 14
const RT_VERSION = 16

// ────────────────────────────────────────────────── .ico 解析

/**
 * 解析 .ico：返回 [{ size, width, height, bytes, data }]。
 *
 * 条目可能是 PNG（Vista+）也可能是老 BMP。这里只透传字节，不关心格式 ——
 * 校验要的是"字节相等"，格式判断交给 Windows 自己。
 */
export function parseIco(buf) {
  if (buf.length < 6) throw new Error('ico 文件太小，连 6 字节头都不够')
  if (buf.readUInt16LE(2) !== 1) throw new Error(`不是 .ico 文件（类型字段=${buf.readUInt16LE(2)}，应为 1）`)
  const count = buf.readUInt16LE(4)
  const out = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const w = buf[o] === 0 ? 256 : buf[o]
    const h = buf[o + 1] === 0 ? 256 : buf[o + 1]
    const bytesInRes = buf.readUInt32LE(o + 8)
    const dataOffset = buf.readUInt32LE(o + 12)
    if (dataOffset + bytesInRes > buf.length) throw new Error(`ico 条目 ${i} 越界：offset=${dataOffset} len=${bytesInRes}`)
    out.push({ width: w, height: h, bytes: bytesInRes, data: buf.subarray(dataOffset, dataOffset + bytesInRes) })
  }
  if (!out.length) throw new Error('ico 里一个条目都没有')
  return out
}

// ────────────────────────────────────────────────── PE 解析

/** RVA → 文件偏移。靠节表换算：RVA 落在哪个节，就减去节的虚拟地址加上原始数据指针 */
function rvaToOffset(pe, rva) {
  for (const s of pe.sections) {
    const span = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return rva - s.virtualAddress + s.rawPointer
    }
  }
  return null
}

/** 解析 PE 头：节表 + 资源目录的 RVA/大小 */
function parsePe(buf) {
  // DOS 头：e_magic 必须是 'MZ'，e_lfanew（0x3C）指向 PE 签名
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件（缺 MZ 头）')
  const peOff = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('PE 签名不对（应为 PE\\0\\0）')

  // COFF 头（PE 签名后 20 字节）：第 2 个字段是节数，第 16 个是可选头大小
  const coff = peOff + 4
  const numSections = buf.readUInt16LE(coff + 2)
  const optSize = buf.readUInt16LE(coff + 16)
  const opt = coff + 20

  // 可选头魔数决定数据目录的位置：PE32(0x10b) 在 +96，PE32+(0x20b) 在 +112
  const magic = buf.readUInt16LE(opt)
  const ddOff = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0)
  if (!ddOff) throw new Error(`不认识的可选头魔数 0x${magic.toString(16)}（只支持 PE32/PE32+）`)
  const resRva = buf.readUInt32LE(ddOff + 2 * 8)       // 数据目录第 3 项 = 资源表
  const resSize = buf.readUInt32LE(ddOff + 2 * 8 + 4)

  // 节表：紧跟可选头，每项 40 字节
  const sections = []
  for (let i = 0; i < numSections; i++) {
    const o = opt + optSize + i * 40
    sections.push({
      name: buf.subarray(o, o + 8).toString('ascii').replace(/\0.*$/, ''),
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      rawPointer: buf.readUInt32LE(o + 20),
    })
  }
  if (!resRva || !resSize) throw new Error('这个 PE 没有资源表（.rsrc）—— 图标不可能在里面')
  return { sections, resRva, resSize }
}

/**
 * 走资源目录树，返回 { type: Map<id, leaf字节[]> }。
 *
 * 树是三层：类型 → 资源 id → 语言。每层 16 字节目录头 + N×8 字节条目。
 * 条目高位的含义：Name/Offset 的高位 = "这是名字/这是子目录"，剥掉后才是真值。
 */
function walkResources(buf, pe) {
  const base = rvaToOffset(pe, pe.resRva)
  if (base == null) throw new Error(`资源目录 RVA 0x${pe.resRva.toString(16)} 落在节表之外`)

  function readDir(offset) {
    const named = buf.readUInt16LE(offset + 12)
    const ided = buf.readUInt16LE(offset + 14)
    const entries = []
    for (let i = 0; i < named + ided; i++) {
      const e = offset + 16 + i * 8
      const id = buf.readUInt32LE(e) & 0x7fffffff
      const val = buf.readUInt32LE(e + 4)
      entries.push({ id, isDir: (val & 0x80000000) !== 0, val: val & 0x7fffffff })
    }
    return entries
  }

  const byType = new Map()
  function walk(off, depth, path) {
    for (const en of readDir(off)) {
      const p = [...path, en.id]
      if (en.isDir) { walk(base + en.val, depth + 1, p); continue }   // 递归，不 return —— 否则只走第一个兄弟
      // 叶子：IMAGE_RESOURCE_DATA_ENTRY = dataRva(4) size(4) codepage(4) reserved(4)
      const dataRva = buf.readUInt32LE(base + en.val)
      const size = buf.readUInt32LE(base + en.val + 4)
      const off2 = rvaToOffset(pe, dataRva)
      if (off2 == null) throw new Error(`资源叶子 RVA 0x${dataRva.toString(16)} 落在节表之外`)
      const type = p[0]
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push({ id: p[1], bytes: size, data: buf.subarray(off2, off2 + size) })
    }
  }
  walk(base, 0, [])
  return byType
}

// ────────────────────────────────────────────────── 图标级校验

/**
 * 从 exe 的 group icon 描述里取出"实际使用"的图标。
 *
 * RT_GROUP_ICON 的数据 = GRPICONDIR(6) + N×14：每项有宽高/位深/字节数和
 * **指向 RT_ICON 资源的 id**。Windows 显示 exe 图标时走的就是这份清单 ——
 * 所以校验必须沿它走，而不是"RT_ICON 里有没有长得像的块"。
 */
function groupEntries(blob) {
  const count = blob.readUInt16LE(4)
  const out = []
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14
    out.push({
      width: blob[o] === 0 ? 256 : blob[o],
      height: blob[o + 1] === 0 ? 256 : blob[o + 1],
      bytes: blob.readUInt32LE(o + 8),
      iconId: blob.readUInt16LE(o + 12),
    })
  }
  return out
}

/**
 * 主校验：exe 里的图标是否就是 ico 里的图标（逐字节）。
 *
 * `productName` 可选：给了就顺带验一下版本资源里写的产品名。
 * 版本信息和图标是同一件事的两半 —— 都属于"只有用户能看见"的失败：
 * 属性面板里写着 Electron、作者是 Electron，比图标不对更难看。所以一起验。
 *
 * 返回 { ok: boolean, problems: string[], details: object }
 */
export function verifyExeIcon(exeBuf, icoBuf, { productName } = {}) {
  const problems = []
  const pe = parsePe(exeBuf)
  const res = walkResources(exeBuf, pe)

  const groups = res.get(RT_GROUP_ICON) || []
  if (!groups.length) {
    problems.push('exe 里没有 RT_GROUP_ICON 资源 —— Windows 根本不会显示任何图标')
  }
  const icons = res.get(RT_ICON) || []
  if (!icons.length) problems.push('exe 里没有 RT_ICON 图像数据')

  // group（实际使用）按 id 找到对应的 RT_ICON 数据
  const iconById = new Map(icons.map((ic) => [ic.id, ic.data]))
  const used = []
  for (const g of groups) {
    for (const ge of groupEntries(g.data)) {
      const blob = iconById.get(ge.iconId)
      if (!blob) {
        problems.push(`group 引用的 RT_ICON id=${ge.iconId} 不存在（资源被删了？）`)
        continue
      }
      used.push({ ...ge, data: blob })
    }
  }

  const mine = parseIco(icoBuf)
  if (used.length !== mine.length) {
    problems.push(`exe 实际使用的图标条目 ${used.length} 个 ≠ ico 的 ${mine.length} 个`)
  }

  // 逐字节对：ico 的每个条目都必须在"实际使用"集合里找到一块完全相等的
  const pool = [...used]
  let matched = 0
  for (const m of mine) {
    const idx = pool.findIndex((u) => u.bytes === m.data.length && Buffer.compare(u.data, m.data) === 0)
    if (idx === -1) {
      problems.push(`ico 的 ${m.width}×${m.height} 条目在 exe 实际使用的图标里找不到逐字节相等的块`)
    } else {
      matched++
      pool.splice(idx, 1)
    }
  }

  // 版本资源：VERSIONINFO 里的键值都是 UTF-16 存的，整块按 utf16le 解出来搜字符串
  let productFound = null
  if (productName) {
    const vers = res.get(RT_VERSION) || []
    if (!vers.length) {
      problems.push('exe 里没有 RT_VERSION 资源 —— 属性面板里不会显示我们的产品名')
    } else {
      const text = Buffer.concat(vers.map((v) => v.data)).toString('utf16le')
      if (!text.includes('ProductName')) {
        problems.push('版本资源里没有 ProductName 字段')
      } else if (!text.includes(productName)) {
        problems.push(`版本资源里找不到产品名 "${productName}"（属性面板显示的会是别的名字）`)
      } else {
        productFound = productName
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    details: {
      groupCount: groups.length,
      rtIconCount: icons.length,
      usedCount: used.length,
      icoCount: mine.length,
      matched,
      sizes: mine.map((m) => m.width),
      productFound,
    },
  }
}

// ────────────────────────────────────────────────── CLI

/** 被直接运行（而不是被测试 import）时才走 CLI —— 用规范 URL 比较，别猜 argv */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const exePath = process.argv[2]
  const icoPath = process.argv[3]
  const productName = process.argv[4]           // 可选：顺带验版本资源里的产品名
  if (!exePath || !icoPath) {
    console.error('用法：node tools/verify-exe-icon.mjs <exe> <ico> [产品名]')
    process.exit(2)
  }
  try {
    const r = verifyExeIcon(readFileSync(exePath), readFileSync(icoPath), { productName })
    const d = r.details
    console.log(`  exe 资源：group=${d.groupCount} rt_icon=${d.rtIconCount}；实际使用 ${d.usedCount} 条，逐字节匹配 ${d.matched}/${d.icoCount}（ico 尺寸 ${d.sizes.join('/')}）`)
    if (productName) console.log(`  版本资源：产品名 ${d.productFound ? `= ${d.productFound}` : '未通过'}`)
    for (const p of r.problems) console.log(`  ✗ ${p}`)
    process.exit(r.ok ? 0 : 1)
  } catch (e) {
    console.log(`  ✗ 解析失败：${e.message}`)
    process.exit(1)
  }
}
