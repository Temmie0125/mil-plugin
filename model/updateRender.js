/**
 * 更新记录渲染逻辑（phi-plugin flag 模式）
 * 供 apps/user.js 和 apps/cloud.js 共用
 */
import getSave from './getSave.js'
import fCompute from './fCompute.js'
import getInfo from './getInfo.js'
import Version from '../components/Version.js'
import picmodle from './picmodle.js'

/**
 * 根据 Reality 历史数据构建 SVG 折线坐标和日期范围
 * @param {Array<[string, number]>} history - [[dateStr, reality], ...]
 * @returns {{ rks_history: number[][], rks_date: string[], rks_range: number[] }}
 */
export function buildRksHistory(history) {
    if (!history || history.length < 2) {
        return { rks_history: [], rks_date: [], rks_range: [0, 0] }
    }

    let values = history.map(h => h[1])
    let min = Math.min(...values)
    let max = Math.max(...values)
    let yMin = min
    let yMax = max
    // 单值或极小范围时撑开一点避免除零
    if (yMax - yMin < 0.0001) {
        yMin -= 0.01
        yMax += 0.01
    }
    let yRange = yMax - yMin || 1

    let segments = []
    for (let i = 0; i < history.length - 1; i++) {
        let x1 = (i / (history.length - 1)) * 100
        let y1 = ((history[i][1] - yMin) / yRange) * 100
        let x2 = ((i + 1) / (history.length - 1)) * 100
        let y2 = ((history[i + 1][1] - yMin) / yRange) * 100
        segments.push([x1, y1, x2, y2])
    }

    return {
        rks_history: segments,
        rks_date: [history[0][0], history[history.length - 1][0]],
        rks_range: [yMin, yMax]
    }
}

/**
 * 渲染更新图片
 * @param {string} userId
 * @param {object} entry - updateEntry from diff
 * @returns {Promise<any>}
 */
export async function renderUpdateImage(userId, entry) {
    let updateLog = getSave.getUpdateLog(userId)
    let realityHistory = updateLog.getRealityHistory()
    let curve = buildRksHistory(realityHistory)

    // maxUpdateEntries 控制界面展示的曲目卡片最大数量，Reality 曲线使用完整数据
    let maxCards = updateLog.getMaxEntries()

    // 构建星星字符串
    let starStr = ''
    for (let i = 0; i < (entry.starLevel || 0); i++) {
        starStr += '★'
    }

    // 随机背景曲绘
    let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

    // 遍历历史记录，预构建日期分组（仿 phi-plugin 的 tot_update 结构）
    // 每组包含该次更新的所有曲目卡片，按时间倒序排列
    const DATE_COLORS = [
        '#ff82e4', '#82d5ff', '#82ffb4', '#ffe082', '#ff9e82', '#b482ff',
        '#82ffed', '#ff82b4', '#b4ff82', '#82b4ff', '#e482ff', '#ffd582'
    ]
    let dateColorMap = new Map()
    let dateGroups = []
    for (let h of updateLog.history) {
        let cards = (h.changes || []).slice(0, 10)
        if (cards.length === 0) continue
        if (!dateColorMap.has(h.date)) {
            dateColorMap.set(h.date, DATE_COLORS[dateColorMap.size % DATE_COLORS.length])
        }
        let total = h.totalChanges || h._allChangesCount || 0
        let color = dateColorMap.get(h.date)

        let songs = cards.map(card => ({
            song: card.song,
            illustration: card.illustration,
            Rating: card.afterGrade,
            rank: card.levelAbbr,
            score_new: card.afterScore,
            acc_new: (card.afterAccuracy || 0) * 100,
            rks_new: card.afterReality || 0,
            isNew: card.isNew || false,
            beforeScore: card.beforeScore,
            afterScore: card.afterScore
        }))

        dateGroups.push({ date: h.date, color, total, songs })

        let cardCount = dateGroups.reduce((sum, g) => sum + g.songs.length, 0)
        if (cardCount >= maxCards) break
    }

    // 仿 phi-plugin 的 flag 模式构建 box_line
    // - flag=false: 新日期组的第一行 → 渲染日期标签
    // - flag=true:  同一日期组的后续行 → 不渲染日期标签
    // - 日期组消耗完毕时在末行设置 update_num
    let box_line = []
    let line_num = 5  // 强制新行
    let flag = false

    while (dateGroups.length) {
        if (line_num === 5) {
            if (flag) {
                box_line.push([{ color: dateGroups[0].color, song: dateGroups[0].songs.splice(0, 5) }])
            } else {
                box_line.push([{ date: dateGroups[0].date, color: dateGroups[0].color, song: dateGroups[0].songs.splice(0, 5) }])
            }
            let tem = box_line[box_line.length - 1]
            line_num = tem[tem.length - 1].song.length
        } else {
            let tem = box_line[box_line.length - 1]
            if (flag) {
                tem.push({ color: dateGroups[0].color, song: dateGroups[0].songs.splice(0, 5 - line_num) })
            } else {
                tem.push({ date: dateGroups[0].date, color: dateGroups[0].color, song: dateGroups[0].songs.splice(0, 5 - line_num) })
            }
            line_num += tem[tem.length - 1].song.length
        }
        let tem = box_line[box_line.length - 1]
        tem[tem.length - 1].width = (tem[tem.length - 1].song.length || 0) * 155 - 20
        flag = true
        if (!dateGroups[0].songs.length) {
            tem[tem.length - 1].update_num = dateGroups[0].total > 1 ? dateGroups[0].total : 0
            dateGroups.shift()
            flag = false
        }
    }

    // 标题栏数据从 history 中取（与曲线同源），避免 entry 参数不一致
    let latestEntry = updateLog.history[0] || entry

    let data = {
        username: latestEntry.username,
        reality: latestEntry.afterReality,
        realityDelta: latestEntry.realityDelta,
        date: latestEntry.date,
        starStr,
        starLevel: latestEntry.starLevel,
        box_line,
        ...curve,
        background: bgIll,
        version: Version.ver
    }

    return await picmodle.update(data)
}
