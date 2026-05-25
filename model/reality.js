/**
 * Reality 计算公式 (Milthm)
 * B20 = sum(single_rlt(i)) / 20
 */

/**
 * 从 game_version 字符串中提取主版本号
 * 示例: "v4.4.2+--1da9fc23" -> 4.4
 * @param {string} versionStr
 * @returns {number}
 */
function parseGameVersion(versionStr) {
    if (!versionStr) return 5.0  // 默认新版本
    let match = versionStr.match(/v?(\d+)\.(\d+)/)
    if (!match) return 5.0
    return parseFloat(match[1] + '.' + match[2])
}

/**
 * Reality v3 公式
 * @param {number} score - 分数 0~1010000
 * @param {number} c - 谱面定数
 * @returns {number}
 */
function realityv3(score, c) {
    if (c < 1e-3) return 0;
    if (score >= 1000000) return c + 1.5;
    if (score >= 850000) return c + (score - 850000) / 100000.0;
    if (score >= 700000) return Math.max(0, c * (0.5 + (score - 700000) / 300000.0) + (score - 850000) / 100000.0);
    if (score >= 600000) return Math.max(0, (c - 3) * (score - 600000) / 200000.0);
    return 0;
}

/**
 * Reality v2 公式（旧版兼容）
 * @param {number} score
 * @param {number} c
 * @returns {number}
 */
function realityv2(score, c) {
    if (c < 1e-3) return 0;
    if (score >= 1005000) return 1 + c;
    if (score >= 995000) return 1.4 / (Math.exp(363.175 - score * 0.000365) + 1) - 0.4 + c;
    if (score >= 980000) return ((Math.exp(3.1 * (score - 980000) / 15000) - 1) / (Math.exp(3.1) - 1)) * 0.8 - 0.5 + c;
    if (score >= 700000) return score / 280000 - 4 + c;
    return 0;
}

/**
 * 计算单曲 Reality
 * 规则：
 *   旧版 (gameVersion < 4.0)：分数 > 1005000 或 AP(acc=100%) → v3公式，否则 v2
 *   新版 (gameVersion >= 4.0)：分数 > 1005000 或 AP → v3公式，否则 v2+v3 混合取最大值
 * @param {number} score
 * @param {number} c - 定数
 * @param {number} [gameVersion=5.0] - 游戏版本号
 * @param {number} [accuracy=0] - 准确率 (0~1)，用于判断 AP
 * @returns {number}
 */
function calcReality(score, c, gameVersion = 5.0, accuracy = 0) {
    let isAP = accuracy >= 0.9999
    let v3 = realityv3(score, c)

    if (gameVersion >= 4.0) {
        // 新版：只有分数 <= 1005000 且非 AP 时才混合 v2+v3 取最大值
        if (score <= 1005000 && !isAP) {
            let v2 = realityv2(score, c)
            return Math.max(v3, v2)
        }
        return v3
    }

    // 旧版：分数 > 1005000（v2上限）或 AP 时直接用 v3
    if (score > 1005000 || isAP) {
        return v3
    }
    return realityv2(score, c)
}

/**
 * 计算 B20 Reality
 * @param {Array<{score: number, difficulty: number}>} scores - 成绩列表（已排序，取前20）
 * @returns {number}
 */
function calcB20Reality(scores) {
    if (!scores || scores.length === 0) return 0;
    let top20 = scores.slice(0, Math.min(20, scores.length));
    let sum = 0;
    for (let s of top20) {
        sum += calcReality(s.score, s.difficulty);
    }
    return sum / 20;
}

export {
    parseGameVersion,
    realityv3,
    realityv2,
    calcReality,
    calcB20Reality
}
