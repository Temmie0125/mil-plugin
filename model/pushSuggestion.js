/**
 * Milthm 推分建议计算模块
 *
 * 原理:
 *   B20 Reality = sum(single_rlt for top 20 charts) / 20
 *   游戏内显示四舍五入到2位小数。
 *
 *   要让显示 +0.01，需要的增量取决于当前 Reality 在四舍五入周期中的位置:
 *     deltaNeeded = floor_display + 0.005 - currentReality
 *     范围约 0.0001 ~ 0.0100
 *
 *   例: currentReality=12.5000(显示12.50) → 需≥12.505 → delta=0.005
 *       currentReality=12.5050(显示12.51) → 需≥12.515 → delta=0.010
 *       currentReality=12.5149(显示12.51) → 需≥12.515 → delta=0.0001
 *
 *   两种情况：
 *   1. 谱面已在 Best20 内：
 *      new_rlt >= old_rlt + deltaNeeded * 20
 *   2. 谱面不在 Best20 内：
 *      new_rlt >= 20th_rlt + deltaNeeded * 20
 */

import { realityv3 } from './reality.js'

/**
 * 根据目标 Reality 和谱面定数，反推所需最低分数（使用 v3 公式）
 * @param {number} targetRlt - 目标单曲 Reality
 * @param {number} difficulty - 谱面定数 c
 * @returns {number|null} 所需最低分数（整数），null 表示无法达到
 */
export function reverseRealityV3(targetRlt, difficulty) {
    const c = difficulty
    if (c < 1e-3) return null
    if (targetRlt <= 0) return 0

    const maxRlt = c + 1.5
    if (targetRlt > maxRlt) return null // 超出理论最大值

    // S 及以上 (score >= 850000): r = c + (s - 850000) / 100000
    if (targetRlt >= c) {
        if (Math.abs(targetRlt - maxRlt) < 1e-9) {
            return 1000000 // 刚好理论值需要1000000分
        }
        // s = 850000 + (r - c) * 100000，减去微小epsilon防止浮点误差导致ceil多1
        let s = 850000 + (targetRlt - c) * 100000
        return Math.ceil(s - 1e-6)
    }

    // A/B 段 (700000 <= s < 850000): r = c*(0.5+(s-700000)/300000) + (s-850000)/100000
    // 推导: s = (r + 11c/6 + 8.5) * 300000 / (c + 3)
    {
        let s = (targetRlt + 11 * c / 6 + 8.5) * 300000 / (c + 3)
        s = Math.ceil(s - 1e-6)
        if (s >= 700000 && s < 850000) {
            // 验证
            let verify = realityv3(s, c)
            if (verify >= targetRlt - 1e-6) return s
        }
    }

    // C 段 (600000 <= s < 700000): r = (c-3) * (s-600000) / 200000
    if (c > 3) {
        let s = 600000 + targetRlt * 200000 / (c - 3)
        s = Math.ceil(s - 1e-6)
        if (s >= 600000 && s < 700000) {
            let verify = realityv3(s, c)
            if (verify >= targetRlt - 1e-6) return s
        }
    }

    // 低于 C 无 Reality，回退到可及的最低分
    return 600000
}

/**
 * 推分建议计算结果
 * @typedef {object} PushSuggestion
 * @property {number} currentReality - 当前 B20 Reality
 * @property {string} currentDisplay - 当前显示 Reality（2位小数）
 * @property {string} targetDisplay - 目标显示 Reality（当前+0.01）
 * @property {number} deltaNeeded - 总 Reality 需要提升的值
 * @property {boolean} inB20 - 目标谱面是否在 B20 内
 * @property {number} currentChartRlt - 当前该谱面的单曲 Reality
 * @property {number} targetChartRlt - 目标单曲 Reality
 * @property {number} targetScore - 达到目标所需最低分数
 * @property {number} chartDifficulty - 谱面定数
 * @property {number} chartMaxRlt - 该谱面理论最大 Reality
 * @property {boolean} achievable - 是否可达（目标分数 <= 1010000）
 * @property {string} caseType - "in_b20" | "out_b20" | "no_b20"
 * @property {number} b20BottomRlt - B20 第20位 Reality（仅 caseType=out_b20 时有意义）
 */

/**
 * 计算推分建议
 * @param {object} params
 * @param {number} params.currentReality - 当前 B20 Reality（原始值）
 * @param {object[]} params.b20Scores - B20 成绩列表（至少20条，按 Reality 降序）
 * @param {string} params.targetChartId - 目标谱面 chart_id
 * @param {number} params.chartDifficulty - 目标谱面定数
 * @param {number} [params.chartBestScore=0] - 玩家在此谱面的最高分
 * @param {number} [params.chartBestReality=0] - 玩家在此谱面的最高 Reality
 * @returns {PushSuggestion|null} 推分建议，null 表示无法计算
 */
export function calcPushSuggestion(params) {
    const {
        currentReality,
        b20Scores,
        targetChartId,
        chartDifficulty,
        chartBestScore = 0,
        chartBestReality = 0
    } = params

    if (!b20Scores || b20Scores.length === 0) return null
    if (chartDifficulty < 1e-3) return null

    // 1. 计算当前显示 Reality 和目标的原始 Reality
    const currentDisplay = roundDisplay(currentReality)
    const targetDisplayVal = currentDisplay + 0.01
    // 目标原始 Reality：至少需要达到 currentDisplay + 0.005（使四舍五入到 targetDisplay）
    const effectiveDelta = Math.max(0, (currentDisplay + 0.005) - currentReality)

    // 理论最大 Reality
    const chartMaxRlt = chartDifficulty + 1.5

    // 2. 判断谱面是否在 B20 内
    const b20TopN = b20Scores.slice(0, Math.min(20, b20Scores.length))
    const inB20Index = b20TopN.findIndex(s => s.chart_id === targetChartId)
    const inB20 = inB20Index >= 0

    // B20 第20位 Reality
    const b20Count = Math.min(20, b20Scores.length)
    const b20BottomRlt = b20Count > 0 ? b20Scores[b20Count - 1]._reality || 0 : 0

    let targetChartRlt, targetScore, caseType, achievable

    if (inB20) {
        // === 情况1: 谱面在 B20 内 ===
        caseType = 'in_b20'
        // new_rlt >= old_rlt + delta * 20
        targetChartRlt = chartBestReality + effectiveDelta * 20

        if (targetChartRlt <= chartBestReality) {
            targetChartRlt = chartBestReality
        }

        if (targetChartRlt > chartMaxRlt) {
            achievable = false
            targetChartRlt = chartMaxRlt
            targetScore = 1000000
        } else {
            achievable = true
            targetScore = reverseRealityV3(targetChartRlt, chartDifficulty)
            if (targetScore === null || targetScore > 1010000) {
                achievable = false
                targetScore = Math.min(targetScore || 1010000, 1010000)
            }
        }
    } else {
        // === 情况2: 谱面不在 B20 内 ===
        caseType = 'out_b20'
        // new_rlt >= 20th_rlt + delta * 20
        targetChartRlt = b20BottomRlt + effectiveDelta * 20

        if (targetChartRlt <= b20BottomRlt) {
            targetChartRlt = b20BottomRlt + 0.0001 // 至少稍微超过第20位
        }

        if (targetChartRlt > chartMaxRlt) {
            achievable = false
            targetChartRlt = chartMaxRlt
            targetScore = 1000000
        } else {
            achievable = true
            targetScore = reverseRealityV3(targetChartRlt, chartDifficulty)
            if (targetScore === null || targetScore > 1010000) {
                achievable = false
                targetScore = Math.min(targetScore || 1010000, 1010000)
            }
        }
    }

    return {
        currentReality,
        currentDisplay: currentDisplay.toFixed(2),
        targetDisplay: targetDisplayVal.toFixed(2),
        deltaNeeded: effectiveDelta,
        inB20,
        currentChartRlt: chartBestReality,
        targetChartRlt,
        targetScore,
        chartDifficulty,
        chartMaxRlt,
        achievable,
        caseType,
        b20BottomRlt
    }
}

/**
 * 将原始 Reality 转为游戏内显示值（四舍五入到2位小数）
 * @param {number} r - 原始 Reality
 * @returns {number}
 */
function roundDisplay(r) {
    return Math.round(r * 100) / 100
}

export default { calcPushSuggestion, reverseRealityV3 }
