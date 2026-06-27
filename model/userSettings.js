/**
 * 用户个人设置存储
 * 为每位用户保存独立的偏好设置（如云存档模式选择）
 * 存储路径: data/pluginData/<userId>_.json
 */
import fs from 'fs'

const PLUGIN_DATA_DIR = `${process.cwd()}/plugins/mil-plugin/data/pluginData`

/** 默认设置 */
const DEFAULT_SETTINGS = {
    /** @type {'touch'|'keyboard'|'merge'} 云存档模式 */
    cloudMode: 'touch'
}

/**
 * 用户设置存储
 */
class UserSettingsStore {
    /**
     * 获取用户的个人设置
     * @param {string} userId - QQ号
     * @returns {{cloudMode: string}}
     */
    static getSettings(userId) {
        let filePath = `${PLUGIN_DATA_DIR}/${userId}_.json`
        try {
            if (fs.existsSync(filePath)) {
                let data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
                return { ...DEFAULT_SETTINGS, ...data }
            }
        } catch (e) {
            // 文件损坏，返回默认设置
        }
        return { ...DEFAULT_SETTINGS }
    }

    /**
     * 保存用户设置
     * @param {string} userId - QQ号
     * @param {object} data - 设置数据
     */
    static saveSettings(userId, data) {
        if (!fs.existsSync(PLUGIN_DATA_DIR)) {
            fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true })
        }
        let filePath = `${PLUGIN_DATA_DIR}/${userId}_.json`
        // 合并现有设置，避免覆盖未传入的字段
        let existing = {}
        try {
            if (fs.existsSync(filePath)) {
                existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            }
        } catch { }
        let merged = { ...existing, ...data }
        fs.writeFileSync(filePath, JSON.stringify(merged, null, '\t'))
    }

    /**
     * 删除用户设置
     * @param {string} userId - QQ号
     */
    static deleteSettings(userId) {
        let filePath = `${PLUGIN_DATA_DIR}/${userId}_.json`
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
            }
        } catch { }
    }

    /**
     * 检测用户是否为首次设置（没有设置文件）
     * @param {string} userId
     * @returns {boolean}
     */
    static isFirstTime(userId) {
        let filePath = `${PLUGIN_DATA_DIR}/${userId}_.json`
        return !fs.existsSync(filePath)
    }
}

export default UserSettingsStore
