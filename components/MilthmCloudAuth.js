/**
 * Milthm 云存档认证模块
 * 使用 OIDC Device Authorization 流程进行认证
 * token 存储在 Redis 中（兼容从旧 JSON 文件自动迁移）
 */
import logger from './Logger.js'
import Version from './Version.js'
import RedisStore from './RedisStore.js'

const MILTHM_API_BASE = 'https://milkloud.milthm.cn/api'
const OIDC_DISCOVERY_URL = `${MILTHM_API_BASE}/oidc/.well-known/openid-configuration`

/** User-Agent 用于标识插件身份，便于用户在 Milkloud 会话管理器中辨别 */
const USER_AGENT = `mil-plugin/${Version.ver} (YunzaiBot; MilthmCloud)`

/** 硬编码的已知端点——作为 OIDC 发现的回退方案 */
const DEFAULT_DEVICE_AUTH_ENDPOINT = `${MILTHM_API_BASE}/oidc/device_authorization`
const DEFAULT_TOKEN_ENDPOINT = `${MILTHM_API_BASE}/oidc/oauth/token`
const DEFAULT_USERINFO_ENDPOINT = `${MILTHM_API_BASE}/oidc/userinfo`
/** 默认 scope：读取存档 + 离线续期（获取 refresh_token） */
const DEFAULT_SCOPE = 'openid milthm:save:read offline_access milthm:event:recent milthm:stats:best_performance profile'

/**
 * @typedef {Object} OIDCConfig
 * @property {string} device_authorization_endpoint
 * @property {string} token_endpoint
 * @property {string} userinfo_endpoint
 */

/**
 * @typedef {Object} TokenData
 * @property {string} access_token
 * @property {string} refresh_token
 * @property {string} token_type
 * @property {number} expires_at - 过期时间戳 (ms)
 * @property {string} scope
 * @property {string} cloud_username - 从 id_token/响应中提取的 Milthm 云用户名
 */

export default class MilthmCloudAuth {
    /**
     * @param {string} userId - QQ号
     * @param {string} clientId - OIDC client_id
     * @param {string} clientSecret - OIDC client_secret
     */
    constructor(userId, clientId, clientSecret) {
        this.userId = userId
        this.clientId = clientId
        this.clientSecret = clientSecret
        /** @type {TokenData|null} */
        this._token = null
        /** @type {OIDCConfig|null} */
        this._oidcConfig = null
        /** @type {string|null} 直接令牌（用户自行创建的 API Token，包含完整 Authorization 头如 "Basic xxx"） */
        this.directToken = null
    }

    // ==================== Token 持久化（Redis + 文件迁移兼容） ====================

    /**
     * 加载 token（优先 Redis，自动从旧 JSON 文件迁移）
     * @returns {Promise<TokenData|null>}
     */
    async loadToken() {
        try {
            let data = await RedisStore.getOidcToken(this.userId)
            if (data) {
                // 提取直接令牌（独立字段，不影响 OIDC token 结构）
                if (data._directToken) {
                    this.directToken = data._directToken
                    delete data._directToken
                }
                // 仅当包含 OIDC 字段时才视为有效 OIDC token
                if (data.access_token) {
                    this._token = data
                }
            }
            return this._token
        } catch (e) {
            logger.error(`[mil-cloud] 加载 token 失败:`, e.message)
        }
        return null
    }

    /**
     * 保存 token 到 Redis
     * @returns {Promise<void>}
     */
    async saveToken() {
        try {
            let data = this._token ? { ...this._token } : {}
            if (this.directToken) data._directToken = this.directToken
            await RedisStore.setOidcToken(this.userId, Object.keys(data).length > 0 ? data : null)
        } catch (e) {
            logger.error(`[mil-cloud] 保存 token 失败:`, e.message)
        }
    }

    /**
     * 清除 token（Redis + 旧文件一并清理）
     * @returns {Promise<void>}
     */
    async clearTokens() {
        this._token = null
        this.directToken = null
        try {
            await RedisStore.delOidcToken(this.userId)
        } catch (e) {
            logger.error(`[mil-cloud] 清除 token 失败:`, e.message)
        }
    }

    /**
     * 是否已授权
     * @returns {Promise<boolean>}
     */
    async isBound() {
        if (this._token || this.directToken) return true
        await this.loadToken()
        return !!(this._token || this.directToken)
    }

    /**
     * 是否使用直接令牌模式（用户自行创建的 API Token）
     * @returns {boolean}
     */
    isDirectTokenMode() {
        return !!this.directToken
    }

    /**
     * 使用直接令牌绑定（用户自行创建的 API Token）
     * 输入的 token 可能是完整 Authorization 头（如 "Basic xxx"）或仅凭证部分
     * @param {string} tokenHeader - Authorization 头值或仅凭证
     */
    async bindWithToken(tokenHeader) {
        let token = tokenHeader.trim()
        // 去掉可能存在的 "Authorization:" 外层前缀（用户可能一键复制完整头）
        token = token.replace(/^authorization:\s*/i, '')
        // 标准化：统一为 "Basic xxx" 或 "Bearer xxx" 格式
        if (token.toLowerCase().startsWith('basic ')) {
            // 已经是完整格式，直接使用
        } else if (token.toLowerCase().startsWith('bearer ')) {
            // Bearer token，直接使用
        } else {
            // 仅凭证部分，补全为 Basic 格式
            token = `Basic ${token}`
        }
        // 清除旧的 OIDC token，保留新的 directToken
        this._token = null
        await RedisStore.delOidcToken(this.userId)
        // 设置并保存直接令牌
        this.directToken = token
        await this.saveToken()
    }

    /**
     * 获取 Milthm API 请求的 Authorization 头值
     * 直接令牌模式返回完整头（如 "Basic xxx"），OIDC 模式返回 "Bearer xxx"
     * @returns {Promise<string|null>}
     */
    async _getApiAuthHeader() {
        if (this.directToken) return this.directToken
        let token = await this.getAccessToken()
        if (!token) return null
        return `Bearer ${token}`
    }

    /**
     * 对比 token 的 scope 与插件需求，返回缺少的 scope 列表
     * @returns {Promise<string[]>} 缺少的 scope，空数组表示完整
     */
    async getMissingScopes() {
        // 直接令牌模式：无法检测 scope，跳过检查
        if (this.directToken) return []
        if (!this._token) await this.loadToken()
        let stored = new Set((this._token?.scope || '').split(' ').filter(Boolean))
        let required = new Set(DEFAULT_SCOPE.split(' ').filter(Boolean))
        return [...required].filter(s => !stored.has(s))
    }

    // ==================== OIDC 发现 ====================

    /**
     * 获取 OIDC 端点配置（自动缓存）
     * @returns {Promise<OIDCConfig>}
     */
    async discoverEndpoints() {
        if (this._oidcConfig) return this._oidcConfig

        logger.debug('[mil-cloud] 开始 OIDC 服务发现...')
        try {
            let resp = await fetch(OIDC_DISCOVERY_URL, { headers: { 'User-Agent': USER_AGENT } })
            if (resp.ok) {
                let config = await resp.json()
                this._oidcConfig = {
                    device_authorization_endpoint: config.device_authorization_endpoint || DEFAULT_DEVICE_AUTH_ENDPOINT,
                    token_endpoint: config.token_endpoint || DEFAULT_TOKEN_ENDPOINT,
                    userinfo_endpoint: config.userinfo_endpoint || DEFAULT_USERINFO_ENDPOINT
                }
                logger.debug('[mil-cloud] OIDC 端点发现成功', this._oidcConfig)
                return this._oidcConfig
            }
            logger.warn(`[mil-cloud] OIDC 发现 HTTP ${resp.status}，回退到已知端点`)
        } catch (e) {
            logger.warn(`[mil-cloud] OIDC 发现失败: ${e.message}，回退到已知端点`)
        }

        // 回退：使用硬编码的已知端点
        this._oidcConfig = {
            device_authorization_endpoint: DEFAULT_DEVICE_AUTH_ENDPOINT,
            token_endpoint: DEFAULT_TOKEN_ENDPOINT,
            userinfo_endpoint: ''
        }
        logger.debug('[mil-cloud] 使用回退端点配置', this._oidcConfig)
        return this._oidcConfig
    }

    // ==================== Device Authorization 流程 ====================

    /**
     * 发起 Device Authorization 请求
     * 返回验证信息供用户完成授权
     * @returns {Promise<{verification_uri_complete: string, user_code: string, device_code: string, expires_in: number, interval: number}>}
     */
    async startDeviceAuth() {
        let cfg = await this.discoverEndpoints()

        let params = new URLSearchParams({
            client_id: this.clientId,
            scope: DEFAULT_SCOPE
        })

        let headers = this._getAuthHeaders()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'

        logger.debug('[mil-cloud] 发起 Device Auth 请求...')
        let resp = await fetch(cfg.device_authorization_endpoint, {
            method: 'POST',
            headers,
            body: params.toString(),
            signal: AbortSignal.timeout(30000)
        })

        let body = await resp.text()
        if (!resp.ok) {
            logger.error(`[mil-cloud] Device Auth 请求失败: HTTP ${resp.status}`, body)
            throw new Error(`设备授权请求失败: HTTP ${resp.status}`)
        }

        let data
        try {
            data = JSON.parse(body)
        } catch {
            throw new Error('设备授权响应解析失败')
        }

        if (data.error) {
            throw new Error(`设备授权错误: ${data.error_description || data.error}`)
        }

        logger.mark('[mil-cloud] Device Auth 请求成功', {
            expires_in: data.expires_in,
            interval: data.interval
        })

        return {
            verification_uri_complete: data.verification_uri_complete,
            user_code: data.user_code,
            device_code: data.device_code,
            expires_in: data.expires_in || 600,
            interval: data.interval || 5
        }
    }

    /**
     * 轮询 token 端点，直到用户完成授权或超时
     * @param {string} deviceCode - 设备授权码
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async pollForToken(deviceCode) {
        let cfg = await this.discoverEndpoints()

        let params = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: this.clientId
        })

        let headers = this._getAuthHeaders()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'

        let resp = await fetch(cfg.token_endpoint, {
            method: 'POST',
            headers,
            body: params.toString(),
            signal: AbortSignal.timeout(30000)
        })

        let body = await resp.text()
        let data
        try {
            data = JSON.parse(body)
        } catch {
            return { success: false, error: '响应解析失败' }
        }

        if (resp.ok && data.access_token) {
            // 成功获取 token
            // logger.debug('[mil-cloud] Token 获取成功，id_token:', data.id_token);
            // logger.debug('[mil-cloud] Token 获取成功，access_token:', data.access_token);
            logger.debug('[mil-cloud] Token 获取成功，服务端返回字段:', {
                keys: Object.keys(data),
                token_type: data.token_type,
                expires_in: data.expires_in,
                has_refresh_token: !!data.refresh_token,
                has_id_token: !!data.id_token,
                scope: data.scope
            })
            this._token = this._buildTokenData(data)
            await this.saveToken()
            return { success: true }
        }

        // 根据错误类型判断状态
        if (data.error === 'authorization_pending') {
            return { success: false, error: 'pending' }
        }
        if (data.error === 'slow_down') {
            return { success: false, error: 'slow_down' }
        }
        if (data.error === 'expired_token') {
            return { success: false, error: 'expired' }
        }
        if (data.error === 'access_denied') {
            return { success: false, error: 'denied' }
        }
        if (data.error === 'invalid_grant') {
            return { success: false, error: 'invalid_grant' }
        }

        // 未知错误
        logger.error(`[mil-cloud] 轮询 token 失败:`, data)
        return { success: false, error: data.error_description || data.error || '未知错误' }
    }

    // ==================== Token 刷新 ====================

    /**
     * 使用 refresh_token 刷新访问令牌
     * @returns {Promise<boolean>}
     */
    async refreshAccessToken() {
        if (!this._token || !this._token.refresh_token) {
            await this.loadToken()
            if (!this._token || !this._token.refresh_token) {
                return false
            }
        }

        let cfg = await this.discoverEndpoints()

        let params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this._token.refresh_token,
            client_id: this.clientId
        })

        let headers = this._getAuthHeaders()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'

        logger.debug('[mil-cloud] 刷新 access token...')
        try {
            let resp = await fetch(cfg.token_endpoint, {
                method: 'POST',
                headers,
                body: params.toString(),
                signal: AbortSignal.timeout(30000)
            })

            let body = await resp.text()
            if (!resp.ok) {
                logger.error(`[mil-cloud] 刷新 token 失败: HTTP ${resp.status}`, body)
                await this.clearTokens()
                return false
            }

            let data = JSON.parse(body)
            // 检查 OIDC 标准错误 (invalid_grant 等)
            if (data.error === 'invalid_grant') {
                logger.error('[mil-cloud] 刷新 token 失败: invalid_grant（token 已失效），清除本地 token')
                await this.clearTokens()
                return false
            }
            if (data.error) {
                logger.error(`[mil-cloud] 刷新 token 失败: ${data.error}`, body)
                await this.clearTokens()
                return false
            }
            // 更新 token（保留 refresh_token 如果服务端没返回新的）
            let newToken = this._buildTokenData(data)
            if (!newToken.refresh_token && this._token.refresh_token) {
                newToken.refresh_token = this._token.refresh_token
            }
            this._token = newToken
            await this.saveToken()

            logger.debug('[mil-cloud] Token 刷新成功')
            return true
        } catch (e) {
            logger.error('[mil-cloud] 刷新 token 异常:', e.message)
            return false
        }
    }

    /**
     * 确保 token 有效（过期则自动刷新）
     * @returns {Promise<boolean>}
     */
    async ensureValidToken() {
        // 直接令牌模式：长生命周期 API Token，无需过期检查
        if (this.directToken) return true
        if (!(await this.isBound())) return false

        // access_token 未过期
        if (this._token.expires_at > Date.now() + 60000) {
            return true
        }

        // token 已过期，检查是否有 refresh_token
        if (!this._token.refresh_token) {
            logger.debug('[mil-cloud] Token 已过期且无 refresh_token（device_auth 临时授权），需重新授权')
            return false
        }

        // 尝试刷新
        logger.debug('[mil-cloud] Token 已过期，尝试刷新...')
        return await this.refreshAccessToken()
    }

    /**
     * 获取当前有效的 access_token
     * @returns {Promise<string|null>}
     */
    async getAccessToken() {
        // 直接令牌模式：无需 ensureValidToken，直接返回
        if (this.directToken) return this.directToken
        if (!(await this.ensureValidToken())) return null
        return this._token.access_token
    }

    // ==================== 存档操作 ====================

    /**
     * 获取存档信息（meta + updated_at）
     * @returns {Promise<{meta: any, updated_at: string}>}
     */
    async fetchSaveInfo() {
        let authHeader = await this._getApiAuthHeader()
        if (!authHeader) throw new Error('[invalid_grant] 未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/game/save/info`, {
            headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }
        })

        let body = await resp.text()
        if (!resp.ok) {
            let errPrefix = resp.status === 401 ? '[invalid_grant] ' : ''
            throw new Error(`${errPrefix}获取存档信息失败: HTTP ${resp.status} ${body}`)
        }

        let data = JSON.parse(body)
        if (data.code && data.code.includes('Error')) {
            throw new Error(`API 错误: ${data.message || data.code}`)
        }

        return {
            meta: data.data?.meta,
            updated_at: data.data?.updated_at
        }
    }

    /**
     * 获取存档下载地址
     * @returns {Promise<{fileUrl: string, rawData: any}>}
     */
    async fetchSaveData() {
        let authHeader = await this._getApiAuthHeader()
        if (!authHeader) throw new Error('[invalid_grant] 未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/game/save`, {
            headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }
        })

        let body = await resp.text()
        if (!resp.ok) {
            let errPrefix = resp.status === 401 ? '[invalid_grant] ' : ''
            throw new Error(`${errPrefix}获取存档数据失败: HTTP ${resp.status} ${body}`)
        }

        let data = JSON.parse(body)
        if (data.code && data.code.includes('Error')) {
            throw new Error(`API 错误: ${data.message || data.code}`)
        }

        if (!data.data?.file_url) {
            throw new Error('响应中没有找到存档文件 URL')
        }

        return {
            fileUrl: data.data.file_url,
            rawData: data
        }
    }

    // ==================== UserInfo / Rank / Recent 接口 ====================

    /**
     * 获取 Milthm 云用户名（需要 scope: milthm:profile）
     * 优先级：token 缓存 > /v1/user 接口
     * @returns {Promise<{username: string, nickname: string, uid: string}>}
     */
    async fetchCloudUser() {
        // 始终调用 /v1/user 获取正确的 username
        // （令牌中缓存的 cloud_username 可能来自 OIDC id_token 的 sub，即 uid 而非 username）
        let authHeader = await this._getApiAuthHeader()
        if (!authHeader) throw new Error('[invalid_grant] 未授权或 token 已失效')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/user?`, {
            headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }
        })

        let body = await resp.text()
        if (!resp.ok) {
            let errPrefix = resp.status === 401 ? '[invalid_grant] ' : ''
            throw new Error(`${errPrefix}获取用户信息失败: HTTP ${resp.status}`)
        }

        let data = JSON.parse(body)
        logger.info('[mil-cloud] /v1/user 响应:', body.substring(0, 300))

        if (data.code && data.code !== 'OK') {
            throw new Error(`用户信息 API 错误: ${data.message || data.code}`)
        }

        let user = data.data || {}
        let username = user.username || ''

        // 拿到用户名后缓存到 token
        if (username && this._token) {
            this._token.cloud_username = username
            await this.saveToken()
            logger.info(`[mil-cloud] 用户名已缓存到 token: ${username}`)
        }

        return {
            username,
            nickname: user.nickname || '',
            uid: user.uid || ''
        }
    }

    /**
     * 获取 B20 曲目排行与详细游玩表现
     * 需要 scope: milthm:stats:best_performance
     * @param {string} username - Milthm 云用户名
     * @returns {Promise<{touchReality: number, keyboardReality: number, touchRanks: any[], keyboardRanks: any[]}>}
     */
    async fetchRankData(username) {
        let authHeader = await this._getApiAuthHeader()
        if (!authHeader) throw new Error('[invalid_grant] 未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/user/${encodeURIComponent(username)}/rank?`, {
            headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }
        })

        let body = await resp.text()
        if (!resp.ok) {
            let errPrefix = resp.status === 401 ? '[invalid_grant] ' : ''
            throw new Error(`${errPrefix}获取 Rank 数据失败: HTTP ${resp.status} ${body}`)
        }

        let data = JSON.parse(body)
        if (data.code && data.code !== 'OK') {
            throw new Error(`Rank API 错误: ${data.message || data.code}`)
        }

        let inner = data.data || {}
        let touchRanks = inner.touch_ranks || []
        let keyboardRanks = inner.keyboard_ranks || []

        // 优先读服务端字段，回退到 B20 均值（限前 20 首）
        let computeAvg = (ranks) => ranks.length > 0
            ? ranks.slice(0, 20).reduce((s, r) => s + (r.reality || 0), 0) / Math.min(ranks.length, 20)
            : 0
        let touchReality = (inner.touch_reality != null) ? inner.touch_reality : computeAvg(touchRanks)
        let keyboardReality = (inner.keyboard_reality != null) ? inner.keyboard_reality : computeAvg(keyboardRanks)

        logger.info(`[mil-cloud] Rank: touch=${touchReality.toFixed(4)} (${touchRanks.length}首), keyboard=${keyboardReality.toFixed(4)} (${keyboardRanks.length}首)`)

        return { touchReality, keyboardReality, touchRanks, keyboardRanks }
    }

    /**
     * 获取最近游玩记录
     * 需要 scope: milthm:event:recent
     * @param {string} username - Milthm 云用户名
     * @returns {Promise<any[]>}
     */
    async fetchRecentData(username) {
        let authHeader = await this._getApiAuthHeader()
        if (!authHeader) throw new Error('[invalid_grant] 未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/user/${encodeURIComponent(username)}/recent?`, {
            headers: { Authorization: authHeader, 'User-Agent': USER_AGENT }
        })

        let body = await resp.text()
        if (!resp.ok) {
            let errPrefix = resp.status === 401 ? '[invalid_grant] ' : ''
            throw new Error(`${errPrefix}获取 Recent 数据失败: HTTP ${resp.status} ${body}`)
        }

        let data = JSON.parse(body)
        if (data.code && data.code !== 'OK') {
            throw new Error(`Recent API 错误: ${data.message || data.code}`)
        }

        // recent 响应: data.data 是一个数组，通过 modifiers 区分 touch/keyboard
        let allRecords = data.data?.data || []
        return allRecords
    }

    /**
     * 下载存档文件内容（可处理重定向）
     * @param {string} fileUrl
     * @returns {Promise<Buffer>}
     */
    async downloadSaveFile(fileUrl) {
        logger.debug('[mil-cloud] 下载存档文件:', fileUrl)
        let resp = await fetch(fileUrl, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } })

        let contentType = resp.headers.get('content-type') || 'unknown'
        let contentLength = resp.headers.get('content-length') || 'unknown'
        logger.debug('[mil-cloud] 存档下载响应:', {
            status: resp.status,
            contentType,
            contentLength
        })

        if (!resp.ok) {
            let errorBody = await resp.text().catch(() => '(无法读取响应体)')
            logger.error(`[mil-cloud] 下载存档文件失败: HTTP ${resp.status}`, errorBody.substring(0, 500))
            throw new Error(`下载存档文件失败: HTTP ${resp.status}`)
        }

        let buffer = Buffer.from(await resp.arrayBuffer())
        logger.debug('[mil-cloud] 存档文件下载成功, 大小:', buffer.length)

        // 打印文件头部字节用于诊断格式
        let headHex = buffer.subarray(0, Math.min(100, buffer.length)).toString('hex')
        let headText = buffer.subarray(0, Math.min(200, buffer.length)).toString('utf8').replace(/[\x00-\x1f]/g, '.')
        logger.debug('[mil-cloud] 存档文件头部(hex):', headHex)
        logger.debug('[mil-cloud] 存档文件头部(text):', headText)

        return buffer
    }

    // ==================== 内部工具方法 ====================

    /**
     * 构建 HTTP Basic Auth 请求头
     * 当 clientSecret 存在时返回 Authorization 头，用于 confidential client 认证
     * @returns {Record<string, string>}
     */
    _getAuthHeaders() {
        let headers = {
            'User-Agent': USER_AGENT
        }
        if (this.clientSecret) {
            let credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
            headers['Authorization'] = `Basic ${credentials}`
        }
        return headers
    }

    /**
     * 从 API 响应构建 TokenData
     * 同时尝试从 id_token (JWT) 或直接字段中提取云用户名并缓存
     * @param {Object} data
     * @returns {TokenData}
     */
    _buildTokenData(data) {
        // 尝试从多种来源提取云用户名
        let cloudUsername = ''

        // 1) 优先: id_token (JWT) 中的 preferred_username
        if (data.id_token) {
            try {
                let payload = parseJwtPayload(data.id_token)
                cloudUsername = payload.preferred_username || payload.sub || ''
                if (cloudUsername) {
                    logger.info(`[mil-cloud] 从 id_token 提取用户名: ${cloudUsername}`)
                }
            } catch (e) {
                logger.warn('[mil-cloud] id_token 解析失败:', e.message)
            }
        }

        // 2) 其次: token 响应中的直接字段
        if (!cloudUsername) {
            cloudUsername = data.preferred_username || data.username || ''
            if (cloudUsername) {
                logger.info(`[mil-cloud] 从 token 响应提取用户名: ${cloudUsername}`)
            }
        }

        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || '',
            token_type: data.token_type || 'Bearer',
            expires_at: Date.now() + (data.expires_in || 3600) * 1000,
            scope: data.scope || DEFAULT_SCOPE,
            cloud_username: cloudUsername || ''
        }
    }
}

/**
 * 解析 JWT payload（不验证签名，仅提取用户信息）
 * @param {string} jwt
 * @returns {object}
 */
function parseJwtPayload(jwt) {
    let parts = jwt.split('.')
    if (parts.length < 2) throw new Error('无效 JWT 格式')
    let payload = parts[1]
    // 补齐 Base64 padding
    while (payload.length % 4 !== 0) payload += '='
    let decoded = Buffer.from(payload, 'base64').toString('utf8')
    return JSON.parse(decoded)
}
