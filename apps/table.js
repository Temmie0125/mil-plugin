/**
 * Milthm 定数表
 * 命令: #mil table <定数> / #mil 定数表 <定数> / #mil 定数 <定数>
 * <定数> 为 1~floor(最高谱面定数) 的整数，或 SP
 */
import milPluginBase from '../components/baseClass.js'
import Config from '../components/Config.js'
import send from '../model/send.js'
import getInfo from '../model/getInfo.js'
import picmodle from '../model/picmodle.js'
import Version from '../components/Version.js'
import fCompute from '../model/fCompute.js'
import fs from 'fs'

const Plugin_Path = `${process.cwd()}/plugins/mil-plugin`

/** 参与定数表的标准难度（排除 _Story 变种） */
const TABLE_DIFFICULTIES = ['Drizzle', 'Sprinkle', 'Cloudburst', 'Clear', 'Special']

/** 难度标签渐变色 CSS */
const DIFFICULTY_COLORS = {
    'Drizzle': 'linear-gradient(135deg, #5a9a6f, #7ecb8a)',
    'Sprinkle': 'linear-gradient(135deg, #5b9bd5, #8ec5fc)',
    'Cloudburst': 'linear-gradient(135deg, #7b5ea7, #a78bcf)',
    'Clear': 'linear-gradient(135deg, #555555, #9e9e9e)',
    'Special': 'linear-gradient(135deg, #e8843c, #f5a623)'
}

/** Logo 路径（文件不存在时模板降级为 CSS 文字标题） */
const LOGO_PATH = `${Plugin_Path}/resources/icon/Milthm.png`

export class milTable extends milPluginBase {
    constructor() {
        super({
            name: 'mil-定数表',
            dsc: 'Milthm定数表',
            event: 'message',
            priority: 1000,
            rule: [{
                reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(table|定数表|定数)\\s*(.*)$`,
                fnc: 'table'
            }]
        })
    }

    async table(e) {
        // 提取命令参数（规则已保证整体匹配；"定数表"需优先于"定数"交替）
        let msg = e.msg.replace(/^[#/]\S*?\s*(table|定数表|定数)\s*/, '')

        // 1. 解析参数
        const param = parseParam(msg)
        if (param.type === 'error') {
            send.send_with_At(e, param.msg)
            return true
        }

        // 2. 提取数据
        const data = buildTableData(param)
        if (!data) {
            if (param.type === 'sp') {
                send.send_with_At(e, '暂无SP/多指谱面数据')
            } else {
                send.send_with_At(e, `定数${param.value}暂无谱面数据`)
            }
            return true
        }

        // 3. 渲染并发送
        send.send_with_At(e, await picmodle.table(data))
        return true
    }
}

/**
 * 解析命令参数
 * @param {string} raw - 用户输入的命令参数
 * @returns {{type: 'sp'} | {type: 'integer', value: number} | {type: 'error', msg: string}}
 */
function parseParam(raw) {
    const trimmed = (raw || '').trim()
    if (!trimmed) {
        return { type: 'error', msg: '请输入定数参数\n格式：/mil table <定数>，定数为 1~12 的整数或 SP' }
    }

    if (/^sp$/i.test(trimmed)) {
        return { type: 'sp' }
    }

    if (!/^\d+$/.test(trimmed)) {
        return { type: 'error', msg: '参数格式错误，请输入整数定数或SP' }
    }

    const num = parseInt(trimmed, 10)
    const maxInt = getMaxIntConst()
    if (num < 1 || num > maxInt) {
        return { type: 'error', msg: `定数范围: 1~${maxInt}` }
    }

    return { type: 'integer', value: num }
}

/**
 * 构建定数表渲染数据
 * @param {{type: 'sp'} | {type: 'integer', value: number}} param
 * @returns {object|null} 渲染数据，无谱面时返回 null
 */
function buildTableData(param) {
    if (param.type === 'sp') return buildSPTable()
    return buildNormalTable(param.value)
}

/**
 * 普通定数表：指定整数区间 [N.0, N.9] 内的标准难度谱面
 * 排除 Special 难度与 Clear 多指谱面（IsMania=1，归入SP表）
 * @param {number} intConst - 整数定数 (1~maxInt)
 * @returns {object|null}
 */
function buildNormalTable(intConst) {
    const entries = []
    for (const [key, song] of Object.entries(getInfo.ori_info)) {
        const diff = song.difficulty
        if (!diff) continue
        for (const diffName of TABLE_DIFFICULTIES) {
            if (diffName === 'Special') continue // 普通表排除 SP 难度
            const chart = diff[diffName]
            if (!chart) continue
            if (diffName === 'Clear' && chart.IsMania === 1) continue // 多指谱面归入SP表
            const dv = chart.difficultyValue
            if (typeof dv !== 'number' || dv <= 0 || Math.floor(dv) !== intConst) continue
            entries.push(createEntry(key, song, diffName, dv))
        }
    }
    if (entries.length === 0) return null

    const rows = groupEntries(entries)
    return {
        titleNumber: String(intConst),
        isSP: false,
        gameVersion: Version.milthm,
        version: Version.ver,
        background: pickRandomBackground(),
        logoPath: getLogoPath(),
        sections: splitIntoSections(rows, intConst)
    }
}

/**
 * SP 定数表：Special 难度 + Clear 难度中的多指谱面 (IsMania=1)
 * 当前所有 SP 谱面 dv=0，平铺展示；未来补填定数后自动启用分段
 * @returns {object|null}
 */
function buildSPTable() {
    const spEntries = []
    let hasValidConstant = false

    for (const [key, song] of Object.entries(getInfo.ori_info)) {
        const diff = song.difficulty
        if (!diff) continue

        // 来源1: Special 难度
        if (diff.Special) {
            const dv = diff.Special.difficultyValue || 0
            if (dv > 0) hasValidConstant = true
            spEntries.push(createEntry(key, song, 'Special', dv))
        }

        // 来源2: Clear 难度中的多指谱面 (IsMania=1)
        if (diff.Clear && diff.Clear.IsMania === 1) {
            const dv = diff.Clear.difficultyValue || 0
            if (dv > 0) hasValidConstant = true
            spEntries.push(createEntry(key, song, 'Clear', dv))
        }
    }

    if (spEntries.length === 0) return null

    // 按 difficultyValue 排序
    spEntries.sort((a, b) => b.difficultyValue - a.difficultyValue)

    let sections
    if (hasValidConstant) {
        // 未来路径：按定数值正常分段（同普通表逻辑）
        const intConsts = [...new Set(spEntries.map(en => Math.floor(en.difficultyValue)))].sort((a, b) => b - a)
        sections = []
        for (const intConst of intConsts) {
            const rows = groupEntries(spEntries.filter(en => Math.floor(en.difficultyValue) === intConst))
            sections.push(...splitIntoSections(rows, intConst))
        }
    } else {
        // 当前路径：所有 dv=0，平铺展示
        sections = [{
            label: 'Special / Multi Finger',
            rows: [{
                constantStr: 'SP',
                songs: spEntries
            }]
        }]
    }

    return {
        titleNumber: 'SP',
        isSP: true,
        gameVersion: Version.milthm,
        version: Version.ver,
        background: pickRandomBackground(),
        logoPath: getLogoPath(),
        sections
    }
}

/**
 * 创建歌曲条目
 * @param {string} songKey - 歌曲 key
 * @param {object} song - 歌曲原始信息
 * @param {string} diffName - 难度全名 (Drizzle/Sprinkle/Cloudburst/Clear/Special)
 * @param {number} dv - 定数值
 * @returns {object} SongEntry
 */
function createEntry(songKey, song, diffName, dv) {
    const chart = song.difficulty?.[diffName] || {}
    return {
        songKey,
        title: typeof song.latinTitle === 'string' ? song.latinTitle : songKey,
        illustration: getInfo.getill(songKey),
        difficultyValue: dv,
        difficultyType: fCompute.LevelAbbr[diffName] || diffName,
        difficultyColor: DIFFICULTY_COLORS[diffName] || '',
        charter: chart.charter || ''
    }
}

/**
 * 按定数值分组（同一数值合并为一行），组内保持 info.json 原有顺序
 * @param {object[]} entries
 * @returns {object[]} ConstantRow 数组，按定数值从高到低
 */
function groupEntries(entries) {
    const map = new Map()
    for (const entry of entries) {
        if (!map.has(entry.difficultyValue)) map.set(entry.difficultyValue, [])
        map.get(entry.difficultyValue).push(entry)
    }
    return [...map.entries()]
        .map(([dv, songs]) => ({
            constant: dv,
            constantStr: Number(dv).toFixed(1),
            songs
        }))
        .sort((a, b) => b.constant - a.constant)
}

/**
 * 将定数行按区间切分为上下两段（N.9~N.5 / N.4~N.0），过滤空段
 * @param {object[]} rows - 同一整数区间内的定数行（高到低）
 * @param {number} intConst - 整数定数
 * @returns {object[]} Section 数组
 */
function splitIntoSections(rows, intConst) {
    const sections = []
    const upper = rows.filter(r => r.constant >= intConst + 0.5)
    if (upper.length > 0) {
        sections.push({ label: `${intConst}.5~${intConst}.9`, rows: upper })
    }
    const lower = rows.filter(r => r.constant < intConst + 0.5)
    if (lower.length > 0) {
        sections.push({ label: `${intConst}.0~${intConst}.4`, rows: lower })
    }
    return sections
}

/**
 * 获取当前最高谱面定数的整数部分（从 info.json 动态计算）
 * @returns {number}
 */
function getMaxIntConst() {
    let max = 0
    for (const song of Object.values(getInfo.ori_info)) {
        const diff = song.difficulty
        if (!diff) continue
        for (const chart of Object.values(diff)) {
            const dv = chart?.difficultyValue
            if (typeof dv === 'number' && dv > max) max = dv
        }
    }
    return Math.floor(max)
}

/**
 * 随机选取一张背景曲绘（全部127首曲目中随机）
 * @returns {string} 曲绘绝对路径，无曲绘资源时返回空字符串
 */
function pickRandomBackground() {
    const allIlls = getInfo.illlist
    if (!allIlls || allIlls.length === 0) return ''
    const randomIll = allIlls[fCompute.randBetween(0, allIlls.length - 1)]
    return `${Plugin_Path}/resources/origin_ill/ill/${randomIll}`
}

/**
 * Logo 路径，文件不存在时返回空字符串（模板降级为 CSS 文字标题）
 * @returns {string}
 */
function getLogoPath() {
    return fs.existsSync(LOGO_PATH) ? LOGO_PATH : ''
}
