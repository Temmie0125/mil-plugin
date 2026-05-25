/**
 * 存档管理
 * 管理用户存档的获取、缓存
 */
import SaveManager from './SaveManager.js'
import fs from 'fs'
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
     * 导入用户存档
     * @param {string} userId
     * @param {string} filePath
     * @returns {Promise<{success: boolean, msg: string, username?: string}>}
     */
    async importSave(userId, filePath) {
        let save = new SaveManager(userId)
        let result = await save.importSave(filePath)
        if (result.success) {
            this.saves[userId] = save
        }
        return result
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
