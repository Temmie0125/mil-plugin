/**
 * Milthm 存档解析管理器
 * 解析用户上传的 .db 格式存档文件 (SQLite)
 * 支持两种格式：
 *   - data.db   : 含 score 表的传统存档（有详细判定数据）
 *   - saves.db  : 含 kv 表的新版存档（BestLevel 更精确，但无判定细节）
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import fCompute from './fCompute.js'
import { calcReality, calcB20Reality, parseGameVersion } from './reality.js'
import Config from '../components/Config.js'
import getInfo from './getInfo.js'

/**
 * BestLevel → 评级映射 (saves.db)
 * 0=R, 1=M, 2=SS, 3=S, 4=A, 5=B, 6=C, 7=F
 */
const BEST_LEVEL_GRADE = ['R', 'M', 'SS', 'S', 'A', 'B', 'C', 'F']

export default class SaveManager {
    /**
     * @param {string} userId - QQ号
     */
    constructor(userId) {
        this.userId = userId
        /** @type {string} 存档文件路径 */
        this.savePath = `${process.cwd()}/plugins/mil-plugin/data/saves/${userId}.db`
        /** @type {string} 缓存数据路径 */
        this.cachePath = `${process.cwd()}/plugins/mil-plugin/data/saves/${userId}.json`
        /** @type {any[]} 成绩数据 */
        this.scores = []
        /** @type {string} 用户名 */
        this.username = ''
        /** @type {string} 用户ID */
        this.user_id = ''
        /** @type {'unknown'|'data'|'saves'|'nya_profiler'} 存档来源类型 */
        this.saveType = 'unknown'
        /** @type {object|null} Nya Profiler chartProgress（谱面完成统计） */
        this.nyaChartProgress = null
        /** @type {number|null} Nya Profiler starCount（星级） */
        this.nyaStarCount = null
        /** @type {number|null} 云端 Rank 接口返回的 Reality（用于与本地计算结果比对，兼容旧格式） */
        this.cloudRankReality = null
        /** @type {object|null} 云端 Recent 接口返回的最近一条游玩记录（预适配 recent 功能，兼容旧格式） */
        this.cloudRecentPlay = null
        /** @type {{touch: {rankReality: number|null, recentPlay: object|null}, keyboard: {rankReality: number|null, recentPlay: object|null}}} 按平台分开的云端数据 */
        this.cloudData = {
            touch: { rankReality: null, recentPlay: null },
            keyboard: { rankReality: null, recentPlay: null }
        }
        /** @type {string|null} Milthm 云用户名（用于 Rank/Recent 接口，获取后持久化缓存） */
        this.cloudUsername = null
    }

    /**
     * 检查是否有存档
     * @returns {boolean}
     */
    hasSave() {
        return fs.existsSync(this.savePath)
    }

    /**
     * 从上传的文件路径导入存档
     * @param {string} filePath - 上传文件的临时路径
     * @returns {Promise<{success: boolean, msg: string, username?: string}>}
     */
    async importSave(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, msg: '文件不存在，请重新上传！' }
            }

            // 预检：读取文件头部用于诊断
            let fileStat = fs.statSync(filePath)
            let headBuf = Buffer.alloc(Math.min(100, fileStat.size))
            let fd = fs.openSync(filePath, 'r')
            fs.readSync(fd, headBuf, 0, headBuf.length, 0)
            fs.closeSync(fd)
            let headHex = headBuf.toString('hex')
            let headText = headBuf.toString('utf8').replace(/[\x00-\x1f]/g, '.')
            let isSQLite = headHex.startsWith('53514c697465') // "SQLite" magic header
            let isJSON = headText.trimStart().startsWith('{')
            logger.debug(`[mil-plugin] 导入存档预检:`, {
                filePath,
                size: fileStat.size,
                headHex,
                headText: headText.substring(0, 100),
                isSQLite,
                isJSON
            })

            // 确保目录存在
            let saveDir = `${process.cwd()}/plugins/mil-plugin/data/saves`
            if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true })
            }

            // 复制文件到存档目录
            fs.copyFileSync(filePath, this.savePath)

            // 尝试解析
            let result = this.parseSave()
            if (result.success) {
                // 缓存解析后的数据
                this.saveCache()
                return { success: true, msg: '存档导入成功！', username: result.username, saveType: result.saveType }
            } else {
                // 解析失败则删除存档
                fs.unlinkSync(this.savePath)
                return result
            }
        } catch (e) {
            logger.error(`[mil-plugin] 导入存档失败:`, e)
            // 清理失败的文件
            try { if (fs.existsSync(this.savePath)) fs.unlinkSync(this.savePath) } catch { }
            return { success: false, msg: `导入失败：${e.message}` }
        }
    }

    /**
     * 解析存档文件（自动检测 data.db / saves.db 格式）
     * @returns {{success: boolean, msg?: string, username?: string, saveType?: string}}
     */
    parseSave() {
        let db
        try {
            db = new DatabaseSync(this.savePath, { readOnly: true })

            let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            let tableNames = tables.map(t => t.name)

            // 检测 saves.db 格式（含 kv 表）
            let hasKvTable = tableNames.includes('kv')

            // 检测 data.db 格式（含 score / 1 / scores 表）
            let hasScoreTable = tableNames.some(n => n === 'score' || n === '1' || n === 'scores')

            if (hasKvTable) {
                // ========== saves.db 格式（优先） ==========
                return this.parseSavesDB(db)
            } else if (hasScoreTable) {
                // ========== data.db 格式（兼容） ==========
                return this.parseDataDB(db)
            } else {
                return { success: false, msg: '存档格式不正确：未找到成绩数据表！\n请确认是 data.db 或 saves.db 文件。' }
            }
        } catch (e) {
            logger.error(`[mil-plugin] 解析存档出错:`, e)
            return { success: false, msg: `存档解析失败：${e.message}` }
        } finally {
            if (db) {
                try { db.close() } catch { }
            }
        }
    }

    /**
     * 解析 data.db 格式（原始逻辑）
     * @param {DatabaseSync} db
     * @returns {{success: boolean, msg?: string, username?: string}}
     */
    parseDataDB(db) {
        let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()

        let scoreTable = null
        for (let t of tables) {
            if (t.name === 'score' || t.name === '1' || t.name === 'scores') {
                scoreTable = t.name
                break
            }
        }

        if (!scoreTable) {
            return { success: false, msg: '存档格式不正确：未找到成绩数据表！' }
        }

        let rows = db.prepare(`SELECT * FROM [${scoreTable}]`).all()

        if (!rows || rows.length === 0) {
            return { success: false, msg: '存档中没有成绩数据！' }
        }

        this.scores = rows.map(row => ({
            chart_id: row.chart_id,
            score: row.score,
            score_accuracy: row.score_accuracy,
            score_exact_count: row.score_exact_count || 0,
            score_perfect_count: row.score_perfect_count || 0,
            score_good_count: row.score_good_count || 0,
            score_bad_count: row.score_bad_count || 0,
            score_miss_count: row.score_miss_count || 0,
            score_great_count: row.score_great_count || 0,
            score_fracture_exact_count: row.score_fracture_exact_count || 0,
            score_fracture_miss_count: row.score_fracture_miss_count || 0,
            played_at: row.played_at,
            game_version: row.game_version,
            grade: row.grade,
            // 标记来源
            _source: 'data'
        }))

        this.username = rows[0]?.username || 'Unknown'
        this.user_id = rows[0]?.user_id || 'offline'
        this.saveType = 'data'

        // 按谱面去重，保留最高分
        this.deduplicateScores()

        return { success: true, username: this.username, saveType: 'data' }
    }

    /**
     * 解析 saves.db 格式（新版存档，数据更精确）
     * 从 kv 表中读取 JSON 存档，提取 SongRecords + SongRecordsV3
     * @param {DatabaseSync} db
     * @returns {{success: boolean, msg?: string, username?: string, saveType?: string}}
     */
    parseSavesDB(db) {
        // 读取 kv 表所有行
        let rows
        try {
            rows = db.prepare("SELECT key, value FROM kv").all()
        } catch {
            return { success: false, msg: 'saves.db 格式不正确：无法读取 kv 表！' }
        }

        if (!rows || rows.length === 0) {
            return { success: false, msg: 'saves.db 中没有存档数据！' }
        }

        // 遍历所有 kv 行，寻找包含存档 JSON 的行
        let saveData = null
        for (let row of rows) {
            try {
                let parsed = JSON.parse(row.value)
                // 判断是否为玩家存档：包含 SongRecords 或 SongRecordsV3
                if (parsed && (parsed.SongRecords || parsed.SongRecordsV3)) {
                    saveData = parsed
                    break
                }
            } catch {
                // 非 JSON 行，跳过
            }
        }

        if (!saveData) {
            return { success: false, msg: 'saves.db 中未找到玩家存档数据！' }
        }

        return this._processSaveJSON(saveData)
    }

    /**
     * 处理 saves 格式的 JSON 存档数据（SongRecords + SongRecordsV3）
     * 供 parseSavesDB 和 parseJSONSave 共用
     * @param {object} saveData - 已解析的存档 JSON 对象
     * @returns {{success: boolean, msg?: string, username?: string, saveType?: string}}
     */
    _processSaveJSON(saveData) {
        // 提取基本信息
        this.username = saveData.Nickname || saveData.Username || 'Unknown'
        this.user_id = saveData.UserID || 'offline'
        this.saveType = 'saves'

        /** @type {any[]} */
        let rawRecords = []

        /**
         * 将 SongRecord 转为标准成绩格式的辅助函数
         * @param {object} record
         * @param {string} gameVersion - 标记游戏版本用于 Reality 公式选择
         */
        let mapRecord = (record, gameVersion) => ({
            chart_id: record.BeatmapID,
            score: record.BestScore,
            score_accuracy: record.BestAccuracy,
            score_exact_count: 0,
            score_perfect_count: 0,
            score_good_count: 0,
            score_bad_count: 1,
            score_miss_count: 0,
            score_great_count: 0,
            score_fracture_exact_count: 0,
            score_fracture_miss_count: 0,
            played_at: null,
            game_version: gameVersion,
            grade: BEST_LEVEL_GRADE[record.BestLevel] || '',
            _bestLevel: record.BestLevel,
            _achievedStatus: record.AchievedStatus || [],
            _source: 'saves'
        })

        // SongRecords 使用旧版 v2 公式 (game_version 标记为 v3.0, parseGameVersion=3.0 < 4.0)
        if (Array.isArray(saveData.SongRecords)) {
            for (let record of saveData.SongRecords) {
                if (record.BeatmapID) {
                    rawRecords.push(mapRecord(record, 'v3.0'))
                }
            }
        }

        // SongRecordsV3 使用新版 v3 公式 (game_version 标记为 v4.0, parseGameVersion=4.0 >= 4.0)
        if (Array.isArray(saveData.SongRecordsV3)) {
            for (let record of saveData.SongRecordsV3) {
                if (record.BeatmapID) {
                    rawRecords.push(mapRecord(record, 'v4.0'))
                }
            }
        }

        // 按 (chart_id, 版本组) 各自保留最高分
        this.scores = rawRecords
        this.deduplicateScores()

        return {
            success: true,
            username: this.username,
            saveType: 'saves'
        }
    }

    /**
     * 直接解析云存档 JSON（非 SQLite 格式，与 saves.db kv 表内 JSON 结构一致）
     * @param {string} jsonStr - JSON 字符串
     * @returns {{success: boolean, msg?: string, username?: string, saveType?: string}}
     */
    parseJSONSave(jsonStr) {
        let saveData
        try {
            saveData = JSON.parse(jsonStr)
        } catch (e) {
            logger.error('[mil-plugin] 云存档 JSON 解析失败:', e.message)
            return { success: false, msg: `云存档 JSON 解析失败: ${e.message}` }
        }

        if (!saveData || (!saveData.SongRecords && !saveData.SongRecordsV3)) {
            logger.error('[mil-plugin] 云存档 JSON 中未找到成绩数据, 顶层 keys:', saveData ? Object.keys(saveData) : 'null')
            return { success: false, msg: '云存档 JSON 中未找到成绩数据（缺少 SongRecords / SongRecordsV3）' }
        }

        return this._processSaveJSON(saveData)
    }

    /**
     * 版本组辅助：根据 game_version 返回版本分组 key
     * 'old' = v2 公式时代 (game_version < 4.0)
     * 'new' = v3 公式时代 (game_version >= 4.0 或未知)
     * @param {string} gameVersion
     * @returns {'old'|'new'}
     */
    _versionGroup(gameVersion) {
        let v = parseGameVersion(gameVersion)
        return v < 4.0 ? 'old' : 'new'
    }

    /**
     * 从 modifiers 数组检测云端记录的游玩模式
     * Rank API 已通过 touch_ranks/keyboard_ranks 区分，此方法主要用于 Recent API
     * 移动端包含 "TouchMode"，PC 端修饰符未确认，以取反判断
     * @param {string[]} modifiers
     * @returns {'touch'|'keyboard'}
     */
    _detectCloudModeFromModifiers(modifiers) {
        if (modifiers && modifiers.includes('TouchMode')) return 'touch'
        return 'keyboard'
    }

    /**
     * 判断是否为定数明确为 0 的特殊谱面（如教程/剧情谱面）
     * 仅在 info.json 中存在且 difficultyValue 严格为 0 时返回 true
     * @param {string} chartId
     * @returns {boolean}
     */
    _isZeroDiffChart(chartId) {
        let songKey = getInfo.chartIdToSongKey(chartId)
        if (!songKey) return false
        let info = getInfo.info(songKey)
        if (!info) return false
        for (let level of fCompute.Level) {
            if (info.chart[level]?.chartid === chartId) {
                return info.chart[level].difficulty === 0
            }
        }
        return false
    }

    /**
     * 按谱面+版本组去重，同(chart_id, versionGroup)保留最高分
     * 这样同一谱面的旧版和新版分数独立保留，Reality 计算时各取正确公式
     */
    deduplicateScores() {
        let bestScores = {}
        for (let record of this.scores) {
            let versionGroup = this._versionGroup(record.game_version)
            let key = `${record.chart_id}__${versionGroup}`
            if (!bestScores[key] || record.score > bestScores[key].score) {
                bestScores[key] = record
            }
        }
        this.scores = Object.values(bestScores)
    }

    /**
     * 保存缓存数据
     */
    saveCache() {
        let cacheDir = `${process.cwd()}/plugins/mil-plugin/data/saves`
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true })
        }
        let cacheData = {
            username: this.username,
            user_id: this.user_id,
            saveType: this.saveType,
            scores: this.scores,
            nyaChartProgress: this.nyaChartProgress || null,
            nyaStarCount: this.nyaStarCount ?? null,
            cloudRankReality: this.cloudRankReality,
            cloudRecentPlay: this.cloudRecentPlay,
            cloudData: this.cloudData,
            cloudUsername: this.cloudUsername,
            updatedAt: new Date().toISOString()
        }
        fs.writeFileSync(this.cachePath, JSON.stringify(cacheData, null, '\t'))
    }

    /**
     * 从缓存加载
     * @returns {boolean}
     */
    loadCache() {
        if (fs.existsSync(this.cachePath)) {
            try {
                let data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))
                this.username = data.username || ''
                this.user_id = data.user_id || ''
                this.scores = data.scores || []
                this.saveType = data.saveType || 'unknown'
                this.nyaChartProgress = data.nyaChartProgress || null
                this.nyaStarCount = data.nyaStarCount ?? null
                this.cloudRankReality = data.cloudRankReality ?? null
                this.cloudRecentPlay = data.cloudRecentPlay || null
                this.cloudUsername = data.cloudUsername || null

                // 加载 cloudData（新版格式），缺失时从旧字段迁移
                if (data.cloudData) {
                    this.cloudData = data.cloudData
                } else {
                    // 旧格式迁移：将 cloudRankReality 归到 touch（大多数旧数据是移动端玩家）
                    this.cloudData = {
                        touch: { rankReality: data.cloudRankReality ?? null, recentPlay: null },
                        keyboard: { rankReality: null, recentPlay: null }
                    }
                    // 同时将已有的 cloudRecentPlay 挂到 touch 下
                    if (data.cloudRecentPlay) {
                        this.cloudData.touch.recentPlay = data.cloudRecentPlay
                    }
                }

                return true
            } catch (e) {
                return false
            }
        }
        return false
    }

    /**
     * 重新解析存档（缓存失效时）
     */
    refresh() {
        if (this.hasSave()) {
            let result = this.parseSave()
            if (result.success) {
                this.saveCache()
                return true
            }
        }
        return false
    }

    /**
     * 确保数据已加载
     */
    ensureLoaded() {
        if (this.scores.length > 0) return
        if (this.loadCache()) return
        if (this.hasSave()) {
            this.parseSave()
            this.saveCache()
        }
    }

    /**
     * 获取指定谱面的成绩（同谱面有新旧版本时返回最高分记录）
     * @param {string} chartId
     * @returns {object|null}
     */
    getChartScore(chartId) {
        this.ensureLoaded()
        let best = null
        for (let score of this.scores) {
            if (score.chart_id === chartId) {
                if (!best || score.score > best.score) {
                    best = score
                }
            }
        }
        return best
    }

    /**
     * 获取 Best N (按 Reality 从高到低排名)
     * @param {number} n - 数量，默认20
     * @returns {object[]}
     */
    getBestN(n = 20) {
        this.ensureLoaded()
        return this.scores.slice(0, Math.min(n, this.scores.length))
    }

    /**
     * 获取谱面定数（通过 chart_id 映射）
     * @param {string} chartId
     * @param {object} getInfo
     * @returns {number}
     */
    getChartDifficulty(chartId, getInfo) {
        let songKey = getInfo.chartIdToSongKey(chartId)
        if (songKey) {
            let info = getInfo.info(songKey)
            if (info) {
                for (let level of fCompute.Level) {
                    if (info.chart[level]?.chartid === chartId) {
                        return info.chart[level].difficulty || 0
                    }
                }
            }
        }
        return 0
    }

    /**
     * 获取 B20 并计算 Reality
     * 同谱面若有新旧版本记录，分别按对应公式计算 Reality 后取最大值；
     * 再按 Reality 从高到低排序，取前 N 个谱面。
     * @param {number} n
     * @param {object} getInfo - getInfo实例
     * @param {'touch'|'keyboard'|'merge'} mode - 云存档模式过滤，默认 'merge'
     * @returns {{ scores: object[], reality: number }}
     */
    getB20WithReality(n = 20, getInfo, mode = 'merge') {
        this.ensureLoaded()

        // 按模式过滤云端记录：本地存档记录（无 _cloudMode 标记）始终保留
        let filtered = this.scores
        if (mode === 'touch') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'touch')
        } else if (mode === 'keyboard') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'keyboard')
        }
        // mode === 'merge'：不筛选，全部保留

        // 1. 为每条成绩计算 Reality
        let scored = filtered.map(record => {
            let singleRlt, difficulty
            if (record._nyaSingleRating != null) {
                singleRlt = record._nyaSingleRating
                difficulty = record._nyaDifficulty || 0
            } else {
                difficulty = this.getChartDifficulty(record.chart_id, getInfo)
                let gameVer = parseGameVersion(record.game_version)
                singleRlt = calcReality(record.score, difficulty, gameVer, record.score_accuracy)
            }
            return { ...record, _reality: singleRlt, _difficulty: difficulty }
        })

        // 2. 按 chart_id 分组：取 Reality 最高的记录用于排名，同时记录最高分用于显示
        let bestPerChart = {}
        let maxScorePerChart = {}
        for (let s of scored) {
            let cid = s.chart_id
            if (!bestPerChart[cid] || s._reality > bestPerChart[cid]._reality) {
                bestPerChart[cid] = s
            }
            if (!maxScorePerChart[cid] || s.score > maxScorePerChart[cid].score) {
                maxScorePerChart[cid] = { score: s.score, accuracy: s.score_accuracy || 0 }
            }
        }
        let bestList = Object.values(bestPerChart)

        // 3. 按 Reality 从高到低排序，Reality 相同时按分数降序（匹配云端 Rank 的排序规则）
        bestList.sort((a, b) => b._reality - a._reality || b.score - a.score)

        // 4. 取前 N，附上该谱面的最高分（游戏内显示最高分而非计算 Reality 那版的分数）
        let topN = bestList.slice(0, Math.min(n, bestList.length)).map(s => {
            let cid = s.chart_id
            let maxInfo = maxScorePerChart[cid]
            return {
                ...s,
                _displayScore: maxInfo ? maxInfo.score : s.score,
                _displayAccuracy: maxInfo ? maxInfo.accuracy : (s.score_accuracy || 0)
            }
        })

        // 5. 计算 B20 Reality
        let top20 = topN.slice(0, Math.min(20, topN.length))
        let reality = top20.length > 0
            ? top20.reduce((sum, s) => sum + s._reality, 0) / top20.length
            : 0

        return { scores: topN, reality }
    }

    /**
     * 获取 AP20（All Perfect B20）—— 仅统计 acc=100% 的曲目
     * 筛选逻辑与 getB20WithReality 一致，只是预先过滤为非 AP 记录。
     * 兼容旧版存档（data.db / saves.db）：accuracy >= 0.9999 即视为 AP。
     * @param {number} n - 获取数量
     * @param {object} getInfo - getInfo 实例
     * @param {'touch'|'keyboard'|'merge'} mode - 云存档模式过滤，默认 'merge'
     * @returns {{ scores: object[], reality: number }}
     */
    getAP20WithReality(n = 20, getInfo, mode = 'merge') {
        this.ensureLoaded()

        // 按模式过滤云端记录
        let filtered = this.scores
        if (mode === 'touch') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'touch')
        } else if (mode === 'keyboard') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'keyboard')
        }

        // 1. 筛选 AP 记录（acc >= 99.99% 即视为 All Perfect）
        let apScores = filtered.filter(s => (s.score_accuracy || 0) >= 0.9999)

        // 2. 为每条 AP 成绩计算 Reality
        let scored = apScores.map(record => {
            let singleRlt, difficulty
            if (record._nyaSingleRating != null) {
                singleRlt = record._nyaSingleRating
                difficulty = record._nyaDifficulty || 0
            } else {
                difficulty = this.getChartDifficulty(record.chart_id, getInfo)
                let gameVer = parseGameVersion(record.game_version)
                singleRlt = calcReality(record.score, difficulty, gameVer, record.score_accuracy)
            }
            return { ...record, _reality: singleRlt, _difficulty: difficulty }
        })

        // 3. 按 chart_id 分组取最高 Reality
        let bestPerChart = {}
        let maxScorePerChart = {}
        for (let s of scored) {
            let cid = s.chart_id
            if (!bestPerChart[cid] || s._reality > bestPerChart[cid]._reality) {
                bestPerChart[cid] = s
            }
            if (!maxScorePerChart[cid] || s.score > maxScorePerChart[cid].score) {
                maxScorePerChart[cid] = { score: s.score, accuracy: s.score_accuracy || 0 }
            }
        }
        let bestList = Object.values(bestPerChart)

        // 4. 按 Reality 降序，同 Reality 按分数降序（匹配 B20 排序规则）
        bestList.sort((a, b) => b._reality - a._reality || b.score - a.score)

        // 5. 取前 N
        let topN = bestList.slice(0, Math.min(n, bestList.length)).map(s => {
            let cid = s.chart_id
            let maxInfo = maxScorePerChart[cid]
            return {
                ...s,
                _displayScore: maxInfo ? maxInfo.score : s.score,
                _displayAccuracy: maxInfo ? maxInfo.accuracy : (s.score_accuracy || 0)
            }
        })

        // 6. 计算 AP20 Reality
        let top20 = topN.slice(0, Math.min(20, topN.length))
        let reality = top20.length > 0
            ? top20.reduce((sum, s) => sum + s._reality, 0) / top20.length
            : 0

        return { scores: topN, reality }
    }

    /**
     * 将当前成绩导出为纯数组（供 diff 比对用）
     * @returns {object[]}
     */
    exportScores() {
        this.ensureLoaded()
        // 深拷贝一份，防止后续修改影响 diff
        return JSON.parse(JSON.stringify(this.scores))
    }

    /**
     * 获取玩家信息
     * @returns {{username: string, user_id: string, totalScores: number, saveType: string}}
     */
    getPlayerInfo() {
        this.ensureLoaded()
        return {
            username: this.username,
            user_id: this.user_id,
            // 统计唯一谱面数（同谱面新旧版本只算一个谱面）
            totalScores: new Set(this.scores.map(s => s.chart_id)).size,
            saveType: this.saveType
        }
    }

    /**
     * 获取指定chart_id的成绩信息（带计算后的评级）
     * 对于 saves.db 记录使用 BestLevel 映射；对于 data.db 记录从判定计算
     * @param {string} chartId
     * @param {object} chartInfo - 来自info.json的谱面信息
     * @returns {object|null}
     */
    getScoreWithGrade(chartId, chartInfo) {
        let score = this.getChartScore(chartId)
        if (!score) return null

        let gradeInfo

        if (score._source === 'saves' || score._source === 'nya_profiler') {
            // saves.db / nya_profiler: BestLevel 定分数评级，acc=100% 判定 AP，AchievedStatus 含 4 判定 FC
            let scoreGrade = (score._bestLevel != null && BEST_LEVEL_GRADE[score._bestLevel]) || fCompute.getScoreGrade(score.score)
            let isAP = score.score_accuracy >= 0.9999
            let isFC = Array.isArray(score._achievedStatus) && score._achievedStatus.includes(4)

            if (score._bestLevel === 0) {
                gradeInfo = { grade: 'R', iconName: 'R' }
            } else if (isAP) {
                gradeInfo = { grade: 'AP', iconName: 'AP' + scoreGrade }
            } else if (isFC) {
                gradeInfo = { grade: 'FC', iconName: 'FC' + scoreGrade }
            } else {
                gradeInfo = { grade: scoreGrade, iconName: scoreGrade }
            }
        } else {
            // data.db: 从判定数据计算评级
            let totalCombo = chartInfo?.combo || 1
            let isAllExact = (score.score_exact_count || 0) >= totalCombo
            let perfectAndExact = (score.score_exact_count || 0) + (score.score_perfect_count || 0)
            let isAllPerfectOrExact = perfectAndExact >= totalCombo

            gradeInfo = fCompute.getGrade(
                score.score,
                totalCombo - (score.score_bad_count || 0) - (score.score_miss_count || 0),
                totalCombo,
                score.score_bad_count || 0,
                score.score_miss_count || 0,
                isAllExact,
                isAllPerfectOrExact
            )
        }

        return {
            ...score,
            grade: gradeInfo.grade,
            iconName: gradeInfo.iconName,
            iconPath: fCompute.getIconPath(gradeInfo.iconName)
        }
    }

    /**
     * 从 Nya Profiler API 查询结果导入成绩
     * 将 best20 + extras 转为内部格式，并与现有本地数据合并（各谱面保留最高分）
     * @param {object} queryResult - NyaProfilerAuth.queryUserData 的返回结果
     * @param {object} getInfo - getInfo 实例（用于难度映射）
     * @returns {{success: boolean, msg?: string, username?: string, mergedCount?: number, newCount?: number}}
     */
    importFromNyaProfiler(queryResult, getInfo) {
        let { username, best20, extras } = queryResult

        if ((!best20 || best20.length === 0) && (!extras || extras.length === 0)) {
            return { success: false, msg: 'Nya Profiler 返回的成绩数据为空' }
        }

        // 合并 best20 + extras
        let allNyaScores = [...(best20 || []), ...(extras || [])]

        // 按游戏内规则从分数计算评级，不依赖 Nya API 的 rank 字段
        // 分数评级 → BestLevel 映射（fCompute.getScoreGrade → _bestLevel）
        const SCORE_GRADE_TO_BEST_LEVEL = {
            'R':0, 'M': 1, 'SS': 2, 'S': 3, 'A': 4, 'B': 5, 'C': 6, 'F': 7
        }

        // 转换为内部格式
        let nyaRecords = allNyaScores.map(entry => {
            let gameVersion = entry.isV3 ? 'v4.0' : 'v3.0'
            let scoreGrade = fCompute.getScoreGrade(entry.score)
            let bestLevel = SCORE_GRADE_TO_BEST_LEVEL[scoreGrade] ?? 7 // 默认 F
            let achievedStatus = []
            if (entry.isFC) achievedStatus.push(4)

            return {
                chart_id: entry.chart_id,
                score: entry.score,
                // AP 记录强制 accuracy=1.0，确保 getGradeForRecord 的 AP 判定生效
                score_accuracy: entry.isAP ? 1.0 : (entry.accuracy || 0),
                score_exact_count: 0,
                score_perfect_count: 0,
                score_good_count: 0,
                score_bad_count: 1,      // 非0标记以区别于未游玩
                score_miss_count: 0,
                score_great_count: 0,
                score_fracture_exact_count: 0,
                score_fracture_miss_count: 0,
                played_at: null,
                game_version: gameVersion,
                // 转为游戏内评级体系（R/M/SS/S/A/B/C/F），与 saves.db 一致
                grade: BEST_LEVEL_GRADE[bestLevel] || '',
                _bestLevel: bestLevel,
                _achievedStatus: achievedStatus,
                _source: 'nya_profiler',
                // API 预计算值（用于精确 Reality 和更新界面回退）
                _nyaSingleRating: entry.singleRating,
                _nyaDifficulty: entry.isV3 ? (entry.constantv3 || entry.constant || 0) : (entry.constant || 0),
                _nyaSongName: entry.name || '',
                _nyaCategory: entry.category || ''
            }
        })

        // 加载现有本地数据
        if (this.scores.length === 0) {
            this.loadCache()
        }

        // 合并：按 (chart_id, 版本组) 去重，各组保留最高分
        // 版本组分离避免 V2/V3 混算导致 Reality 偏差（Nya 数据全为 V3，本地可能含 V2）
        let merged = {}
        for (let record of this.scores) {
            let versionGroup = this._versionGroup(record.game_version)
            let key = `${record.chart_id}__${versionGroup}`
            if (!merged[key] || record.score > merged[key].score) {
                merged[key] = record
            }
        }

        let newCount = 0
        for (let record of nyaRecords) {
            let versionGroup = this._versionGroup(record.game_version)
            let key = `${record.chart_id}__${versionGroup}`
            if (!merged[key]) {
                merged[key] = record
                newCount++
            } else if (record.score > merged[key].score) {
                merged[key] = record
                newCount++
            }
            // 分数未超过则跳过
        }

        this.scores = Object.values(merged)
        this.username = username || this.username || 'Unknown'
        this.user_id = this.user_id || 'nya_profiler'
        this.saveType = this.saveType === 'unknown' ? 'nya_profiler' : this.saveType

        // 存储 Nya Profiler 特有的计算结果
        if (queryResult.chartProgress) {
            this.nyaChartProgress = queryResult.chartProgress
        }
        if (queryResult.starCount != null) {
            this.nyaStarCount = queryResult.starCount
        }

        // 仅在合并后有变化或首次加载时才标记为需要保存
        this.saveCache()

        return {
            success: true,
            username: this.username,
            mergedCount: this.scores.length,
            newCount
        }
    }

    /**
     * 从云端 Rank 接口导入 B20 详细游玩表现
     * 将云端返回的详细判定数据（exact/perfect/great/good/bad/miss 计数、
     * modifiers、played_at 等）合并到现有成绩中，补充 saves.db 格式缺失的细节。
     * 按 (chart_id, 版本组, _cloudMode) 隔离：同分组高分覆盖，跨分组独立保存。
     * 同时按平台分开记录云端返回的 Reality 用于比对本地计算值。
     * @param {any[]} rankEntries - rank API 返回的 rank 数组（调用方已预标 _cloudMode）
     * @param {{touchReality: number|null, keyboardReality: number|null}} cloudRealities - 各平台云端 Reality
     * @returns {{mergedCount: number, enrichedCount: number}}
     */
    importFromCloudRank(rankEntries, cloudRealities) {
        // 记录各平台云端 Reality
        if (cloudRealities?.touchReality != null) {
            this.cloudData.touch.rankReality = cloudRealities.touchReality
        }
        if (cloudRealities?.keyboardReality != null) {
            this.cloudData.keyboard.rankReality = cloudRealities.keyboardReality
        }
        // 兼容旧字段：取双端最高
        this.cloudRankReality = Math.max(
            cloudRealities?.touchReality || 0,
            cloudRealities?.keyboardReality || 0
        )

        // 构建现有 scores 的 (chart_id, versionGroup, _cloudMode) → index 映射
        let scoreIndex = {}
        for (let i = 0; i < this.scores.length; i++) {
            let cid = this.scores[i].chart_id
            let vg = this._versionGroup(this.scores[i].game_version)
            let mode = this.scores[i]._cloudMode || ''
            let key = `${cid}__${vg}__${mode}`
            // 每个 (chart_id, 版本组, 平台) 保留最高分的那条索引
            if (!(key in scoreIndex) || this.scores[i].score > this.scores[scoreIndex[key]].score) {
                scoreIndex[key] = i
            }
        }

        let enrichedCount = 0
        let mergedCount = 0

        for (let rankEntry of rankEntries) {
            let cid = rankEntry.chart_id
            let modifiers = rankEntry.modifiers || []
            let cloudVer = rankEntry.game_version || 'v5.0'
            let cloudGroup = this._versionGroup(cloudVer)
            let cloudMode = rankEntry._cloudMode || ''
            let key = `${cid}__${cloudGroup}__${cloudMode}`

            if (key in scoreIndex) {
                // 同分组：合并高分
                let idx = scoreIndex[key]
                let existing = this.scores[idx]

                let cloudScore = rankEntry.score
                let cloudAcc = rankEntry.score_accuracy ?? 0
                let localScore = existing.score ?? 0
                let localAcc = existing.score_accuracy ?? 0

                let scoreImproved = cloudScore > localScore
                let accImproved = cloudAcc > localAcc
                let anyImproved = scoreImproved || accImproved

                // 分数取最高
                if (scoreImproved) {
                    existing.score = cloudScore
                    // 同步更新评级（评级由分数决定）
                    let sg = fCompute.getScoreGrade(cloudScore)
                    let gm = { 'R': 0, 'M': 1, 'SS': 2, 'S': 3, 'A': 4, 'B': 5, 'C': 6, 'F': 7 }
                    if (gm[sg] != null) { existing._bestLevel = gm[sg]; existing.grade = sg }
                    existing.game_version = cloudVer
                }

                // acc 取最高
                if (accImproved) {
                    existing.score_accuracy = cloudAcc
                }

                // 判定详情在分数或 acc 任意一项推进时更新
                if (anyImproved) {
                    existing.score_exact_count = rankEntry.score_exact_count ?? existing.score_exact_count ?? 0
                    existing.score_perfect_count = rankEntry.score_perfect_count ?? existing.score_perfect_count ?? 0
                    existing.score_great_count = rankEntry.score_great_count ?? existing.score_great_count ?? 0
                    existing.score_good_count = rankEntry.score_good_count ?? existing.score_good_count ?? 0
                    existing.score_bad_count = rankEntry.score_bad_count ?? existing.score_bad_count ?? 0
                    existing.score_miss_count = rankEntry.score_miss_count ?? existing.score_miss_count ?? 0
                    existing.score_fracture_exact_count = rankEntry.score_fracture_exact_count ?? existing.score_fracture_exact_count ?? 0
                    existing.score_fracture_miss_count = rankEntry.score_fracture_miss_count ?? existing.score_fracture_miss_count ?? 0

                    // FC 检测
                    if ((rankEntry.score_bad_count || 0) === 0 && (rankEntry.score_miss_count || 0) === 0) {
                        if (!existing._achievedStatus) existing._achievedStatus = []
                        if (!existing._achievedStatus.includes(4)) existing._achievedStatus.push(4)
                    }
                }

                // 补充游玩时间和 Mod 信息
                if (rankEntry.played_at && !existing.played_at) {
                    existing.played_at = rankEntry.played_at
                }
                if (modifiers.length > 0) {
                    existing._modifiers = modifiers
                }
                // 确保 _cloudMode 标记存在
                if (cloudMode && !existing._cloudMode) {
                    existing._cloudMode = cloudMode
                }

                // 云端返回的 Reality 值
                if (rankEntry.reality != null) {
                    existing._cloudReality = rankEntry.reality
                }

                // 标记为已增强
                if (!existing._cloudEnriched) {
                    existing._cloudEnriched = true
                    enrichedCount++
                }

                this.scores[idx] = existing
            } else {
                // 检查是否存在其他版本组的同谱面同平台记录
                // 跨版本组时作为独立记录添加（保留旧版记录用于 max(v2,v3) 计算）
                // 定数为 0 的特殊谱面跨版本时直接合并，避免重复记录
                let otherGroupKey = null
                let otherGroup = cloudGroup === 'old' ? 'new' : 'old'
                let altKey = `${cid}__${otherGroup}__${cloudMode}`
                if (altKey in scoreIndex && this._isZeroDiffChart(cid)) {
                    otherGroupKey = altKey
                }

                if (otherGroupKey) {
                    // 定数为 0 的特殊谱面：合并到已有记录（跨版本公共）
                    let idx = scoreIndex[otherGroupKey]
                    let existing = this.scores[idx]
                    if (rankEntry.score > (existing.score || 0)) {
                        existing.score = rankEntry.score
                        let sg = fCompute.getScoreGrade(rankEntry.score)
                        let gm = { 'R': 0, 'M': 1, 'SS': 2, 'S': 3, 'A': 4, 'B': 5, 'C': 6, 'F': 7 }
                        if (gm[sg] != null) { existing._bestLevel = gm[sg]; existing.grade = sg }
                        existing.game_version = cloudVer
                    }
                    if ((rankEntry.score_accuracy ?? 0) > (existing.score_accuracy ?? 0)) {
                        existing.score_accuracy = rankEntry.score_accuracy
                    }
                    if (cloudMode && !existing._cloudMode) {
                        existing._cloudMode = cloudMode
                    }
                    if (!existing._cloudEnriched) { existing._cloudEnriched = true; enrichedCount++ }
                    this.scores[idx] = existing
                } else {
                    // 新分组记录，直接添加
                    let newRecord = {
                        chart_id: cid,
                        score: rankEntry.score,
                        score_accuracy: rankEntry.score_accuracy || 0,
                        score_exact_count: rankEntry.score_exact_count || 0,
                        score_perfect_count: rankEntry.score_perfect_count || 0,
                        score_great_count: rankEntry.score_great_count || 0,
                        score_good_count: rankEntry.score_good_count || 0,
                        score_bad_count: rankEntry.score_bad_count || 0,
                        score_miss_count: rankEntry.score_miss_count || 0,
                        score_fracture_exact_count: rankEntry.score_fracture_exact_count || 0,
                        score_fracture_miss_count: rankEntry.score_fracture_miss_count || 0,
                        played_at: rankEntry.played_at || null,
                        game_version: cloudVer,
                        grade: rankEntry.grade || '',
                        _source: 'cloud_rank',
                        _modifiers: modifiers,
                        _cloudMode: cloudMode || undefined,
                        _cloudReality: rankEntry.reality || 0,
                        _cloudEnriched: true
                    }
                    this.scores.push(newRecord)
                    mergedCount++
                }
            }
        }

        this.saveCache()
        return { mergedCount, enrichedCount }
    }

    /**
     * 从云端 Recent 接口导入最近游玩记录
     * 自动检测 TouchMode 判定触屏/键盘模式，按平台分开存储 recentPlay。
     * 所有记录合并到 scores 中（用于 Reality 比对和增量更新）。
     * @param {any[]} recentRecords - recent API 返回的完整记录数组
     * @returns {{mergedCount: number, enrichedCount: number}}
     */
    importFromCloudRecent(recentRecords) {
        if (!recentRecords || recentRecords.length === 0) return { mergedCount: 0, enrichedCount: 0 }

        // 为每条记录检测并标注 _cloudMode
        for (let record of recentRecords) {
            let modifiers = record.modifiers || []
            record._cloudMode = this._detectCloudModeFromModifiers(modifiers)
        }

        // 构建现有 scores 的 (chart_id, _cloudMode) → index 映射
        let scoreIndex = {}
        for (let i = 0; i < this.scores.length; i++) {
            let cid = this.scores[i].chart_id
            let mode = this.scores[i]._cloudMode || ''
            let key = `${cid}__${mode}`
            if (!(key in scoreIndex) || this.scores[i].score > this.scores[scoreIndex[key]].score) {
                scoreIndex[key] = i
            }
        }

        let enrichedCount = 0
        let mergedCount = 0
        /** @type {{touch: object|null, keyboard: object|null}} 各平台最新记录 */
        let latestPerMode = { touch: null, keyboard: null }

        for (let record of recentRecords) {
            let modifiers = record.modifiers || []
            let cid = record.chart_id
            let cloudMode = record._cloudMode || ''

            // 保留各平台第一条（最新，API 已按时间排序）记录用于 recent 功能
            if (!latestPerMode[cloudMode]) {
                latestPerMode[cloudMode] = {
                    chart_id: cid, score: record.score,
                    score_accuracy: record.score_accuracy || 0,
                    score_exact_count: record.score_exact_count || 0,
                    score_perfect_count: record.score_perfect_count || 0,
                    score_great_count: record.score_great_count || 0,
                    score_good_count: record.score_good_count || 0,
                    score_bad_count: record.score_bad_count || 0,
                    score_miss_count: record.score_miss_count || 0,
                    score_fracture_exact_count: record.score_fracture_exact_count || 0,
                    score_fracture_miss_count: record.score_fracture_miss_count || 0,
                    played_at: record.played_at || null,
                    game_version: record.game_version || 'v5.0',
                    grade: record.grade || '',
                    _source: 'cloud_recent',
                    _cloudMode: cloudMode,
                    _achievedStatus: ((record.score_bad_count || 0) === 0 && (record.score_miss_count || 0) === 0) ? [4] : [],
                    modifiers: modifiers,
                    reality: record.reality || 0
                }
            }

            let key = `${cid}__${cloudMode}`
            if (key in scoreIndex) {
                let idx = scoreIndex[key]
                let existing = this.scores[idx]
                let cloudVer = record.game_version || 'v5.0'
                let localGroup = this._versionGroup(existing.game_version)
                let cloudGroup = this._versionGroup(cloudVer)

                // 跨版本组：作为独立记录添加（保留旧版记录用于 max(v2,v3) 计算）
                // 定数为 0 的特殊谱面跨版本时直接合并，避免重复记录
                if (localGroup !== cloudGroup && !this._isZeroDiffChart(cid)) {
                    this.scores.push({
                        chart_id: cid, score: record.score,
                        score_accuracy: record.score_accuracy || 0,
                        score_exact_count: record.score_exact_count || 0,
                        score_perfect_count: record.score_perfect_count || 0,
                        score_great_count: record.score_great_count || 0,
                        score_good_count: record.score_good_count || 0,
                        score_bad_count: record.score_bad_count || 0,
                        score_miss_count: record.score_miss_count || 0,
                        score_fracture_exact_count: record.score_fracture_exact_count || 0,
                        score_fracture_miss_count: record.score_fracture_miss_count || 0,
                        played_at: record.played_at || null,
                        game_version: cloudVer,
                        grade: record.grade || '',
                        _source: 'cloud_recent',
                        _modifiers: modifiers,
                        _cloudMode: cloudMode,
                        _cloudReality: record.reality || 0,
                        _cloudEnriched: true
                    })
                    mergedCount++
                    continue
                }

                // 同版本组：分数和 acc 各自保留最高
                let cloudScore = record.score
                let cloudAcc = record.score_accuracy ?? 0
                let localScore = existing.score ?? 0
                let localAcc = existing.score_accuracy ?? 0

                let scoreImproved = cloudScore > localScore
                let accImproved = cloudAcc > localAcc
                let anyImproved = scoreImproved || accImproved

                if (scoreImproved) {
                    existing.score = cloudScore
                    let sg = fCompute.getScoreGrade(cloudScore)
                    let gm = { 'R': 0, 'M': 1, 'SS': 2, 'S': 3, 'A': 4, 'B': 5, 'C': 6, 'F': 7 }
                    if (gm[sg] != null) { existing._bestLevel = gm[sg]; existing.grade = sg }
                }
                if (accImproved) {
                    existing.score_accuracy = cloudAcc
                }

                if (anyImproved || !existing._cloudEnriched) {
                    existing.score_exact_count = record.score_exact_count ?? existing.score_exact_count ?? 0
                    existing.score_perfect_count = record.score_perfect_count ?? existing.score_perfect_count ?? 0
                    existing.score_great_count = record.score_great_count ?? existing.score_great_count ?? 0
                    existing.score_good_count = record.score_good_count ?? existing.score_good_count ?? 0
                    existing.score_bad_count = record.score_bad_count ?? existing.score_bad_count ?? 0
                    existing.score_miss_count = record.score_miss_count ?? existing.score_miss_count ?? 0
                    existing.score_fracture_exact_count = record.score_fracture_exact_count ?? existing.score_fracture_exact_count ?? 0
                    existing.score_fracture_miss_count = record.score_fracture_miss_count ?? existing.score_fracture_miss_count ?? 0
                    if (record.played_at && !existing.played_at) existing.played_at = record.played_at
                    if (modifiers.length > 0) existing._modifiers = modifiers
                    if (record.reality != null && existing._cloudReality == null) existing._cloudReality = record.reality
                    // 确保 _cloudMode 存在
                    if (cloudMode && !existing._cloudMode) existing._cloudMode = cloudMode
                    if ((record.score_bad_count || 0) === 0 && (record.score_miss_count || 0) === 0) {
                        if (!existing._achievedStatus) existing._achievedStatus = []
                        if (!existing._achievedStatus.includes(4)) existing._achievedStatus.push(4)
                    }
                }
                if (!existing._cloudEnriched) { existing._cloudEnriched = true; enrichedCount++ }
                this.scores[idx] = existing
            } else {
                // 新谱面（含特殊谱面如 Reality=0），直接添加
                this.scores.push({
                    chart_id: cid, score: record.score,
                    score_accuracy: record.score_accuracy ?? 0,
                    score_exact_count: record.score_exact_count || 0,
                    score_perfect_count: record.score_perfect_count || 0,
                    score_great_count: record.score_great_count || 0,
                    score_good_count: record.score_good_count || 0,
                    score_bad_count: record.score_bad_count || 0,
                    score_miss_count: record.score_miss_count || 0,
                    score_fracture_exact_count: record.score_fracture_exact_count || 0,
                    score_fracture_miss_count: record.score_fracture_miss_count || 0,
                    played_at: record.played_at || null,
                    game_version: record.game_version || 'v5.0',
                    grade: record.grade || '',
                    _source: 'cloud_recent',
                    _modifiers: modifiers,
                    _cloudMode: cloudMode,
                    _cloudReality: record.reality ?? 0,
                    _cloudEnriched: true
                })
                mergedCount++
            }
        }

        // 将各平台最新记录存入 cloudData
        if (latestPerMode.touch) {
            this.cloudData.touch.recentPlay = latestPerMode.touch
        }
        if (latestPerMode.keyboard) {
            this.cloudData.keyboard.recentPlay = latestPerMode.keyboard
        }
        // 兼容旧字段：保留第一条作为 cloudRecentPlay
        let firstRecord = latestPerMode.touch || latestPerMode.keyboard
        if (firstRecord) this.cloudRecentPlay = firstRecord

        this.saveCache()
        return { mergedCount, enrichedCount }
    }

    /**
     * 删除存档
     */
    deleteSave() {
        try {
            if (fs.existsSync(this.savePath)) fs.unlinkSync(this.savePath)
            if (fs.existsSync(this.cachePath)) fs.unlinkSync(this.cachePath)
            this.scores = []
            this.username = ''
            this.saveType = 'unknown'
            this.nyaChartProgress = null
            this.nyaStarCount = null
            this.cloudRankReality = null
            this.cloudRecentPlay = null
            this.cloudData = {
                touch: { rankReality: null, recentPlay: null },
                keyboard: { rankReality: null, recentPlay: null }
            }
            this.cloudUsername = null
            return true
        } catch (e) {
            return false
        }
    }

    /**
     * 构建云端 B20（基于 _cloudReality 字段）
     * @param {object} getInfo
     * @param {'touch'|'keyboard'|'merge'} mode - 云存档模式过滤，默认 'merge'
     * @returns {{ scores: object[], reality: number }}
     */
    getCloudB20(getInfo, mode = 'merge') {
        this.ensureLoaded()

        // 按模式过滤
        let filtered = this.scores
        if (mode === 'touch') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'touch')
        } else if (mode === 'keyboard') {
            filtered = this.scores.filter(s => !s._cloudMode || s._cloudMode === 'keyboard')
        }

        let scored = filtered
            .filter(s => s._cloudReality != null && s._cloudReality > 0)
            .map(s => ({
                chart_id: s.chart_id,
                score: s.score,
                reality: s._cloudReality,
            }))

        // 同 chart_id 取最高 _cloudReality（兼容跨版本重复记录）
        let bestPerChart = {}
        for (let s of scored) {
            let cid = s.chart_id
            if (!bestPerChart[cid] || s.reality > bestPerChart[cid].reality) {
                bestPerChart[cid] = s
            }
        }
        let bestList = Object.values(bestPerChart)
        bestList.sort((a, b) => b.reality - a.reality || b.score - a.score)

        let top20 = bestList.slice(0, 20)
        let reality = top20.length > 0
            ? top20.reduce((sum, s) => sum + s.reality, 0) / top20.length
            : 0

        return { scores: top20, reality }
    }

    /**
     * 比较云端 B20 与存档 B20，生成差异文本
     * 边界平局消解：若本地 B20 的末位曲目与云端 B20 的末位曲目 Reality 相同
     * 但因排序差异而互换了位置，则不作为差异报告（避免 All Perfect 等
     * 同定数曲目打新成绩后 B20 边界漂移导致的误报）。
     * @param {object} getInfo
     * @returns {string[]|null} 差异消息数组（每条曲目一行），无差异时返回 null
     */
    getB20DiffText(getInfo, mode = 'merge') {
        let saveB20 = this.getB20WithReality(20, getInfo, mode)
        let cloudB20 = this.getCloudB20(getInfo, mode)

        if (cloudB20.scores.length === 0) {
            return null  // 无云端数据，无法对比
        }

        // 云端 top 20 chart_id → reality 映射
        let cloudMap = {}
        for (let s of cloudB20.scores) {
            cloudMap[s.chart_id] = s.reality
        }

        // 本地 top 20 chart_id 集合
        let localB20Set = new Set(saveB20.scores.slice(0, 20).map(s => s.chart_id))

        // 本地全部 chart_id 集合（用于判断云端 B20 曲目是否在本地存在）
        let localAllSet = new Set(this.scores.map(s => s.chart_id))

        // ---- 边界平局消解 ----
        // 当 #20 附近存在多个 Reality 相同的曲目时，本地和云端可能因排序不同
        // 而选择不同的曲目进入 B20，这不代表真正的数据差异
        const TIE_THRESHOLD = 0.0005

        /** 在本地 B20 但不在云端 B20 的曲目（疑似"缺失"候选） */
        let localOnlyInB20 = []
        for (let s of saveB20.scores.slice(0, 20)) {
            if (!(s.chart_id in cloudMap)) {
                localOnlyInB20.push(s)
            }
        }

        /** 在云端 B20 但不在本地 B20、且本地数据中存在的曲目（边界互换候选） */
        let cloudOnlyInB20 = []
        for (let s of cloudB20.scores) {
            if (!localB20Set.has(s.chart_id) && localAllSet.has(s.chart_id)) {
                cloudOnlyInB20.push(s)
            }
        }

        // 匹配边界平局：若 localOnly X 与 cloudOnly Y 的 Reality 差值 ≤ 阈值，
        // 则 X 视为因排序边界平局被挤出云端 B20，非真正的数据缺失
        let tieResolved = new Set()
        for (let lo of localOnlyInB20) {
            for (let co of cloudOnlyInB20) {
                if (Math.abs(lo._reality - co.reality) <= TIE_THRESHOLD) {
                    tieResolved.add(lo.chart_id)
                    break
                }
            }
        }

        // ---- 生成差异 ----
        /** @type {{ chart_id: string, song: string, level: string, saveRlt: number, cloudRlt: number|null }[]} */
        let diffs = []

        for (let s of saveB20.scores.slice(0, 20)) {
            let cid = s.chart_id
            let saveRlt = s._reality || 0
            let cloudRlt = cloudMap[cid] ?? null

            if (cloudRlt == null || Math.abs(saveRlt - cloudRlt) > TIE_THRESHOLD) {
                // 边界平局消解：不在云端 B20 但存在互换曲目 → 跳过
                if (cloudRlt == null && tieResolved.has(cid)) {
                    continue
                }

                let songKey = getInfo.chartIdToSongKey(cid)
                let info = songKey ? getInfo.info(songKey) : null
                let songName = info?.song || cid
                let level = ''
                if (info) {
                    for (let lv of fCompute.Level) {
                        if (info.chart[lv]?.chartid === cid) {
                            level = fCompute.LevelAbbr[lv] || lv
                            break
                        }
                    }
                }
                diffs.push({ chart_id: cid, song: songName, level, saveRlt, cloudRlt })
            }
        }

        if (diffs.length === 0) return null

        let lines = [`⚠️ 云端/存档差异 (${diffs.length} 首) — 需在线重打以同步：`]
        for (let d of diffs) {
            let levelTag = d.level ? ` [${d.level}]` : ''
            if (d.cloudRlt == null) {
                lines.push(`  ${d.song}${levelTag} → 云端缺此记录`)
            } else {
                let delta = (d.saveRlt - d.cloudRlt).toFixed(4)
                lines.push(`  ${d.song}${levelTag} → 本地 ${d.saveRlt.toFixed(4)} / 云端 ${d.cloudRlt.toFixed(4)} Δ${delta}`)
            }
        }
        lines.push(`（将上述曲目在线游玩一次即可消除差异）`)

        return lines
    }
}
