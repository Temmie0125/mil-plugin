/**
 * 存档管理
 * 管理用户存档的获取、缓存、更新记录
 */
import SaveManager from './SaveManager.js'
import UpdateLog from './UpdateLog.js'
import fs from 'fs'
import fCompute from './fCompute.js'
import logger from '../components/Logger.js'

class GetSave {
    constructor() {
        /** @type {Record<string, SaveManager>} */
        this.saves = {}
    }

    /**
     * 获取用户的存档管理器
     * @param {string} userId
     * @returns {Promise<SaveManager|null>}
     */
    async getSave(userId) {
        if (!this.saves[userId]) {
            this.saves[userId] = new SaveManager(userId)
        }
        let save = this.saves[userId]
        if (save.hasSave() || fs.existsSync(save.cachePath)) {
            save.ensureLoaded()
            if (save.scores.length > 0) {
                return save
            }
        }
        return save
    }

    /**
     * 导入用户存档（本地文件）
     * 每次导入都记录更新条目（首次导入取 top 6，后续记录 diff）
     * @param {string} userId
     * @param {string} filePath
     * @param {{noRecord?: boolean}} [opts] - noRecord=true 时跳过记录更新（调用方自行记录）
     * @returns {Promise<{success: boolean, msg: string, username?: string, updateEntry?: object, saveType?: string, _oldScores?: object[]|null}>}
     */
    async importSave(userId, filePath, opts = {}) {
        // 1. 导入前捕获旧成绩（内存没有则尝试从磁盘缓存恢复）
        let oldScores = this._captureOldScores(userId)

        // 2. 创建新 SaveManager 并导入
        let save = new SaveManager(userId)
        let result = await save.importSave(filePath)

        if (result.success) {
            this.saves[userId] = save

            if (!opts.noRecord) {
                // 3. 始终记录更新条目
                let updateEntry = this._recordUpdate(userId, oldScores, save.scores, result.username || 'Unknown')
                return { ...result, updateEntry }
            }
            // 不记录时仍返回 oldScores 供调用方后续使用
            result._oldScores = oldScores
        }
        return result
    }

    /**
     * 从 JSON 字符串导入云存档
     * 每次导入都记录更新条目
     * @param {string} userId
     * @param {string} jsonStr - 云存档 JSON 字符串
     * @param {{noRecord?: boolean}} [opts] - noRecord=true 时跳过记录更新（调用方自行记录）
     * @returns {{success: boolean, msg: string, username?: string, saveType?: string, updateEntry?: object, _oldScores?: object[]|null}}
     */
    importFromJSON(userId, jsonStr, opts = {}) {
        // 1. 导入前捕获旧成绩（内存没有则尝试从磁盘缓存恢复）
        let oldScores = this._captureOldScores(userId)

        // 2. 创建新 SaveManager 并导入
        let save = new SaveManager(userId)
        let result = save.parseJSONSave(jsonStr)

        if (result.success) {
            this.saves[userId] = save
            save.saveCache()

            if (!opts.noRecord) {
                // 3. 始终记录更新条目
                let updateEntry = this._recordUpdate(userId, oldScores, save.scores, result.username || 'Unknown')
                return { ...result, updateEntry }
            }
            // 不记录时仍返回 oldScores 供调用方后续使用
            result._oldScores = oldScores
        }
        return result
    }

    /**
     * 捕获旧成绩：内存有则直接用，否则尝试从磁盘缓存恢复
     * @param {string} userId
     * @returns {object[]|null} null 表示真正的首次导入
     */
    _captureOldScores(userId) {
        let oldSave = this.saves[userId]
        if (!oldSave) {
            // 重启后内存清空，尝试从磁盘缓存恢复
            oldSave = new SaveManager(userId)
            if (!oldSave.loadCache()) {
                // 缓存也不存在 → 真正首次导入
                return null
            }
        }
        if (oldSave.scores && oldSave.scores.length > 0) {
            return oldSave.exportScores()
        }
        return null
    }

    /**
     * 执行 diff 并记录更新（每次导入/更新都必须调用）
     * @param {string} userId
     * @param {object[]|null} oldScores - null = 首次导入
     * @param {object[]} newScores
     * @param {string} username
     * @returns {object} updateEntry（永远有效）
     */
    _recordUpdate(userId, oldScores, newScores, username) {
        let updateLog = new UpdateLog(userId)
        updateLog.load()

        let dateStr = fCompute.formatDate(new Date().toISOString())
        let entry = updateLog.createEntry(oldScores, newScores, username, dateStr)

        updateLog.prepend(entry)

        if (oldScores && oldScores.length > 0) {
            logger.mark(`[mil-plugin] 用户 ${userId} 存档更新记录已保存，变动 ${entry.totalChanges} 首`)
        } else {
            logger.mark(`[mil-plugin] 用户 ${userId} 首次导入存档，记录 ${entry.totalChanges} 首最高成绩`)
        }
        return entry
    }

    /**
     * 获取用户的更新日志
     * @param {string} userId
     * @returns {UpdateLog}
     */
    getUpdateLog(userId) {
        let log = new UpdateLog(userId)
        log.load()
        return log
    }

    /**
     * 删除用户存档
     * @param {string} userId
     */
    deleteSave(userId) {
        if (this.saves[userId]) {
            this.saves[userId].deleteSave()
            delete this.saves[userId]
        }
    }
}

export default new GetSave()
