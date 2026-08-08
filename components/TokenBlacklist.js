/**
 * Token 黑名单（防泄露令牌复用）
 * 群聊中被拒绝的直接令牌会被记录（仅存 SHA-256 哈希，不存明文），
 * 该令牌即使后续在私信重试也会被拒绝，用户需重新创建令牌。
 * 持久化于 data/token_blacklist.json
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import logger from './Logger.js'

const Plugin_Path = `${process.cwd()}/plugins/mil-plugin`
const FILE = `${Plugin_Path}/data/token_blacklist.json`

const TokenBlacklist = {
    /**
     * 计算令牌哈希（应传入标准化后的令牌，见 MilthmCloudAuth.normalizeToken）
     * @param {string} token - 标准化令牌
     * @returns {string}
     */
    hash(token) {
        return crypto.createHash('sha256').update(token).digest('hex')
    },

    _load() {
        try {
            let list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
            return Array.isArray(list) ? list : []
        } catch {
            return []
        }
    },

    _save(list) {
        try {
            fs.mkdirSync(`${Plugin_Path}/data`, { recursive: true })
            fs.writeFileSync(FILE, JSON.stringify(list))
        } catch (err) {
            logger.error('[mil-cloud] 保存 Token 黑名单失败:', err.message)
        }
    },

    /**
     * 令牌是否已被拒用
     * @param {string} token - 标准化令牌
     * @returns {boolean}
     */
    isBlacklisted(token) {
        let hash = this.hash(token)
        return this._load().includes(hash)
    },

    /**
     * 标记令牌拒用（幂等）
     * @param {string} token - 标准化令牌
     */
    blacklist(token) {
        let hash = this.hash(token)
        let list = this._load()
        if (!list.includes(hash)) {
            list.push(hash)
            this._save(list)
            logger.mark(`[mil-cloud] 已标记泄露令牌拒用: ${hash.slice(0, 12)}...`)
        }
    },
}

export default TokenBlacklist
