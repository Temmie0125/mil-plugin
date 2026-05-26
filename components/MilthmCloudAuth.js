/**
 * Milthm 云存档认证模块
 * 使用 OIDC Device Authorization 流程进行认证
 * token 存储在 data/tokens/ 目录下（不会被 git 追踪）
 */
import fs from 'node:fs'
import logger from './Logger.js'

const MILTHM_API_BASE = 'https://milkloud.milthm.cn/api'
const OIDC_DISCOVERY_URL = `${MILTHM_API_BASE}/oidc/.well-known/openid-configuration`

/** 硬编码的已知端点——作为 OIDC 发现的回退方案 */
const DEFAULT_DEVICE_AUTH_ENDPOINT = `${MILTHM_API_BASE}/oidc/device_authorization`
const DEFAULT_TOKEN_ENDPOINT = `${MILTHM_API_BASE}/oidc/oauth/token`

const TOKEN_DIR = `${process.cwd()}/plugins/mil-plugin/data/tokens`

/** 默认 scope：读取存档 + 离线续期（获取 refresh_token） */
const DEFAULT_SCOPE = 'milthm:save:read offline_access'

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
    }

    // ==================== Token 持久化 ====================

    /**
     * 获取 token 文件路径
     * @param {string} userId
     * @returns {string}
     */
    static tokenPath(userId) {
        return `${TOKEN_DIR}/${userId}.json`
    }

    /**
     * 加载本地存储的 token
     * @returns {TokenData|null}
     */
    loadToken() {
        try {
            let path = MilthmCloudAuth.tokenPath(this.userId)
            if (fs.existsSync(path)) {
                let raw = fs.readFileSync(path, 'utf8')
                this._token = JSON.parse(raw)
                return this._token
            }
        } catch (e) {
            logger.error(`[mil-cloud] 加载 token 失败:`, e.message)
        }
        return null
    }

    /**
     * 保存 token 到本地
     */
    saveToken() {
        try {
            if (!fs.existsSync(TOKEN_DIR)) {
                fs.mkdirSync(TOKEN_DIR, { recursive: true })
            }
            let path = MilthmCloudAuth.tokenPath(this.userId)
            fs.writeFileSync(path, JSON.stringify(this._token, null, '\t'))
        } catch (e) {
            logger.error(`[mil-cloud] 保存 token 失败:`, e.message)
        }
    }

    /**
     * 清除本地 token
     */
    clearTokens() {
        this._token = null
        try {
            let path = MilthmCloudAuth.tokenPath(this.userId)
            if (fs.existsSync(path)) {
                fs.unlinkSync(path)
            }
        } catch (e) {
            logger.error(`[mil-cloud] 清除 token 失败:`, e.message)
        }
    }

    /**
     * 是否已授权（本地有 token）
     * @returns {boolean}
     */
    isBound() {
        if (this._token) return true
        this.loadToken()
        return !!this._token
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
            let resp = await fetch(OIDC_DISCOVERY_URL)
            if (resp.ok) {
                let config = await resp.json()
                this._oidcConfig = {
                    device_authorization_endpoint: config.device_authorization_endpoint || DEFAULT_DEVICE_AUTH_ENDPOINT,
                    token_endpoint: config.token_endpoint || DEFAULT_TOKEN_ENDPOINT,
                    userinfo_endpoint: config.userinfo_endpoint || ''
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
            logger.debug('[mil-cloud] Token 获取成功，服务端返回字段:', {
                keys: Object.keys(data),
                token_type: data.token_type,
                expires_in: data.expires_in,
                has_refresh_token: !!data.refresh_token,
                scope: data.scope
            })
            this._token = this._buildTokenData(data)
            this.saveToken()
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
            this.loadToken()
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
                this.clearTokens()
                return false
            }

            let data = JSON.parse(body)
            // 更新 token（保留 refresh_token 如果服务端没返回新的）
            let newToken = this._buildTokenData(data)
            if (!newToken.refresh_token && this._token.refresh_token) {
                newToken.refresh_token = this._token.refresh_token
            }
            this._token = newToken
            this.saveToken()

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
        if (!this.isBound()) return false

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
        if (!(await this.ensureValidToken())) return null
        return this._token.access_token
    }

    // ==================== 存档操作 ====================

    /**
     * 获取存档信息（meta + updated_at）
     * @returns {Promise<{meta: any, updated_at: string}>}
     */
    async fetchSaveInfo() {
        let token = await this.getAccessToken()
        if (!token) throw new Error('未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/game/save/info`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        let body = await resp.text()
        if (!resp.ok) {
            throw new Error(`获取存档信息失败: HTTP ${resp.status} ${body}`)
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
        let token = await this.getAccessToken()
        if (!token) throw new Error('未授权或 token 已失效，请重新 /mil bind 授权')

        let resp = await fetch(`${MILTHM_API_BASE}/v1/game/save`, {
            headers: { Authorization: `Bearer ${token}` }
        })

        let body = await resp.text()
        if (!resp.ok) {
            throw new Error(`获取存档数据失败: HTTP ${resp.status} ${body}`)
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

    /**
     * 下载存档文件内容（可处理重定向）
     * @param {string} fileUrl
     * @returns {Promise<Buffer>}
     */
    async downloadSaveFile(fileUrl) {
        logger.debug('[mil-cloud] 下载存档文件:', fileUrl)
        let resp = await fetch(fileUrl, { redirect: 'follow' })

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
        let headers = {}
        if (this.clientSecret) {
            let credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
            headers['Authorization'] = `Basic ${credentials}`
        }
        return headers
    }

    /**
     * 从 API 响应构建 TokenData
     * @param {Object} data
     * @returns {TokenData}
     */
    _buildTokenData(data) {
        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || '',
            token_type: data.token_type || 'Bearer',
            expires_at: Date.now() + (data.expires_in || 3600) * 1000,
            scope: data.scope || DEFAULT_SCOPE
        }
    }
}
