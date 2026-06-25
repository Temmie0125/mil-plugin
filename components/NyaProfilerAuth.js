/**
 * Re Nya Profiler API 客户端
 * 通过 API Key 认证，代理访问用户的 Milthm 游戏数据
 * 所有外部接口通过 api_key 查询参数认证
 *
 * API 流程：
 *   1. gen   → 生成授权链接，发送给用户
 *   2. poll  → 轮询授权状态，直到返回 authorized 和用户名
 *   3. query → 获取 B20、Rating 等计算结果
 *
 * 注意：每次 query 调用会消耗用户每日存档下载次数（每日上限 5 次），
 *       建议客户端缓存结果。
 */

import logger from './Logger.js'
import RedisStore from './RedisStore.js'

const NYA_PROFILER_BASE_URL = 'https://renya.mhtlim.top/api/external'

/**
 * @typedef {Object} NyaTokenData
 * @property {string} username - Milthm 用户名（由 poll 授权完成时返回）
 * @property {string} authorizedAt - 授权时间 ISO 字符串
 */

/**
 * @typedef {Object} NyaQueryResult
 * @property {string} username
 * @property {NyaScoreEntry[]} best20 - Best 20 + Overflow（最多22条）
 * @property {NyaScoreEntry[]} extras - 特殊谱面成绩
 * @property {number} averageRating - Best 20 平均 Rating
 * @property {number} totalScores - 总有效成绩数
 * @property {number} starCount - 星级（0-9）
 * @property {Object} chartProgress - 各难度进度
 */

/**
 * @typedef {Object} NyaScoreEntry
 * @property {string} chart_id
 * @property {string} name - 曲名
 * @property {string} difficulty - 难度名称 (CELESTIAL/CHERISH/SEEKER/DAZE/SPECIAL)
 * @property {string} category - 难度代码 (CL/CB/SK/DZ/SP)
 * @property {number} constant - 谱面定数
 * @property {number} constantv3 - V3 定数
 * @property {number} score - 分数
 * @property {number} accuracy - 准确率
 * @property {number} singleRating - 单曲 Rating
 * @property {string} rank - 评级
 * @property {boolean} isFC
 * @property {boolean} isAP
 * @property {boolean} isV3
 */

export default class NyaProfilerAuth {
    /**
     * @param {string} userId - QQ号
     * @param {string} apiKey - Nya Profiler API Key
     */
    constructor(userId, apiKey) {
        this.userId = userId
        this.apiKey = apiKey
        /** @type {NyaTokenData|null} */
        this._token = null
    }

    // ==================== Token 持久化（Redis + 文件迁移兼容） ====================

    /**
     * 加载授权信息（优先 Redis，自动从旧 JSON 文件迁移）
     * @returns {Promise<NyaTokenData|null>}
     */
    async loadToken() {
        try {
            this._token = await RedisStore.getNyaToken(this.userId)
            return this._token
        } catch (e) {
            logger.error(`[nya-profiler] 加载 token 失败:`, e.message)
        }
        return null
    }

    /**
     * 保存授权信息到 Redis
     * @returns {Promise<void>}
     */
    async saveToken() {
        try {
            await RedisStore.setNyaToken(this.userId, this._token)
        } catch (e) {
            logger.error(`[nya-profiler] 保存 token 失败:`, e.message)
        }
    }

    /**
     * 清除授权信息（Redis + 旧文件一并清理）
     * @returns {Promise<void>}
     */
    async clearToken() {
        this._token = null
        try {
            await RedisStore.delNyaToken(this.userId)
        } catch (e) {
            logger.error(`[nya-profiler] 清除 token 失败:`, e.message)
        }
    }

    /**
     * 是否已授权
     * @returns {Promise<boolean>}
     */
    async isBound() {
        if (this._token) return true
        await this.loadToken()
        return !!this._token
    }

    /**
     * 获取已授权的用户名
     * @returns {Promise<string|null>}
     */
    async getUsername() {
        if (!(await this.isBound())) return null
        return this._token.username
    }

    // ==================== API 请求 ====================

    /**
     * 发送 API 请求的通用方法
     * 认证方式：Authorization: Bearer <API_KEY> 请求头（api-1.json 规范）
     * @param {string} endpoint - API 端点路径（如 '/gen', '/poll', '/query'）
     * @param {Record<string, string>} [extraParams] - 额外查询参数
     * @returns {Promise<any>}
     */
    async _request(endpoint, extraParams = {}) {
        let url = `${NYA_PROFILER_BASE_URL}${endpoint}`
        if (Object.keys(extraParams).length > 0) {
            url += `?${new URLSearchParams(extraParams).toString()}`
        }

        logger.debug(`[nya-profiler] 请求: ${endpoint}`, extraParams)

        let response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Referer': 'https://renya.mhtlim.top/'
            }
        })
        let responseText = await response.text()

        if (!response.ok) {
            logger.debug({
                endpoint,
                status: response.status,
                body: responseText
            })
            throw new Error(`Nya Profiler API 请求失败 (${endpoint}): HTTP ${response.status}`)
        }

        let data
        try {
            data = JSON.parse(responseText)
        } catch {
            logger.debug({ endpoint, body: responseText })
            throw new Error(`Nya Profiler API 响应解析失败 (${endpoint})`)
        }

        if (data.result !== '200') {
            logger.debug({ endpoint, body: responseText })
            throw new Error(`Nya Profiler API 错误 (${endpoint}): ${data.message || data.result}`)
        }

        return data
    }

    // ==================== 授权流程 ====================

    /**
     * 生成授权链接
     * @returns {Promise<{url: string, uuid: string}>}
     */
    async generateAuthUrl() {
        logger.info('[nya-profiler] 生成授权链接...')
        let data = await this._request('/gen')
        logger.info('[nya-profiler] 授权链接生成成功, uuid:', data.details.uuid)
        return {
            url: data.details.url,
            uuid: data.details.uuid
        }
    }

    /**
     * 单次轮询授权状态
     * @param {string} uuid - 授权会话标识
     * @returns {Promise<{status: string, username?: string}>}
     *   status: 'pending' | 'pending_consent' | 'authorized' | 'rejected'
     */
    async pollAuthStatus(uuid) {
        logger.debug('[nya-profiler] 轮询授权状态, uuid:', uuid)
        let data = await this._request('/poll', { uuid })
        return {
            status: data.details.status,
            username: data.details.username
        }
    }

    /**
     * 轮询授权状态直到完成
     * @param {string} uuid - 授权会话标识
     * @param {number} [timeout=120] - 超时时间（秒）
     * @param {number} [interval=3] - 轮询间隔（秒）
     * @returns {Promise<string>} 返回用户名
     */
    async pollAuthLoop(uuid, timeout = 120, interval = 3) {
        let startTime = Date.now()
        let timeoutMs = timeout * 1000
        let intervalMs = interval * 1000

        logger.info(`[nya-profiler] 开始轮询授权，超时: ${timeout}s, 间隔: ${interval}s`)

        while (Date.now() - startTime < timeoutMs) {
            try {
                let result = await this.pollAuthStatus(uuid)

                if (result.status === 'authorized') {
                    logger.info('[nya-profiler] 用户已完成授权, 用户名:', result.username)
                    // 保存授权信息
                    this._token = {
                        username: result.username,
                        authorizedAt: new Date().toISOString()
                    }
                    await this.saveToken()
                    return result.username
                }

                if (result.status === 'rejected') {
                    throw new Error('用户拒绝了授权')
                }

                // pending 或 pending_consent：继续等待
                await this._sleep(intervalMs)
            } catch (error) {
                if (error.message.includes('用户拒绝')) throw error
                logger.error('[nya-profiler] 轮询出错:', error)
                throw error
            }
        }

        throw new Error('授权超时，用户未在规定时间内完成授权')
    }

    // ==================== 数据查询 ====================

    /**
     * 查询用户数据（B20、Rating 等计算结果）
     * 注意：每次调用消耗用户每日下载次数（上限5次），建议缓存
     * @param {string} username - Milthm 用户名
     * @returns {Promise<NyaQueryResult>}
     */
    async queryUserData(username) {
        logger.info('[nya-profiler] 查询用户数据, 用户名:', username)
        let data = await this._request('/query', { username })
        logger.info('[nya-profiler] 用户数据查询成功')

        return {
            username: data.details.username,
            best20: data.details.best20 || [],
            extras: data.details.extras || [],
            averageRating: data.details.averageRating || 0,
            totalScores: data.details.totalScores || 0,
            starCount: data.details.starCount || 0,
            chartProgress: data.details.chartProgress || { CL: {}, CB: {}, SK: {}, DZ: {} }
        }
    }

    /**
     * 查询当前已授权用户的数据（自动使用缓存的用户名）
     * @returns {Promise<NyaQueryResult>}
     */
    async queryCurrentUserData() {
        let username = await this.getUsername()
        if (!username) {
            throw new Error('未授权或授权信息已失效，请重新绑定')
        }
        return await this.queryUserData(username)
    }

    // ==================== 缓存管理（Redis + 文件迁移兼容） ====================

    /**
     * 将查询结果缓存到 Redis
     * @param {string} userId - QQ号
     * @param {NyaQueryResult} data
     * @returns {Promise<void>}
     */
    static async saveCache(userId, data) {
        try {
            let cacheData = {
                ...data,
                cachedAt: new Date().toISOString()
            }
            await RedisStore.setNyaCache(userId, cacheData)
            logger.debug('[nya-profiler] 缓存已保存, userId:', userId, ', 用户名:', data.username)
        } catch (e) {
            logger.error('[nya-profiler] 保存缓存失败:', e.message)
        }
    }

    /**
     * 从 Redis 加载查询结果缓存
     * @param {string} userId - QQ号
     * @returns {Promise<NyaQueryResult|null>}
     */
    static async loadCache(userId) {
        try {
            let data = await RedisStore.getNyaCache(userId)
            if (data) {
                logger.debug('[nya-profiler] 缓存已加载, userId:', userId,
                    ', 用户名:', data.username, ', 缓存时间:', data.cachedAt)
                return data
            }
        } catch (e) {
            logger.error('[nya-profiler] 加载缓存失败:', e.message)
        }
        return null
    }

    /**
     * 获取缓存年龄（秒），无缓存返回 null
     * @param {string} userId - QQ号
     * @returns {Promise<number|null>}
     */
    static async getCacheAge(userId) {
        try {
            let data = await RedisStore.getNyaCache(userId)
            if (!data || !data.cachedAt) return null
            let age = (Date.now() - new Date(data.cachedAt).getTime()) / 1000
            return Math.max(0, age)
        } catch {
            return null
        }
    }

    /**
     * 清除缓存（Redis + 旧文件一并清理）
     * @param {string} userId - QQ号
     * @returns {Promise<void>}
     */
    static async clearCache(userId) {
        try {
            await RedisStore.delNyaCache(userId)
        } catch (e) {
            logger.error('[nya-profiler] 清除缓存失败:', e.message)
        }
    }

    // ==================== 工具方法 ====================

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
