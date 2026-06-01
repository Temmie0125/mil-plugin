/**
 * Redis 存储抽象层（仿 phi-plugin Data.js 模式）
 * 使用 Yunzai 内置全局 redis 实例存储 token 等敏感数据
 * 兼容从旧 JSON 文件自动迁移到 Redis
 */
import fs from 'node:fs'
import logger from './Logger.js'

const REDIS_PREFIX = 'milPlugin'
const DEFAULT_EX = 3600 * 24 * 90 // 默认 90 天过期

const TOKEN_DIR = `${process.cwd()}/plugins/mil-plugin/data/tokens`
const NYA_TOKEN_DIR = `${process.cwd()}/plugins/mil-plugin/data/nya_tokens`
const NYA_CACHE_DIR = `${process.cwd()}/plugins/mil-plugin/data/nya_cache`

const RedisStore = {
    // ==================== 基础 JSON 存取 ====================

    /**
     * 从 Redis 读取 JSON 数据
     * 若 Redis 中不存在但对应文件存在，自动从文件迁移到 Redis
     * @param {string} key - Redis key 后缀（不含 namespace）
     * @param {string} [filePath] - 旧 JSON 文件路径（用于迁移），不传则跳过迁移
     * @returns {Promise<object|null>}
     */
    async getJSON(key, filePath) {
        try {
            let raw = await redis.get(`${REDIS_PREFIX}:${key}`)
            if (raw) {
                return JSON.parse(raw)
            }
        } catch (e) {
            logger.error(`[mil-redis] get ${key} 失败:`, e.message)
        }

        // 迁移：Redis 不存在但旧 JSON 文件存在 → 导入到 Redis
        if (filePath && fs.existsSync(filePath)) {
            try {
                let raw = fs.readFileSync(filePath, 'utf8')
                let data = JSON.parse(raw)
                await this.setJSON(key, data)
                logger.mark(`[mil-redis] 已从文件迁移到 Redis: ${key}`)
                return data
            } catch (e) {
                logger.error(`[mil-redis] 迁移 ${key} 失败:`, e.message)
            }
        }
        return null
    },

    /**
     * 将 JSON 数据写入 Redis
     * @param {string} key - Redis key 后缀（不含 namespace）
     * @param {object} data
     * @param {number} [ex] - 过期时间（秒），默认 90 天
     * @returns {Promise<void>}
     */
    async setJSON(key, data, ex) {
        try {
            let ttl = ex || DEFAULT_EX
            await redis.set(`${REDIS_PREFIX}:${key}`, JSON.stringify(data), { EX: ttl })
        } catch (e) {
            logger.error(`[mil-redis] set ${key} 失败:`, e.message)
        }
    },

    /**
     * 从 Redis 删除 key，同步清理旧 JSON 文件
     * @param {string} key - Redis key 后缀
     * @param {string} [filePath] - 旧 JSON 文件路径
     * @returns {Promise<void>}
     */
    async del(key, filePath) {
        try {
            await redis.del(`${REDIS_PREFIX}:${key}`)
        } catch (e) {
            logger.error(`[mil-redis] del ${key} 失败:`, e.message)
        }
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath)
            } catch (e) {
                logger.error(`[mil-redis] 删除文件 ${filePath} 失败:`, e.message)
            }
        }
    },

    // ==================== 便捷方法：OIDC Token ====================

    _oidcKey(userId) { return `oidcToken:${userId}` },
    _oidcPath(userId) { return `${TOKEN_DIR}/${userId}.json` },
    getOidcToken(userId) { return this.getJSON(this._oidcKey(userId), this._oidcPath(userId)) },
    setOidcToken(userId, data) { return this.setJSON(this._oidcKey(userId), data) },
    delOidcToken(userId) { return this.del(this._oidcKey(userId), this._oidcPath(userId)) },

    // ==================== 便捷方法：Nya Profiler Token ====================

    _nyaKey(userId) { return `nyaToken:${userId}` },
    _nyaPath(userId) { return `${NYA_TOKEN_DIR}/${userId}.json` },
    getNyaToken(userId) { return this.getJSON(this._nyaKey(userId), this._nyaPath(userId)) },
    setNyaToken(userId, data) { return this.setJSON(this._nyaKey(userId), data) },
    delNyaToken(userId) { return this.del(this._nyaKey(userId), this._nyaPath(userId)) },

    // ==================== 便捷方法：Nya Profiler 查询缓存 ====================

    _nyaCacheKey(userId) { return `nyaCache:${userId}` },
    _nyaCachePath(userId) { return `${NYA_CACHE_DIR}/${userId}.json` },
    getNyaCache(userId) { return this.getJSON(this._nyaCacheKey(userId), this._nyaCachePath(userId)) },
    setNyaCache(userId, data) { return this.setJSON(this._nyaCacheKey(userId), data) },
    delNyaCache(userId) { return this.del(this._nyaCacheKey(userId), this._nyaCachePath(userId)) },
}

export default RedisStore
