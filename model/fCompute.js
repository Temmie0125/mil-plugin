/** Milthm 难度等级名称 */
const Level = ['Drizzle', 'Sprinkle', 'Cloudburst', 'Clear', 'Special']
/** 难度索引映射 */
const LevelNum = { 'Drizzle': 0, 'Sprinkle': 1, 'Cloudburst': 2, 'Clear': 3, 'Special': 4 }
/** 难度缩写映射 */
const LevelAbbr = { 'Drizzle': 'DZ', 'Sprinkle': 'SK', 'Cloudburst': 'CB', 'Clear': 'CL', 'Special': 'SP' }
/** 最大定数 */
const MAX_DIFFICULTY = 16.0

/**
 * 根据分数计算评级 (Milthm rating)
 * @param {number} score 分数 0~1010000
 * @returns {string} 评级: R, M, SS, S, A, B, C, F
 */
function getScoreGrade(score) {
    if (score == 1010000) return 'R'
    if (score >= 1000000) return 'M'
    if (score >= 950000) return 'SS'
    if (score >= 850000) return 'S'
    if (score >= 750000) return 'A'
    if (score >= 650000) return 'B'
    if (score >= 600000) return 'C'
    return 'F'
}

/**
 * 根据判定计算特殊评级
 * @param {number} score
 * @param {number} combo - 实际combo
 * @param {number} totalCombo - 总combo
 * @param {number} bad - Bad判定数
 * @param {number} miss - Miss判定数
 * @param {boolean} isAllExact - 是否全部Exact
 * @param {boolean} isAllPerfectOrExact - 是否全部Perfect或Exact
 * @returns {{ grade: string, iconName: string }}
 */
function getGrade(score, combo, totalCombo, bad, miss, isAllExact = false, isAllPerfectOrExact = false) {
    // R评: 全Exact, 1010000分
    if (isAllExact && score >= 1010000) {
        return { grade: 'R', iconName: 'R' }
    }

    // AP: 全Perfect/Exact 但未达R
    if (isAllPerfectOrExact && !isAllExact) {
        let scoreGrade = getScoreGrade(score)
        return { grade: 'AP', iconName: `AP${scoreGrade}` }
    }
    if (isAllPerfectOrExact && score < 1010000) {
        let scoreGrade = getScoreGrade(score)
        return { grade: 'AP', iconName: `AP${scoreGrade}` }
    }

    // FC: 无Bad/Miss
    let isFC = (bad === 0 && miss === 0) || combo >= totalCombo
    if (isFC && !isAllPerfectOrExact) {
        let scoreGrade = getScoreGrade(score)
        return { grade: 'FC', iconName: `FC${scoreGrade}` }
    }

    // 仅有分数评级
    let scoreGrade = getScoreGrade(score)
    return { grade: scoreGrade, iconName: scoreGrade }
}

/**
 * 成绩图标路径
 * @param {string} iconName
 * @returns {string}
 */
function getIconPath(iconName) {
    const pluginPath = `${process.cwd()}/plugins/mil-plugin`
    return `${pluginPath}/resources/icon/${iconName}.png`
}

export default {
    Level,
    LevelNum,
    LevelAbbr,
    MAX_DIFFICULTY,
    getScoreGrade,
    getGrade,
    getIconPath,

    objectKeys(obj) {
        if (!obj) return []
        return Object.keys(obj)
    },

    randBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min
    },

    formatDate(dateStr) {
        if (!dateStr) return ''
        try {
            let d = new Date(dateStr)
            if (isNaN(d.getTime())) return dateStr
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
        } catch {
            return dateStr
        }
    },

    formatTime(seconds) {
        let min = Math.floor(seconds / 60)
        let sec = Math.floor(seconds % 60)
        return `${min}:${String(sec).padStart(2, '0')}`
    },

    /**
     * 模糊搜索
     * @param {string} query
     * @param {Record<string, any>} dict
     * @returns {{ key: string, value: any }[]}
     */
    fuzzySearch(query, dict) {
        if (!query) return []
        let results = []
        query = query.toLowerCase()
        for (let key of Object.keys(dict)) {
            if (key.toLowerCase().includes(query)) {
                results.push({ key, value: dict[key] })
            }
        }
        return results
    },

    /**
     * 将多个别名匹配结果转为消息文本
     * @param {string[]} ids
     * @returns {string}
     */
    mutiNick(ids) {
        return ids.map((id, i) => `${i + 1}. ${id}`).join('\n')
    },

    /**
     * 生成1 good判定下的成绩 (936600 / 961800 / 987000)
     * @param {number} score
     * @param {number} comboTotal
     * @returns {boolean}
     */
    comJust1Good(score, comboTotal) {
        if (comboTotal <= 0) return false
        let possible = [936600, 961800, 987000]
        return possible.includes(score)
    },

    /**
     * 获取bpm显示字符串
     * @param {any[]} bpmInfo
     * @returns {string}
     */
    getBpmStr(bpmInfo) {
        if (!bpmInfo || !bpmInfo.length) return ''
        let bpmValues = bpmInfo.map(info => info.bpm).filter(b => b != null)
        if (bpmValues.length === 0) return ''
        let minBpm = Math.min(...bpmValues)
        let maxBpm = Math.max(...bpmValues)
        if (minBpm === maxBpm) return `${minBpm}`
        return `${minBpm}~${maxBpm}`
    }
}
