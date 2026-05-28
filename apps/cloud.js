/**
 * Milthm 云存档命令
 * - /mil bind   : 授权 Milthm 云存档（Device Auth 流程，token 自动续期）
 *                 或授权 Nya Profiler 查分器（当未配置 OIDC 时）
 * - /mil update : 从云端下载并导入最新存档
 * - /unbind     : 解除授权（不删除本地存档）
 *
 * 优先级：官方 OIDC (client_id) > Nya Profiler (nya_api_key)
 */
import Config from '../components/Config.js'
import send from '../model/send.js'
import getSave from '../model/getSave.js'
import getInfo from '../model/getInfo.js'
import fCompute from '../model/fCompute.js'
import picmodle from '../model/picmodle.js'
import Version from '../components/Version.js'
import milPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'
import MilthmCloudAuth from '../components/MilthmCloudAuth.js'
import NyaProfilerAuth from '../components/NyaProfilerAuth.js'
import SaveManager from '../model/SaveManager.js'
import fs from 'node:fs'

const Plugin_Path = `${process.cwd()}/plugins/mil-plugin`

/** 正在授权的用户集合（防重复） */
const bindingUsers = new Set()

/** 正在更新的用户集合（防重复） */
const updatingUsers = new Set()

export class milcloud extends milPluginBase {
    constructor() {
        super({
            name: 'mil-云存档',
            dsc: 'Milthm 云存档授权与管理',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(bind|绑定)(\\s*)$`,
                    fnc: 'bind'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(update|更新存档|云存档)(\\s*)$`,
                    fnc: 'updateSave'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(unbind|解绑|解除绑定)(\\s*)$`,
                    fnc: 'unbind'
                }
            ]
        })
    }

    /**
     * 授权云存档 - Device Auth 流程（token 自动续期）
     * 或授权 Nya Profiler（当未配置 OIDC 时）
     */
    async bind(e) {
        let userId = e.user_id

        // 检查配置优先级
        let clientId = this._getClientId()
        let nyaApiKey = this._getNyaApiKey()

        if (clientId) {
            return await this._bindOIDC(e)
        } else if (nyaApiKey) {
            return await this._bindNya(e)
        } else {
            send.send_with_At(e, '尚未配置云存档接口！\n请联系 Bot 主人在 Guoba 面板中填写：\n• Milthm 云存档的 client_id 和 client_secret（推荐）\n• 或 Re Nya Profiler 的 API Key')
            return true
        }
    }

    /**
     * 官方 OIDC 授权流程
     */
    async _bindOIDC(e) {
        let userId = e.user_id
        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()

        // 检查是否已经在授权中
        if (bindingUsers.has(userId)) {
            send.send_with_At(e, '你已有一个授权流程在进行中，请先完成或等待超时~')
            return true
        }

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        // 检查是否已授权且 token 有效
        if (auth.isBound()) {
            let isValid = await auth.ensureValidToken()
            if (isValid) {
                send.send_with_At(e, `你已授权 Milthm 云存档，Token 自动续期中，无需重复授权\n如需更换账号，请先使用 /unbind 解除授权`)
                return true
            }
            // token 已过期，清除旧 token 并继续新授权流程
            auth.clearTokens()
            logger.debug('[mil-cloud] 用户旧 token 已过期，自动清除')
        }

        // 发起 Device Auth
        let deviceAuthInfo
        try {
            deviceAuthInfo = await auth.startDeviceAuth()
        } catch (err) {
            logger.error('[mil-cloud] 设备授权发起失败:', err)
            send.send_with_At(e, `发起设备授权失败：${err.message}`)
            return true
        }

        // 发送授权链接给用户，120 秒后自动撤回（授权成功时提前撤回）
        let authMsg = await send.send_with_At(e,
            `Milthm 云存档授权\n` +
            `请在浏览器打开下方链接完成授权：\n${deviceAuthInfo.verification_uri_complete}\n` +
            `或手动输入用户码: ${deviceAuthInfo.user_code}\n\n` +
            `链接将在授权完成后撤回，请尽快完成授权\n` +
            `3 分钟内未完成授权将自动取消`,
            false,
            { recallMsg: 120 }
        )

        // 开始轮询（3 分钟超时自动取消）
        bindingUsers.add(userId)
        try {
            await this._pollLoop(e, auth, deviceAuthInfo, { timeoutSec: 180, authMessage: authMsg })
        } finally {
            bindingUsers.delete(userId)
        }

        return true
    }

    /**
     * Nya Profiler 授权流程
     */
    async _bindNya(e) {
        let userId = e.user_id
        let nyaApiKey = this._getNyaApiKey()

        // 检查是否已经在授权中
        if (bindingUsers.has(userId)) {
            send.send_with_At(e, '你已有一个授权流程在进行中，请先完成或等待超时~')
            return true
        }

        let nyaAuth = new NyaProfilerAuth(userId, nyaApiKey)

        // 检查是否已授权
        if (nyaAuth.isBound()) {
            send.send_with_At(e,
                `你已授权 Re Nya Profiler 查分器\n` +
                `当前绑定用户名: ${nyaAuth.getUsername()}\n` +
                `如需更换账号，请先使用 /unbind 解除授权`
            )
            return true
        }

        // 生成授权链接
        let authInfo
        try {
            authInfo = await nyaAuth.generateAuthUrl()
        } catch (err) {
            logger.error('[nya-profiler] 生成授权链接失败:', err)
            send.send_with_At(e, `生成授权链接失败：${err.message}`)
            return true
        }

        // 发送授权链接给用户
        let authMsg = await send.send_with_At(e,
            `Re Nya Profiler 查分器授权\n` +
            `请在浏览器打开下方链接完成授权：\n${authInfo.url}\n\n` +
            `链接将在授权完成后撤回，请尽快完成授权\n` +
            `2 分钟内未完成授权将自动取消`,
            false,
            { recallMsg: 120 }
        )

        // 开始轮询（2 分钟超时）
        bindingUsers.add(userId)
        try {
            let username = await nyaAuth.pollAuthLoop(authInfo.uuid, 120, 3)

            // 撤回授权链接消息
            if (authMsg?.message_id) {
                let msgId = Array.isArray(authMsg.message_id)
                    ? authMsg.message_id[0]
                    : authMsg.message_id
                try {
                    if (e.isGroup && e.group?.recallMsg) {
                        await e.group.recallMsg(msgId)
                    } else if (e.friend?.recallMsg) {
                        await e.friend.recallMsg(msgId)
                    }
                } catch { /* 撤回失败不影响主流程 */ }
            }

            send.send_with_At(e,
                `授权成功！\n` +
                `Milthm 用户名: ${username}\n` +
                `现在可以使用 /${Config.getUserCfg('config', 'cmdhead')} update 更新查分数据~`
            )
        } catch (err) {
            if (err.message.includes('超时')) {
                send.send_with_At(e, `授权超时自动取消，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
            } else if (err.message.includes('拒绝')) {
                send.send_with_At(e, '授权被拒绝，操作已取消')
            } else {
                send.send_with_At(e, `授权失败：${err.message}`)
            }
        } finally {
            bindingUsers.delete(userId)
        }

        return true
    }

    /**
     * 轮询等待用户完成授权
     * @param {*} e
     * @param {MilthmCloudAuth} auth
     * @param {Object} deviceAuthInfo
     * @param {{timeoutSec?: number}} [options]
     */
    async _pollLoop(e, auth, deviceAuthInfo, { timeoutSec, authMessage } = {}) {
        let { device_code, interval, expires_in } = deviceAuthInfo
        let pollInterval = Math.max(interval, 3) * 1000 // 最低 3 秒
        // 取服务端过期和本地超时的较小值
        let effectiveExpire = timeoutSec ? Math.min(timeoutSec, expires_in) : expires_in
        let deadline = Date.now() + effectiveExpire * 1000
        let wasCancelled = false // 是否因本地超时取消
        let slowDownCount = 0

        while (Date.now() < deadline) {
            await this._sleep(pollInterval)

            let result
            try {
                result = await auth.pollForToken(device_code)
            } catch (err) {
                logger.error('[mil-cloud] 轮询异常:', err)
                send.send_with_At(e, '轮询授权状态时发生错误，请稍后重试')
                return
            }

            if (result.success) {
                // 立即撤回授权链接消息
                if (authMessage?.message_id) {
                    let msgId = Array.isArray(authMessage.message_id)
                        ? authMessage.message_id[0]
                        : authMessage.message_id
                    try {
                        if (e.isGroup && e.group?.recallMsg) {
                            await e.group.recallMsg(msgId)
                        } else if (e.friend?.recallMsg) {
                            await e.friend.recallMsg(msgId)
                        }
                    } catch { /* 撤回失败不影响主流程 */ }
                }
                send.send_with_At(e,
                    `授权成功！\n` +
                    `现在可以使用 /${Config.getUserCfg('config', 'cmdhead')} update 更新云端存档~\n` +
                    `Token 将自动续期，无需重复授权`
                )
                return
            }

            if (result.error === 'pending') {
                // 检查是否临近本地超时
                if (timeoutSec && Date.now() + pollInterval >= deadline) {
                    wasCancelled = true
                }
                continue
            }

            if (result.error === 'slow_down') {
                slowDownCount++
                pollInterval = Math.min(pollInterval + 5000, 30000)
                continue
            }

            if (result.error === 'denied') {
                send.send_with_At(e, '授权被拒绝，操作已取消')
                return
            }

            if (result.error === 'expired') {
                send.send_with_At(e, `授权码已过期，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
                return
            }

            // 其他错误
            if (slowDownCount > 2) {
                send.send_with_At(e, `授权轮询出现异常，请检查链接是否已授权。如需帮助请联系 Bot 主人`)
                return
            }
        }

        // 超时
        if (wasCancelled || timeoutSec) {
            send.send_with_At(e, `授权已超时自动取消（${timeoutSec || effectiveExpire} 秒内未完成），请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
        } else {
            send.send_with_At(e, `授权等待超时，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
        }
    }

    /**
     * 从云端更新存档
     */
    async updateSave(e) {
        let clientId = this._getClientId()
        let nyaApiKey = this._getNyaApiKey()

        if (clientId) {
            return await this._updateOIDC(e)
        } else if (nyaApiKey) {
            return await this._updateNya(e)
        } else {
            send.send_with_At(e, '尚未配置云存档接口！\n请联系 Bot 主人在 Guoba 面板中填写相关配置')
            return true
        }
    }

    /**
     * 官方 OIDC 更新流程
     */
    async _updateOIDC(e) {
        let userId = e.user_id

        // 检查配置
        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()
        if (!clientId) {
            send.send_with_At(e, '尚未配置 client_id，请联系 Bot 主人在 Guoba 面板中填写')
            return true
        }

        // 防重复
        if (updatingUsers.has(userId)) {
            send.send_with_At(e, '你已有一个更新流程在进行中，请稍后~')
            return true
        }

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        if (!auth.isBound()) {
            send.send_with_At(e, `你还没有授权 Milthm 云存档！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} bind 进行授权`)
            return true
        }

        updatingUsers.add(userId)

        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        try {
            // 1. 获取存档信息（预览）
            let saveInfo
            try {
                saveInfo = await auth.fetchSaveInfo()
            } catch (err) {
                if (err.message.includes('未授权') || err.message.includes('token 已失效')) {
                    send.send_with_At(e, `临时授权已过期，请重新 /${cmdHead} bind 授权`)
                    return true
                }
                throw err
            }

            // 2. 获取存档下载地址
            let saveData
            try {
                saveData = await auth.fetchSaveData()
            } catch (err) {
                if (err.message.includes('未授权') || err.message.includes('token 已失效')) {
                    send.send_with_At(e, `临时授权已过期，请重新 /${cmdHead} bind 授权`)
                    return true
                }
                throw err
            }

            // 3. 下载存档文件
            send.send_with_At(e, "正在更新，请稍等一下哦！>_<", false, { recallMsg: 5 })
            let fileBuffer = await auth.downloadSaveFile(saveData.fileUrl)

            // 4. 检测文件格式并导入
            let isJSON = fileBuffer.length > 0 && fileBuffer[0] === 0x7B // '{'
            let result

            if (isJSON) {
                let jsonStr = fileBuffer.toString('utf8')
                logger.debug('[mil-cloud] 检测到 JSON 格式云存档，直接解析')
                result = getSave.importFromJSON(userId, jsonStr)
            } else {
                logger.debug('[mil-cloud] 检测到二进制格式存档，按 SQLite 导入')
                let dataDir = `${Plugin_Path}/data/saves`
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true })
                }
                let tempPath = `${Plugin_Path}/data/temp_cloud_${userId}.db`
                fs.writeFileSync(tempPath, fileBuffer)
                result = await getSave.importSave(userId, tempPath)
                try { fs.unlinkSync(tempPath) } catch { }
            }

            if (result.success) {
                let updateImg = await renderUpdateImage(userId, result.updateEntry)
                send.send_with_At(e, updateImg)
            } else {
                send.send_with_At(e, `存档导入失败：${result.msg}`)
            }
        } catch (err) {
            logger.error('[mil-cloud] 云端更新失败:', err)
            if (err.message.includes('GameSaveEmptyError')) {
                send.send_with_At(e, '云端没有找到你的存档数据哦！\n请在游戏内上传云存档后再使用更新功能~')
            } else {
                send.send_with_At(e, `云端更新失败：${err.message}`)
            }
        } finally {
            updatingUsers.delete(userId)
        }

        return true
    }

    /**
     * Nya Profiler 更新流程
     */
    async _updateNya(e) {
        let userId = e.user_id

        let nyaApiKey = this._getNyaApiKey()
        if (!nyaApiKey) {
            send.send_with_At(e, '尚未配置 Nya Profiler API Key')
            return true
        }

        // 防重复
        if (updatingUsers.has(userId)) {
            send.send_with_At(e, '你已有一个更新流程在进行中，请稍后~')
            return true
        }

        let nyaAuth = new NyaProfilerAuth(userId, nyaApiKey)

        if (!nyaAuth.isBound()) {
            send.send_with_At(e, `你还没有授权 Re Nya Profiler！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} bind 进行授权`)
            return true
        }

        let username = nyaAuth.getUsername()

        // 0. 缓存有效期检查（以 userId 为 key，避免用户名冲突）
        let ttlHours = this._getNyaCacheTTL()
        let ttlSeconds = ttlHours * 3600
        let cacheAge = NyaProfilerAuth.getCacheAge(userId)
        let cacheBlocked = cacheAge !== null && cacheAge < ttlSeconds

        updatingUsers.add(userId)

        try {
            let queryResult
            let fromCache = false

            if (cacheBlocked) {
                // 缓存有效期内：使用缓存数据（不调用 API）
                queryResult = NyaProfilerAuth.loadCache(userId)
                fromCache = true
                logger.info('[nya-profiler] TTL 保护：使用缓存数据, 缓存时间:', queryResult?.cachedAt)
            } else {
                // 非 TTL 保护期：始终调用 API 获取最新数据，便于 diff 比对
                try {
                    send.send_with_At(e, "正在更新，请稍等一下哦！>_<", false, { recallMsg: 5 })
                    queryResult = await nyaAuth.queryUserData(username)
                    NyaProfilerAuth.saveCache(userId, queryResult)
                } catch (err) {
                    if (err.message.includes('401') || err.message.includes('needAuth')) {
                        nyaAuth.clearToken()
                        send.send_with_At(e, `授权已过期，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
                        return true
                    }
                    // API 失败时尝试使用缓存兜底
                    let cached = NyaProfilerAuth.loadCache(userId)
                    if (cached) {
                        logger.warn('[nya-profiler] API 调用失败，使用缓存数据兜底:', err.message)
                        queryResult = cached
                        fromCache = true
                    } else {
                        throw err
                    }
                }
            }

            if (!queryResult) {
                send.send_with_At(e, '暂无数据，请先完成一次 API 查询')
                return true
            }

            // 捕获旧成绩（必须在导入前，否则 importFromNyaProfiler 内的 saveCache 会覆盖）
            let oldScores = getSave._captureOldScores(userId)

            // 导入到 SaveManager 并合并
            let save = new SaveManager(userId)
            let importResult = save.importFromNyaProfiler(queryResult, getInfo)

            if (!importResult.success) {
                send.send_with_At(e, `数据导入失败：${importResult.msg}`)
                return true
            }

            // 将 save 注册到 getSave 并记录更新
            getSave.saves[userId] = save

            let updateEntry = getSave._recordUpdate(
                userId,
                oldScores,
                save.scores,
                importResult.username
            )

            // 渲染更新图片
            let updateImg = await renderUpdateImage(userId, updateEntry)

            if (cacheBlocked) {
                // TTL 保护提示 + 上次更新结果
                let remainingSec = ttlSeconds - cacheAge
                let remainingMin = Math.ceil(remainingSec / 60)
                let ageMin = Math.floor(cacheAge / 60)
                await send.send_with_At(e,
                    `数据已是最新（${ageMin} 分钟前更新）\n` +
                    `缓存有效期 ${ttlHours} 小时，请 ${remainingMin} 分钟后重试以获取最新数据\n` +
                    `（Nya Profiler 每日仅 5 次下载机会）\n` +
                    `以下为上次更新结果：`,
                    true
                )
                send.send_with_At(e, updateImg)
            } else {
                send.send_with_At(e, updateImg)
            }

        } catch (err) {
            logger.error('[nya-profiler] 更新失败:', err)
            send.send_with_At(e, `查分数据更新失败：${err.message}`)
        } finally {
            updatingUsers.delete(userId)
        }

        return true
    }

    /**
     * 解除授权 - 清空 token（不删除本地存档）
     */
    async unbind(e) {
        let userId = e.user_id

        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()
        let nyaApiKey = this._getNyaApiKey()

        let didUnbind = false

        // 清除 OIDC 授权
        if (clientId) {
            let auth = new MilthmCloudAuth(userId, clientId, clientSecret)
            if (auth.isBound()) {
                auth.clearTokens()
                didUnbind = true
            }
        }

        // 清除 Nya Profiler 授权
        if (nyaApiKey) {
            let nyaAuth = new NyaProfilerAuth(userId, nyaApiKey)
            if (nyaAuth.isBound()) {
                // 先获取用户名再清除
                let username = nyaAuth.getUsername()
                nyaAuth.clearToken()
                // 同时清除缓存（以 userId 为 key）
                if (username) {
                    NyaProfilerAuth.clearCache(userId)
                }
                didUnbind = true
            }
        }

        if (!didUnbind) {
            send.send_with_At(e, '你还没有授权云存档哦~')
            return true
        }

        send.send_with_At(e,
            `已解除授权\n` +
            `云存档授权数据已清除\n` +
            `本地存档数据保留，可用 /${Config.getUserCfg('config', 'cmdhead')} delete 删除\n\n` +
            `如需重新使用云存档，请发送 /${Config.getUserCfg('config', 'cmdhead')} bind 重新授权`
        )

        return true
    }

    // ==================== 工具方法 ====================

    _getClientId() {
        return String(Config.getUserCfg('config', 'client_id') || '').trim()
    }

    _getClientSecret() {
        return String(Config.getUserCfg('config', 'client_secret') || '').trim()
    }

    _getNyaApiKey() {
        return String(Config.getUserCfg('config', 'nya_api_key') || '').trim()
    }

    _getNyaCacheTTL() {
        let val = parseInt(String(Config.getUserCfg('config', 'nyaCacheTTL') || '2'))
        if (isNaN(val) || val < 1) val = 1
        if (val > 24) val = 24
        return val
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/**
 * 根据 Reality 历史数据构建 SVG 折线坐标和日期范围
 * @param {Array<[string, number]>} history
 * @returns {{ rks_history: number[][], rks_date: string[], rks_range: number[] }}
 */
function buildRksHistory(history) {
    if (!history || history.length < 2) {
        return { rks_history: [], rks_date: [], rks_range: [0, 0] }
    }

    let values = history.map(h => h[1])
    let min = Math.min(...values)
    let max = Math.max(...values)
    let yMin = min
    let yMax = max
    if (yMax - yMin < 0.0001) {
        yMin -= 0.01
        yMax += 0.01
    }
    let yRange = yMax - yMin || 1

    let segments = []
    for (let i = 0; i < history.length - 1; i++) {
        let x1 = (i / (history.length - 1)) * 100
        let y1 = ((history[i][1] - yMin) / yRange) * 100
        let x2 = ((i + 1) / (history.length - 1)) * 100
        let y2 = ((history[i + 1][1] - yMin) / yRange) * 100
        segments.push([x1, y1, x2, y2])
    }

    return {
        rks_history: segments,
        rks_date: [history[0][0], history[history.length - 1][0]],
        rks_range: [yMin, yMax]
    }
}

/**
 * 渲染更新图片
 * @param {string} userId
 * @param {object} entry - updateEntry from diff
 * @returns {Promise<any>}
 */
async function renderUpdateImage(userId, entry) {
    let updateLog = getSave.getUpdateLog(userId)
    let realityHistory = updateLog.getRealityHistory()
    let curve = buildRksHistory(realityHistory)

    // 界面展示仅限最近 maxUpdateEntries 条记录，但 Reality 曲线使用完整数据
    let maxEntries = updateLog.getMaxEntries()
    let displayHistory = updateLog.history.slice(0, maxEntries)

    // 构建星星字符串
    let starStr = ''
    for (let i = 0; i < (entry.starLevel || 0); i++) {
        starStr += '★'
    }

    // 随机背景曲绘
    let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

    // 为每条历史记录分配颜色（色轮循环）
    const DATE_COLORS = [
        '#ff82e4', '#82d5ff', '#82ffb4', '#ffe082', '#ff9e82', '#b482ff',
        '#82ffed', '#ff82b4', '#b4ff82', '#82b4ff', '#e482ff', '#ffd582'
    ]
    let dateColorMap = new Map()
    for (let h of displayHistory) {
        if ((h.changes || []).length === 0) continue
        if (!dateColorMap.has(h.date)) {
            dateColorMap.set(h.date, DATE_COLORS[dateColorMap.size % DATE_COLORS.length])
        }
    }

    // 构建 box_line：打平最多 maxUpdateEntries 条记录的卡片 → 5 张/行切分 → 同日期分组
    let allCards = []
    for (let h of displayHistory) {
        let cards = (h.changes || []).slice(0, 6)
        if (cards.length === 0) continue
        let total = h.totalChanges || h._allChangesCount || 0
        let color = dateColorMap.get(h.date) || '#ff82e4'
        for (let card of cards) {
            allCards.push({ card, date: h.date, total, color })
        }
    }

    let rows = []
    for (let i = 0; i < allCards.length; i += 5) {
        rows.push(allCards.slice(i, i + 5))
    }

    let box_line = []
    let shownUpdateNum = new Set()

    for (let row of rows) {
        let time_line = []
        let grouped = new Map()

        for (let item of row) {
            if (!grouped.has(item.date)) {
                grouped.set(item.date, [])
            }
            grouped.get(item.date).push(item)
        }

        for (let [date, items] of grouped) {
            let songs = items.map(item => ({
                song: item.card.song,
                illustration: item.card.illustration,
                Rating: item.card.afterGrade,
                rank: item.card.levelAbbr,
                score_new: item.card.afterScore,
                acc_new: (item.card.afterAccuracy || 0) * 100,
                rks_new: item.card.afterReality || 0,
                isNew: item.card.isNew || false,
                beforeScore: item.card.beforeScore,
                afterScore: item.card.afterScore
            }))

            let total = items[0].total
            let firstRow = !shownUpdateNum.has(date)
            shownUpdateNum.add(date)

            time_line.push({
                date,
                color: items[0].color,
                width: items.length * 155 - 20,
                update_num: (firstRow && total > 6) ? total : 0,
                song: songs
            })
        }
        box_line.push(time_line)
    }

    // 标题栏数据从 history 中取（与曲线同源），避免 entry 参数不一致
    let latestEntry = updateLog.history[0] || entry

    let data = {
        username: latestEntry.username,
        reality: latestEntry.afterReality,
        realityDelta: latestEntry.realityDelta,
        date: latestEntry.date,
        starStr,
        starLevel: latestEntry.starLevel,
        box_line,
        ...curve,
        background: bgIll,
        version: Version.ver
    }

    return await picmodle.update(data)
}
