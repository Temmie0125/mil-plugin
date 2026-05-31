/**
 * Milthm 存档更新记录管理器
 * 
 * 管理每个用户的存档更新历史：
 * - 每次导入存档或云端更新时，比对旧存档与新存档的差异
 * - 即使无变化也会记录一条「空变化」条目用于 Reality 曲线
 * - 首次导入时取新存档中 Reality 最高的 10 首作为展示
 * - 记录每次更新时的 Reality 值用于绘制折线图（不管是否变化）
 * - 存储为 user_id.json 在 data/updates/ 目录下
 * - 更新记录永久保留在磁盘文件中
 * - Guoba 配置项 maxUpdateEntries（10~99）控制 update 界面展示的曲目卡片最大数量
 * - Reality 变动曲线始终使用完整历史数据绘制，不受展示限制影响
 */
import fs from 'fs'
import getInfo from './getInfo.js'
import fCompute from './fCompute.js'
import { calcReality, parseGameVersion } from './reality.js'
import Config from '../components/Config.js'
import logger from '../components/Logger.js'

const UPDATE_DIR = `${process.cwd()}/plugins/mil-plugin/data/updates`

/**
 * BestLevel → 评级映射 (saves.db)
 */
const BEST_LEVEL_GRADE = ['R', 'M', 'SS', 'S', 'A', 'B', 'C', 'F']

export default class UpdateLog {

    /**
     * @param {string} userId
     */
    constructor(userId) {
        this.userId = userId
        /** @type {string} 更新日志文件路径 */
        this.logPath = `${UPDATE_DIR}/${userId}.json`
        /** @type {object[]} 更新历史数组（最新在前） */
        this.history = []
    }

    /**
     * 确保目录存在
     */
    static ensureDir() {
        if (!fs.existsSync(UPDATE_DIR)) {
            fs.mkdirSync(UPDATE_DIR, { recursive: true })
        }
    }

    /**
     * 获取最大保留条数（10~99，默认30）
     * @returns {number}
     */
    getMaxEntries() {
        let val = parseInt(String(Config.getUserCfg('config', 'maxUpdateEntries') || '30'))
        if (isNaN(val) || val < 10) val = 10
        if (val > 99) val = 99
        return val
    }

    /**
     * 加载更新历史
     * @returns {object[]}
     */
    load() {
        try {
            if (fs.existsSync(this.logPath)) {
                let raw = fs.readFileSync(this.logPath, 'utf8')
                let data = JSON.parse(raw)
                this.history = Array.isArray(data.history) ? data.history : []
                // 自动修复存量错误评级
                let fixed = this.repairGrades()
                if (fixed > 0) logger.mark(`[mil-plugin] 修复 ${this.userId} 的更新历史评级: ${fixed} 条`)
            }
        } catch (e) {
            logger.error(`[mil-plugin] 加载更新日志失败 (${this.userId}):`, e.message)
            this.history = []
        }
        return this.history
    }

    /**
     * 修复存量更新历史中的错误评级图标，并迁移旧数据格式
     * - 基于分数和 accuracy 重新计算 afterGrade/afterGradeLabel 和 beforeGrade
     * - 修复旧代码中 totalChanges/_allChangesCount 被错误截断的问题（首次导入）
     * @returns {number} 修复/迁移的条目数
     */
    repairGrades() {
        if (this.history.length === 0) return 0
        let fixed = 0

        for (let entry of this.history) {
            // 修复字段名错误：旧代码误写为 entry.cards，实际应为 entry.changes
            let cards = entry.changes
            if (!entry || !Array.isArray(cards)) continue

            // 迁移旧数据：首次导入的 totalChanges 曾被 Math.min(scored.length, 6) 截断
            // 由于原始总数无法恢复，至少确保与 changes 实际条数一致
            if (entry._isFirstImport && entry.totalChanges != null && entry.totalChanges < cards.length) {
                entry.totalChanges = cards.length
                entry._allChangesCount = cards.length
                fixed++
            }

            for (let card of cards) {
                let newAfterGrade = this._calcGradeFromScoreAcc(card.afterScore || 0, card.afterAccuracy || 0)
                if (card.afterGrade !== newAfterGrade.iconName || card.afterGradeLabel !== newAfterGrade.grade) {
                    card.afterGrade = newAfterGrade.iconName
                    card.afterGradeLabel = newAfterGrade.grade
                    fixed++
                }
                // 也修复 beforeGrade（如果有旧分数）
                if (card.beforeScore != null && card.beforeAccuracy != null && !card.isNew) {
                    let newBeforeGrade = this._calcGradeFromScoreAcc(card.beforeScore, card.beforeAccuracy)
                    if (card.beforeGrade !== newBeforeGrade.iconName) {
                        card.beforeGrade = newBeforeGrade.iconName
                        fixed++
                    }
                }
            }
        }

        if (fixed > 0) this.save()
        return fixed
    }

    /**
     * 从分数和 accuracy 推算评级（用于存量修复，无原始记录细节）
     */
    _calcGradeFromScoreAcc(score, accuracy) {
        let scoreGrade = fCompute.getScoreGrade(score)
        let isAP = (accuracy || 0) >= 0.9999
        let isR = score >= 1010000

        if (isR) return { grade: 'R', iconName: 'R' }
        if (isAP) return { grade: 'AP', iconName: 'AP' + scoreGrade }
        // FC 无法从存量数据判断，仅按分数评级
        return { grade: scoreGrade, iconName: scoreGrade }
    }

    /**
     * 保存到文件
     */
    save() {
        UpdateLog.ensureDir()
        try {
            // 更新记录永久保留，不再按 maxUpdateEntries 截断
            fs.writeFileSync(this.logPath, JSON.stringify({
                history: this.history,
                updatedAt: new Date().toISOString()
            }, null, '\t'))
        } catch (e) {
            logger.error(`[mil-plugin] 保存更新日志失败 (${this.userId}):`, e.message)
        }
    }

    /**
     * 获取历史 Reality 序列（用于绘制曲线）
     * 返回 [日期字符串, Reality值] 的数组，按时间正序
     * 每个更新事件都会产生一个点（Reality 不变就构成水平线）
     * @returns {Array<[string, number]>}
     */
    getRealityHistory() {
        if (this.history.length === 0) return []
        // history 已按时间倒序存储（最新在前），反转后即为正序
        let reversed = [...this.history].reverse()
        return reversed.map(entry => [entry.date, entry.afterReality])
    }

    /**
     * 是否有更新历史（即不是首次导入）
     * @returns {boolean}
     */
    hasHistory() {
        return this.history.length > 0
    }

    /**
     * 添加一条更新记录到历史最前面
     * @param {object} entry
     */
    prepend(entry) {
        this.history.unshift(entry)
        this.save()
    }

    // ==================== 核心：创建更新条目 ====================

    /**
     * 创建一次更新条目（每次导入/更新都必须调用）
     * 
     * - 首次导入（无旧成绩）：取新存档中 Reality 最高的 N 首作为展示
     * - 后续更新：比对差异，生成条目（差异可能为空）
     * 
     * @param {object[]|null} oldScores - 旧成绩列表（null = 首次导入）
     * @param {object[]} newScores - 新成绩列表
     * @param {string} username - 玩家名
     * @param {string} dateStr - 日期字符串
     * @returns {object} 永远返回一个有效条目
     */
    createEntry(oldScores, newScores, username, dateStr) {
        if (!oldScores || oldScores.length === 0) {
            // 首次导入：取最高 Reality 的 10 首
            return this._createFirstImportEntry(newScores, username, dateStr)
        }

        // 有旧成绩：执行 diff
        return this._createDiffEntry(oldScores, newScores, username, dateStr)
    }

    /**
     * 首次导入条目：取新存档 Reality 最高的 N 首
     * @param {object[]} newScores
     * @param {string} username
     * @param {string} dateStr
     * @returns {object}
     */
    _createFirstImportEntry(newScores, username, dateStr) {
        let reality = this._calcRealityFromScores(newScores)
        let starLevel = this._calcStarLevel(newScores)

        // 计算每条记录的 Reality 并按降序排序，取前 10
        let scored = newScores.map(s => {
            let rlt, difficulty
            if (s._nyaSingleRating != null) {
                rlt = s._nyaSingleRating
                difficulty = s._nyaDifficulty || 0
            } else {
                difficulty = 0
                let songKey = getInfo.chartIdToSongKey(s.chart_id)
                if (songKey) {
                    let info = getInfo.info(songKey)
                    if (info) {
                        for (let level of fCompute.Level) {
                            if (info.chart[level]?.chartid === s.chart_id) {
                                difficulty = info.chart[level].difficulty || 0
                                break
                            }
                        }
                    }
                }
                let gameVer = parseGameVersion(s.game_version)
                rlt = calcReality(s.score, difficulty, gameVer, s.score_accuracy)
            }
            return { ...s, _rlt: rlt, _diff: difficulty }
        })

        // 按 Reality 降序
        scored.sort((a, b) => b._rlt - a._rlt || b.score - a.score)

        // 按 chart_id 去重取前 10（避免同谱面 V2/V3 重复展示）
        let seenCharts = new Set()
        let displayList = []
        for (let s of scored) {
            if (seenCharts.has(s.chart_id)) continue
            seenCharts.add(s.chart_id)
            displayList.push(s)
            if (displayList.length >= 10) break
        }

        let changes = displayList.map(s => this._buildSongDiff(s, null, s._diff))

        // 兜底：如果 changes 为空但有数据，用第 1 条强制构建
        if (changes.length === 0 && scored.length > 0) {
            let fallback = this._buildSongDiff(scored[0], null, scored[0]._diff)
            changes = [fallback]
        }

        return {
            date: dateStr,
            username,
            beforeReality: reality,
            afterReality: reality,
            realityDelta: 0,
            starLevel,
            totalChanges: scored.length,
            changes,
            _allChangesCount: scored.length,
            _isFirstImport: true
        }
    }

    /**
     * 比对两组成绩并创建更新条目
     * 即使没有变化也返回有效条目（changes=[]），确保曲线有数据点
     * @param {object[]} oldScores
     * @param {object[]} newScores
     * @param {string} username
     * @param {string} dateStr
     * @returns {object}
     */
    _createDiffEntry(oldScores, newScores, username, dateStr) {
        let oldMap = {}
        for (let s of oldScores) {
            let key = s.chart_id
            if (!oldMap[key] || s.score > oldMap[key].score) {
                oldMap[key] = s
            }
        }

        let newMap = {}
        for (let s of newScores) {
            let key = s.chart_id
            if (!newMap[key] || s.score > newMap[key].score) {
                newMap[key] = s
            }
        }

        let changes = []
        for (let [chartId, newRec] of Object.entries(newMap)) {
            let oldRec = oldMap[chartId]
            if (!oldRec) {
                changes.push(this._buildSongDiff(newRec, null))
            } else if (newRec.score > oldRec.score) {
                changes.push(this._buildSongDiff(newRec, oldRec))
            }
            // 分数未变则跳过
        }

        // 按 Reality 提升量排序（降序），再按分数差
        changes.sort((a, b) => {
            let da = (b.afterReality - b.beforeReality) - (a.afterReality - a.beforeReality)
            if (da !== 0) return da
            return (b.afterScore - b.beforeScore) - (a.afterScore - a.beforeScore)
        })

        let oldReality = this._calcRealityFromScores(oldScores)
        let newReality = this._calcRealityFromScores(newScores)
        let starLevel = this._calcStarLevel(newScores)

        // 分离新谱面和已变化谱面，确保新谱面（含无定数特殊谱面）至少展示 1 首
        let changedEntries = changes.filter(c => !c.isNew)
        let newEntries = changes.filter(c => c.isNew)

        newEntries.sort((a, b) => b.afterScore - a.afterScore)

        let displayChanges = changedEntries.slice(0, 9)
        if (newEntries.length > 0) {
            displayChanges = displayChanges.concat(newEntries.slice(0, Math.max(1, 10 - displayChanges.length)))
        }
        if (displayChanges.length < 10) {
            displayChanges = changes.slice(0, 10)
        }

        return {
            date: dateStr,
            username,
            beforeReality: oldReality,
            afterReality: newReality,
            realityDelta: newReality - oldReality,
            starLevel,
            totalChanges: changes.length,
            changes: displayChanges,
            _allChangesCount: changes.length,
            _isFirstImport: false
        }
    }

    // ==================== 单曲 diff 构建 ====================

    /**
     * 构建单首曲目的 diff 信息
     * @param {object} newRec - 新成绩
     * @param {object|null} oldRec - 旧成绩（null=全新/首次导入）
     * @param {number} [knownDifficulty] - 预先计算好的 difficulty（避免重复查表）
     * @returns {object}
     */
    _buildSongDiff(newRec, oldRec, knownDifficulty) {
        let songKey = getInfo.chartIdToSongKey(newRec.chart_id)
        let songName = newRec._nyaSongName || newRec.chart_id
        let illustration = ''
        let diffLevel = 'Drizzle'
        let difficulty = knownDifficulty || 0

        // 根据 Nya category 代码推算难度名称
        let c2l = { 'DZ': 'Drizzle', 'SK': 'Sprinkle', 'CB': 'Cloudburst', 'CL': 'Clear', 'SP': 'Special' }
        if (newRec._nyaCategory && c2l[newRec._nyaCategory]) {
            diffLevel = c2l[newRec._nyaCategory]
            if (!knownDifficulty) difficulty = newRec._nyaDifficulty || 0
        }

        if (songKey) {
            let info = getInfo.info(songKey)
            if (info) {
                if (!newRec._nyaSongName) songName = info.song || songKey
                illustration = info.illustration || ''
                if (!knownDifficulty && diffLevel === 'Drizzle') {
                    for (let level of fCompute.Level) {
                        if (info.chart[level]?.chartid === newRec.chart_id) {
                            diffLevel = level
                            difficulty = info.chart[level].difficulty || 0
                            break
                        }
                    }
                } else if (diffLevel === 'Drizzle') {
                    // difficulty 已有，但还需要 level 名
                    for (let level of fCompute.Level) {
                        if (info.chart[level]?.chartid === newRec.chart_id) {
                            diffLevel = level
                            break
                        }
                    }
                }
            }
        }

        // Reality：Nya Profiler 使用预计算值，其余走公式
        let newRlt, oldRlt
        if (newRec._nyaSingleRating != null) {
            newRlt = newRec._nyaSingleRating
            oldRlt = oldRec ? (oldRec._nyaSingleRating || 0) : 0
        } else {
            let gameVer = parseGameVersion(newRec.game_version)
            newRlt = calcReality(newRec.score, difficulty, gameVer, newRec.score_accuracy)
            oldRlt = oldRec
                ? calcReality(oldRec.score, difficulty, parseGameVersion(oldRec.game_version), oldRec.score_accuracy)
                : 0
        }

        let oldScore = oldRec ? oldRec.score : 0
        let oldAcc = oldRec ? (oldRec.score_accuracy || 0) : 0

        let gradeInfo = this._getGradeForRecord(newRec)
        let oldGradeInfo = oldRec ? this._getGradeForRecord(oldRec) : null

        return {
            chart_id: newRec.chart_id,
            song: songName,
            illustration,
            level: diffLevel,
            levelAbbr: fCompute.LevelAbbr[diffLevel] || diffLevel,
            difficulty,
            beforeScore: oldScore,
            afterScore: newRec.score,
            beforeAccuracy: oldAcc,
            afterAccuracy: newRec.score_accuracy || 0,
            beforeReality: oldRlt,
            afterReality: newRlt,
            beforeGrade: oldGradeInfo ? oldGradeInfo.iconName : null,
            afterGrade: gradeInfo.iconName,
            afterGradeLabel: gradeInfo.grade,
            isNew: !oldRec
        }
    }

    /**
     * 根据记录获取评级图标
     * @param {object} record
     * @returns {{grade: string, iconName: string}}
     */
    _getGradeForRecord(record) {
        // scoreGrade 优先取 saves.db 的 BestLevel，其次按分数算
        let scoreGrade = (record._bestLevel != null && BEST_LEVEL_GRADE[record._bestLevel])
            || fCompute.getScoreGrade(record.score)

        // AP 检测：accuracy >= 0.9999
        let isAP = (record.score_accuracy || 0) >= 0.9999

        // FC 检测：saves/nya 用 _achievedStatus，cloud 用判定计数
        let isFC
        if (record._source === 'saves' || record._source === 'nya_profiler') {
            isFC = Array.isArray(record._achievedStatus) && record._achievedStatus.includes(4)
        } else {
            isFC = (record.score_bad_count || 0) === 0 && (record.score_miss_count || 0) === 0
        }

        // R 评：BestLevel=0 或分数=1010000
        if (record._bestLevel === 0 || record.score === 1010000) {
            return { grade: 'R', iconName: 'R' }
        }
        if (isAP) {
            return { grade: 'AP', iconName: 'AP' + scoreGrade }
        }
        if (isFC) {
            return { grade: 'FC', iconName: 'FC' + scoreGrade }
        }
        return { grade: scoreGrade, iconName: scoreGrade }
    }

    // ==================== 辅助计算 ====================

    /**
     * 计算给定成绩列表的 B20 Reality
     * @param {object[]} scores
     * @returns {number}
     */
    _calcRealityFromScores(scores) {
        if (!scores || scores.length === 0) return 0

        let perChart = {}
        for (let s of scores) {
            let rlt

            if (s._nyaSingleRating != null) {
                rlt = s._nyaSingleRating
            } else {
                let songKey = getInfo.chartIdToSongKey(s.chart_id)
                if (!songKey) continue
                let info = getInfo.info(songKey)
                if (!info) continue

                let difficulty = 0
                for (let level of fCompute.Level) {
                    if (info.chart[level]?.chartid === s.chart_id) {
                        difficulty = info.chart[level].difficulty || 0
                        break
                    }
                }
                if (difficulty <= 0) continue

                let gameVer = parseGameVersion(s.game_version)
                rlt = calcReality(s.score, difficulty, gameVer, s.score_accuracy)
            }

            if (!perChart[s.chart_id] || rlt > perChart[s.chart_id]) {
                perChart[s.chart_id] = rlt
            }
        }

        let rlts = Object.values(perChart).sort((a, b) => b - a)
        let top20 = rlts.slice(0, 20)
        return top20.length > 0
            ? top20.reduce((sum, v) => sum + v, 0) / top20.length
            : 0
    }

    /**
     * 计算星星等级
     * @param {object[]} scores
     * @returns {number}
     */
    _calcStarLevel(scores) {
        let starLevel = 0
        for (let record of scores) {
            let songKey = getInfo.chartIdToSongKey(record.chart_id)
            if (!songKey) continue
            let info = getInfo.info(songKey)
            if (!info) continue

            let difficulty = 0
            for (let level of fCompute.Level) {
                if (info.chart[level]?.chartid === record.chart_id) {
                    difficulty = info.chart[level].difficulty || 0
                    break
                }
            }

            let isAP = record.score_accuracy >= 0.9999
            let isR = record._bestLevel === 0

            if (isAP || isR) {
                if (difficulty >= 12.0) starLevel = Math.max(starLevel, 3)
                else if (difficulty >= 9.0) starLevel = Math.max(starLevel, 2)
                else if (difficulty >= 6.0) starLevel = Math.max(starLevel, 1)
            }
        }
        return starLevel
    }
}
