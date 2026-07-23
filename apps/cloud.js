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
import { buildRksHistory, renderUpdateImage } from '../model/updateRender.js'
import milPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'

import MilthmCloudAuth from '../components/MilthmCloudAuth.js'
import NyaProfilerAuth from '../components/NyaProfilerAuth.js'
import UserSettingsStore from '../model/userSettings.js'
import SaveManager from '../model/SaveManager.js'
import QRCode from 'qrcode'
import { segment } from 'oicq'
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
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(bind|绑定)(\\s*)(.*)$`,
                    fnc: 'bind'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(tk|token)(\\s+)(help)(\\s*)$`,
                    fnc: 'tkHelp'
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
     * 授权云存档
     * - /mil bind OIDC  → OIDC Device Auth 流程
     * - /mil bind <token> → 直接绑定 API 令牌
     * - /mil bind         → 无参提示
     */
    async bind(e) {
        let userId = e.user_id
        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        // 解析参数
        let arg = e.msg.replace(new RegExp(`^[#/]${cmdHead}\\s*(bind|绑定)\\s*`, 'i'), '').trim()

        if (arg && arg.toUpperCase() === 'OIDC') {
            // OIDC 流程
            let clientId = this._getClientId()
            if (!clientId) {
                send.send_with_At(e, '尚未配置 OIDC client_id！\n请联系 Bot 主人在 Guoba 面板中填写，或使用 `/mil bind <token>` 直接绑定 API 令牌')
                return true
            }
            return await this._bindOIDC(e)
        }

        if (arg && arg.length > 20) {
            // 直接令牌绑定
            return await this._bindWithToken(e, arg)
        }

        // 无参数：检查是否已绑定
        let clientId = this._getClientId()
        let nyaApiKey = this._getNyaApiKey()

        // 检查 OIDC 绑定状态
        if (clientId) {
            let auth = new MilthmCloudAuth(userId, clientId, this._getClientSecret())
            if (await auth.isBound()) {
                let isValid = await auth.ensureValidToken()
                if (isValid) {
                    send.send_with_At(e, `你已通过 OIDC 授权 Milthm 云存档~\n如需更换账号，请先使用 /${cmdHead} unbind 解除授权\n或使用 /${cmdHead} bind <token> 直接绑定 API 令牌`)
                    return true
                }
            }
        }

        // 检查直接令牌绑定状态
        if (!clientId) {
            let auth = new MilthmCloudAuth(userId, '', '')
            await auth.loadToken()
            if (auth.isDirectTokenMode()) {
                send.send_with_At(e, `你已通过 API 令牌绑定 Milthm 云存档~\n如需更换，请先使用 /${cmdHead} unbind 解除授权`)
                return true
            }
        }

        // 检查 Nya Profiler
        if (nyaApiKey) {
            let nyaAuth = new NyaProfilerAuth(userId, nyaApiKey)
            if (await nyaAuth.isBound()) {
                send.send_with_At(e, `你已授权 Re Nya Profiler 查分器~\n如需更换账号，请先使用 /${cmdHead} unbind 解除授权`)
                return true
            }
        }

        // 未绑定，显示帮助
        let hasClientId = !!clientId
        let hint = hasClientId
            ? `\n  /${cmdHead} bind OIDC      通过OIDC流程授权`
            : ''
        send.send_with_At(e,
            `请提供token或者使用OIDC进行授权哦！\n` +
            `命令格式：\n` +
            `  /${cmdHead} bind <token>  使用API令牌直接绑定${hint}\n\n` +
            `⚠️ Token 为敏感信息，建议私聊 Bot 进行绑定以避免泄露\n` +
            `使用/${cmdHead} tk help 获取token帮助`
        )
        return true
    }

    /**
     * 直接令牌绑定流程（用户自行创建的 API Token）
     * @param e - 事件对象
     * @param {string} token - Authorization 头值（如 "Basic xxx"）
     */
    async _bindWithToken(e, token) {
        let userId = e.user_id
        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        let auth = new MilthmCloudAuth(userId, '', '')
        await auth.bindWithToken(token)

        // 验证令牌有效性
        try {
            let cloudUser = await auth.fetchCloudUser()
            if (!cloudUser.username) {
                throw new Error('无法获取用户名，请检查令牌权限是否包含 profile')
            }

            // 设置在线模式
            let save = getSave.saves[userId]
            if (!save) {
                save = new SaveManager(userId)
                getSave.saves[userId] = save
            }
            save.ensureLoaded()  // 确保从磁盘加载已有存档数据，避免空覆盖
            save.setOnlineMode('milkloud')
            save.cloudUsername = cloudUser.username
            save.saveCache()

            // 尝试撤回含 Token 的命令消息（群内防止泄露）
            let recallNote = ''
            try {
                let msgId = Array.isArray(e.message_id)
                    ? e.message_id[0]
                    : e.message_id
                if (e.isGroup && e.group?.recallMsg) {
                    await e.group.recallMsg(msgId)
                    recallNote = ''
                } else if (e.friend?.recallMsg) {
                    await e.friend.recallMsg(msgId)
                    recallNote = ''
                } else if (e.isGroup) {
                    recallNote = '\n⚠️ 请手动撤回含 Token 的命令消息，避免泄露！'
                }
            } catch { /* 撤回失败不影响主流程 */ }

            send.send_with_At(e,
                `令牌绑定成功！\n` +
                `已绑定账号: ${cloudUser.username}\n` +
                `现在可以使用 /${cmdHead} update 更新云端存档~${recallNote}`
            )
        } catch (err) {
            await auth.clearTokens()
            if (err.message.includes('[invalid_grant]')) {
                send.send_with_At(e, `令牌验证失败：令牌无效或已过期，请检查后重试\n使用/${cmdHead} tk help 获取帮助`)
            } else {
                send.send_with_At(e, `令牌验证失败：${err.message}\n请检查令牌是否正确，使用/${cmdHead} tk help 获取帮助`)
            }
        }

        return true
    }

    /**
     * API 令牌获取帮助
     */
    async tkHelp(e) {
        let cmdHead = Config.getUserCfg('config', 'cmdhead')
        let helpImg = `${Plugin_Path}/resources/doc/tkhelp.png`
        let msg = [
            `=== Milkloud API 令牌获取指南 ===`,
            ``,
            `1. 前往 Milkloud 官网 (milkloud.milthm.cn)`,
            `2. 登录后进入「令牌管理」页面`,
            `3. 创建新令牌，勾选以下权限：`,
            `   • openid`,
            `   • profile`,
            `   • milthm:save:read`,
            `   • milthm:event:recent`,
            `   • milthm:stats:best_performance`,
            `4. 复制生成的完整 Authorization 头（形如 Basic xxx）`,
            `5. 使用 /${cmdHead} bind <令牌> 绑定`,
            ``,
            `提示：令牌不依赖 Bot 端配置，可直接使用`,
        ].join('\n')

        if (fs.existsSync(helpImg)) {
            await send.send_with_At(e, [msg, segment.image(`file:///${helpImg.replace(/\\/g, '/')}`)])
        } else {
            await send.send_with_At(e, msg)
        }
        return true
    }

    /**
     * 发送授权消息（官Bot模式适配）
     * 官Bot 模式下将授权链接转为二维码图片，普通模式发送文本链接
     * @param e - 事件对象
     * @param url - 授权链接
     * @param userCode - 用户码（OIDC 流程，可选）
     * @param type - 授权类型 ('oidc' | 'nya')
     */
    async _sendAuthMessage(e, url, userCode = null, type = 'oidc') {
        if (Config.getUserCfg('config', 'officialBotMode')) {
            // 官Bot模式：生成二维码图片
            let qrBuf
            try {
                qrBuf = await QRCode.toBuffer(url, { width: 300, margin: 2 })
            } catch (err) {
                logger.error('[mil-cloud] 二维码生成失败:', err)
                // 降级：发送文本链接
                let fallbackMsg = userCode
                    ? `Milthm 云存档授权\n请在浏览器打开以下链接完成授权：\n${url}\n或手动输入用户码: ${userCode}`
                    : `Re Nya Profiler 查分器授权\n请在浏览器打开以下链接完成授权：\n${url}`
                return await send.send_with_At(e, fallbackMsg, false, { recallMsg: 120 })
            }

            // 写入临时文件并发送图片
            let qrPath = `${Plugin_Path}/data/temp_qr_${e.user_id}.png`
            try {
                fs.writeFileSync(qrPath, qrBuf)
            } catch (err) {
                logger.error('[mil-cloud] 二维码文件写入失败:', err)
                return await send.send_with_At(e, '二维码生成失败，请稍后重试~')
            }

            let imgSegment = segment.image(qrPath)
            let promptText = userCode
                ? `Milthm 云存档授权\n请使用手机扫描下方二维码完成授权\n用户码: ${userCode}\n\n链接将在授权完成后撤回，请尽快完成授权\n3 分钟内未完成授权将自动取消`
                : `Re Nya Profiler 查分器授权\n请使用手机扫描下方二维码完成授权\n\n链接将在授权完成后撤回，请尽快完成授权\n2 分钟内未完成授权将自动取消`

            let authMsg = await send.send_with_At(e, [imgSegment, `\n${promptText}`], false, { recallMsg: 120 })

            // 异步清理临时文件
            setTimeout(() => {
                try { fs.unlinkSync(qrPath) } catch { }
            }, 5000)

            return authMsg
        } else {
            // 普通模式：发送文本链接
            let msgText = userCode
                ? `Milthm 云存档授权\n` +
                  `请在浏览器打开下方链接完成授权：\n${url}\n` +
                  `或手动输入用户码: ${userCode}\n\n` +
                  `链接将在授权完成后撤回，请尽快完成授权\n` +
                  `3 分钟内未完成授权将自动取消`
                : `Re Nya Profiler 查分器授权\n` +
                  `请在浏览器打开下方链接完成授权：\n${url}\n\n` +
                  `链接将在授权完成后撤回，请尽快完成授权\n` +
                  `2 分钟内未完成授权将自动取消`

            return await send.send_with_At(e, msgText, false, { recallMsg: 120 })
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
        if (await auth.isBound()) {
            let isValid = await auth.ensureValidToken()
            if (isValid) {
                let missing = await auth.getMissingScopes()
                if (missing.length === 0) {
                    send.send_with_At(e, `你已授权 Milthm 云存档，Token 自动续期中，无需重复授权\n如需更换账号，请先使用 /unbind 解除授权`)
                    return true
                }
                // Scope 不全，允许直接重新授权覆盖
                send.send_with_At(e,
                    `检测到授权 Scope 缺少: ${missing.join(', ')}\n` +
                    `正在重新发起授权以获取完整权限...`,
                    false, { recallMsg: 10 }
                )
            }
            // token 已过期，清除旧 token 并继续新授权流程
            if (!isValid) {
                await auth.clearTokens()
                logger.debug('[mil-cloud] 用户旧 token 已过期，自动清除')
            }
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

        // 发送授权消息（官Bot模式自动转二维码）
        let authMsg = await this._sendAuthMessage(
            e,
            deviceAuthInfo.verification_uri_complete,
            deviceAuthInfo.user_code,
            'oidc'
        )

        // 开始轮询（3 分钟超时自动取消）
        let timeoutSec = 180
        bindingUsers.add(userId)
        // 兜底超时清理：确保即使异常导致 finally 未执行，用户也不会被永久锁定
        let cleanupTimer = setTimeout(() => bindingUsers.delete(userId), (timeoutSec + 30) * 1000)
        try {
            await this._pollLoop(e, auth, deviceAuthInfo, { timeoutSec, authMessage: authMsg })
        } finally {
            clearTimeout(cleanupTimer)
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
        if (await nyaAuth.isBound()) {
            send.send_with_At(e,
                `你已授权 Re Nya Profiler 查分器\n` +
                `当前绑定用户名: ${await nyaAuth.getUsername()}\n` +
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

        // 发送授权消息（官Bot模式自动转二维码）
        let authMsg = await this._sendAuthMessage(
            e,
            authInfo.url,
            null,
            'nya'
        )

        // 开始轮询（2 分钟超时）
        let nyaTimeoutSec = 120
        bindingUsers.add(userId)
        // 兜底超时清理：确保即使异常导致 finally 未执行，用户也不会被永久锁定
        let nyaCleanupTimer = setTimeout(() => bindingUsers.delete(userId), (nyaTimeoutSec + 30) * 1000)
        try {
            let username = await nyaAuth.pollAuthLoop(authInfo.uuid, nyaTimeoutSec, 3)

            // 设置在线模式
            let saveNya = getSave.saves[e.user_id]
            if (!saveNya) {
                saveNya = new SaveManager(e.user_id)
                getSave.saves[e.user_id] = saveNya
            }
            saveNya.ensureLoaded()  // 确保从磁盘加载已有存档数据，避免空覆盖
            saveNya.setOnlineMode('nya_profiler')
            saveNya.saveCache()

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
            clearTimeout(nyaCleanupTimer)
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

                // 设置在线模式
                let saveBind = getSave.saves[e.user_id]
                if (!saveBind) {
                    saveBind = new SaveManager(e.user_id)
                    getSave.saves[e.user_id] = saveBind
                }
                saveBind.ensureLoaded()  // 确保从磁盘加载已有存档数据，避免空覆盖
                saveBind.setOnlineMode('milkloud')
                saveBind.saveCache()

                // 尝试获取用户名用于确认绑定账号
                let usernameHint = ''
                try {
                    let cloudUser = await auth.fetchCloudUser()
                    if (cloudUser.username) {
                        usernameHint = `\n已绑定账号: ${cloudUser.username}`
                    }
                } catch (err) {
                    logger.warn('[mil-cloud] 获取用户名失败，跳过:', err.message)
                }
                if (!usernameHint){
                    logger.warn('[mil-cloud] 无法获取用户名，请检查端点配置')
                }
                send.send_with_At(e,
                    `授权成功！${usernameHint}\n` +
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

        // 优先级：OIDC 配置 > 直接令牌 > Nya Profiler
        if (clientId) {
            return await this._updateOIDC(e)
        }

        // 检查直接令牌绑定（优先于 Nya Profiler）
        let directAuth = new MilthmCloudAuth(e.user_id, '', '')
        await directAuth.loadToken()
        if (directAuth.isDirectTokenMode()) {
            return await this._updateOIDC(e)
        }

        if (nyaApiKey) {
            return await this._updateNya(e)
        }

        send.send_with_At(e, '尚未配置云存档接口！\n请联系 Bot 主人在 Guoba 面板中填写相关配置，或使用 `/mil bind <token>` 绑定 API 令牌')
        return true
    }

    /**
     * 官方 OIDC 更新流程
     */
    async _updateOIDC(e) {
        let userId = e.user_id

        // OIDC 配置（直接令牌模式下可为空）
        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()

        // 防重复
        if (updatingUsers.has(userId)) {
            send.send_with_At(e, '你已有一个更新流程在进行中，请稍后~')
            return true
        }

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        if (!(await auth.isBound())) {
            send.send_with_At(e, `你还没有授权 Milthm 云存档！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} bind 进行授权`)
            return true
        }

        updatingUsers.add(userId)

        // 检查 scope 是否完整
        let missingScopes = await auth.getMissingScopes()
        if (missingScopes.length > 0) {
            await send.send_with_At(e,
                `⚠️ 授权 Scope 缺少: ${missingScopes.join(', ')}\n` +
                `建议使用 /${Config.getUserCfg('config', 'cmdhead')} bind 重新授权（无需 unbind）`,
                true
            )
        }

        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        try {
            send.send_with_At(e, "正在更新，请稍等一下哦！>_<", false, { recallMsg: 5 })
            // 1. 确保本地有存档管理器（加载缓存数据）
            let save = getSave.saves[userId]
            if (!save) {
                save = new SaveManager(userId)
                getSave.saves[userId] = save
            }
            save.ensureLoaded()
            let hasLocalData = save.scores.length > 0

            // 2. 获取 Milthm 云用户名（优先缓存）
            let cloudUsername = save.cloudUsername || null
            if (!cloudUsername) {
                try {
                    let cloudUser = await auth.fetchCloudUser()
                    cloudUsername = cloudUser.username
                    if (cloudUsername) {
                        save.cloudUsername = cloudUsername
                        save.saveCache()
                        logger.info(`[mil-cloud] 云用户名已缓存: ${cloudUsername}`)
                    }
                } catch (err) {
                    if (err.message.includes('invalid_grant')) {
                        send.send_with_At(e, `授权已过期，请重新 /${cmdHead} bind 授权`)
                        return true
                    }
                    logger.warn('[mil-cloud] 获取用户信息失败:', err.message)
                }
            }

            // 3. 获取云端 Rank + Recent 数据（轻量，不消耗存档限额）
            let rankData = null
            let recentRecords = null
            if (cloudUsername) {
                try {
                    rankData = await auth.fetchRankData(cloudUsername)
                    logger.info(`[mil-cloud] Rank 获取成功`)
                } catch (err) {
                    if (err.message.includes('invalid_grant')) {
                        send.send_with_At(e, `授权已过期，请重新 /${cmdHead} bind 授权`)
                        return true
                    }
                    logger.warn('[mil-cloud] 获取 Rank 失败:', err.message)
                }
                try {
                    recentRecords = await auth.fetchRecentData(cloudUsername)
                    logger.info(`[mil-cloud] Recent 获取成功: ${recentRecords?.length} 条`)
                } catch (err) {
                    if (err.message.includes('invalid_grant')) {
                        send.send_with_At(e, `授权已过期，请重新 /${cmdHead} bind 授权`)
                        return true
                    }
                    logger.warn('[mil-cloud] 获取 Recent 失败:', err.message)
                }
            }

            // 加载用户个人设置（用于模式筛选）
            let userSettings = UserSettingsStore.getSettings(userId)
            let userMode = userSettings.cloudMode || 'touch'

            // 按平台标记 rank 数据，构建 cloudRealities 对象
            let cloudRealities = {
                touchReality: rankData?.touchReality || null,
                keyboardReality: rankData?.keyboardReality || null
            }

            // 计算用户当前模式对应的云端 Reality（用于比对）
            let cloudRealityForMode = userMode === 'touch'
                ? (cloudRealities.touchReality || 0)
                : userMode === 'keyboard'
                    ? (cloudRealities.keyboardReality || 0)
                    : Math.max(cloudRealities.touchReality || 0, cloudRealities.keyboardReality || 0)

            // 合并双端 reality（取最高，兼容旧字段）
            let cloudReality = Math.max(
                cloudRealities.touchReality || 0,
                cloudRealities.keyboardReality || 0
            )

            // PC 端玩家提示：用户首次使用且默认触屏模式，但只有键盘数据
            if (UserSettingsStore.isFirstTime(userId) &&
                (cloudRealities.touchReality || 0) === 0 &&
                (cloudRealities.keyboardReality || 0) > 0) {
                send.send_with_At(e,
                    `💡 检测到你似乎主要在 PC 端游玩（键盘 Reality: ${cloudRealities.keyboardReality.toFixed(2)}，触屏 Reality: 0）\n` +
                    `可使用 #${cmdHead} myset mode keyboard 切换至键盘模式查看成绩。`,
                    true
                )
            }

            // 4. 用 rank/recent 数据补充本地存档，判断是否需要全量更新
            let needFullUpdate = !hasLocalData
            let recentUpdateEntry = null

            if (!needFullUpdate && recentRecords && recentRecords.length > 0) {
                // 捕获旧成绩用于 diff
                let oldScores = getSave._captureOldScores(userId)

                // 导入 rank（权威 B20，按平台标记后再合并）先于 recent
                let touchTagged = (rankData?.touchRanks || []).map(r => ({ ...r, _cloudMode: 'touch' }))
                let keyboardTagged = (rankData?.keyboardRanks || []).map(r => ({ ...r, _cloudMode: 'keyboard' }))
                let allRanks = [...touchTagged, ...keyboardTagged]
                if (allRanks.length > 0) {
                    save.importFromCloudRank(allRanks, cloudRealities)
                }
                // 存储纯云端 Best 数据（用于在线模式 B20 计算）
                save.cloudBestData = allRanks
                save.importFromCloudRecent(recentRecords)

                // 生成更新条目（无论是否触发全量更新都要记录 diff）
                recentUpdateEntry = getSave._recordUpdate(userId, oldScores, save.scores, save.username || 'Unknown')

                // 比对 Reality 决定是否全量（使用用户模式的云端 Reality，向下取整后比较）
                let localB20 = save.getB20WithReality(20, getInfo, userMode)
                let localReality = localB20.reality

                if (cloudRealityForMode != null && cloudRealityForMode > 0) {
                    let cloudFloored = fCompute.floorReality(cloudRealityForMode)
                    let localFloored = fCompute.floorReality(localReality)
                    let diff = cloudFloored - localFloored
                    if (diff >= 0.01) {
                        // 云端高于本地 → 有新在线成绩未同步，触发全量更新
                        needFullUpdate = true
                        logger.warn(`[mil-cloud] 云端高于本地 (diff=+${diff.toFixed(4)})，触发全量更新`)
                    } else if (diff <= -0.01) {
                        // 本地高于云端 → 可能含离线成绩，已是最全，无需下载
                        logger.info(`[mil-cloud] 本地高于云端 (diff=${diff.toFixed(4)})，可能含离线成绩，跳过全量更新`)
                    } else {
                        logger.info(`[mil-cloud] Reality 一致 (diff=${diff.toFixed(4)})，跳过全量更新`)
                    }
                    // 逐曲诊断（diff > 0.001 时打印详情）
                    if (diff > 0.001 && rankData) {
                        let localMap = {}
                        for (let s of localB20.scores) {
                            if (s._reality != null) localMap[s.chart_id] = s._reality
                        }
                        let allDiagRanks = [...(rankData.touchRanks || []), ...(rankData.keyboardRanks || [])]
                            .sort((a, b) => (b.reality || 0) - (a.reality || 0))
                        let mismatches = []
                        for (let r of allDiagRanks.slice(0, 20)) {
                            let lr = localMap[r.chart_id]
                            if (lr != null) {
                                let d = Math.abs((r.reality || 0) - lr)
                                if (d > 0.001) mismatches.push(`${r.chart_id?.slice(0,8)} c=${(r.reality||0).toFixed(4)} l=${lr.toFixed(4)} Δ${d.toFixed(4)}`)
                            } else {
                                mismatches.push(`${r.chart_id?.slice(0,8)} c=${(r.reality||0).toFixed(4)} l=缺失`)
                            }
                        }
                        if (mismatches.length > 0) {
                            logger.info(`[mil-cloud] 逐曲差异(${mismatches.length}首):\n  ${mismatches.join('\n  ')}`)
                        }
                    }
                }
            }

            // 5. 全量更新或跳过
            if (needFullUpdate) {

                let saveData
                try {
                    saveData = await auth.fetchSaveData()
                } catch (err) {
                    if (err.message.includes('invalid_grant')) {
                        send.send_with_At(e, `临时授权已过期，请重新 /${cmdHead} bind 授权`)
                        return true
                    }
                    if (err.message.includes('GameSaveDownloadLimitExceededError') || err.message.includes('Download limit reached')) {
                        send.send_with_At(e, '今日存档下载次数已达上限（5次/天），请明天再试~\n（提示：数据已通过 Rank/Recent 接口同步，不影响日常查分）')
                        return true
                    }
                    throw err
                }

                let fileBuffer
                try {
                    fileBuffer = await auth.downloadSaveFile(saveData.fileUrl)
                } catch (err) {
                    if (err.message.includes('Download limit reached') || err.message.includes('429')) {
                        send.send_with_At(e, '今日存档下载次数已达上限（5次/天），请明天再试~\n（提示：数据已通过 Rank/Recent 接口同步，不影响日常查分）')
                        return true
                    }
                    throw err
                }

                let isJSON = fileBuffer.length > 0 && fileBuffer[0] === 0x7B
                let result

                if (isJSON) {
                    let jsonStr = fileBuffer.toString('utf8')
                    logger.debug('[mil-cloud] 检测到 JSON 格式云存档，直接解析')
                    result = getSave.importFromJSON(userId, jsonStr, { noRecord: true })
                } else {
                    logger.debug('[mil-cloud] 检测到二进制格式存档，按 SQLite 导入')
                    let dataDir = `${Plugin_Path}/data/saves`
                    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
                    let tempPath = `${Plugin_Path}/data/temp_cloud_${userId}.db`
                    fs.writeFileSync(tempPath, fileBuffer)
                    result = await getSave.importSave(userId, tempPath, { noRecord: true })
                    try { fs.unlinkSync(tempPath) } catch { }
                }

                if (!result.success) {
                    send.send_with_At(e, `存档导入失败：${result.msg}`)
                    return true
                }

                // 全量导入后再用 rank/recent 富化（按平台标记）
                // 注意：importSave 内部创建了新的 SaveManager，需恢复在线模式属性
                save = getSave.saves[userId]
                save.setOnlineMode('milkloud')
                if (cloudUsername) save.cloudUsername = cloudUsername
                let touchTagged2 = (rankData?.touchRanks || []).map(r => ({ ...r, _cloudMode: 'touch' }))
                let keyboardTagged2 = (rankData?.keyboardRanks || []).map(r => ({ ...r, _cloudMode: 'keyboard' }))
                let allRanks2 = [...touchTagged2, ...keyboardTagged2]
                if (allRanks2.length > 0) {
                    save.importFromCloudRank(allRanks2, cloudRealities)
                }
                // 存储纯云端 Best 数据（用于在线模式 B20 计算）
                save.cloudBestData = allRanks2
                if (recentRecords && recentRecords.length > 0) {
                    save.importFromCloudRecent(recentRecords)
                }

                // 富化后再记录更新条目，确保 Reality 和成绩与 b20 命令一致
                let updateEntry = getSave._recordUpdate(
                    userId,
                    result._oldScores ?? null,
                    save.scores,
                    save.username || result.username || 'Unknown'
                )

                let updateImg = await renderUpdateImage(userId, updateEntry)
                send.send_with_At(e, updateImg)

                // Reality 不一致提示（使用用户模式的 Reality）
                let localB20 = save.getB20WithReality(20, getInfo, userMode)
                let finalDiff = cloudRealityForMode != null
                    ? fCompute.floorReality(cloudRealityForMode) - fCompute.floorReality(localB20.reality) : 0
                if (cloudRealityForMode != null && cloudRealityForMode > 0 && Math.abs(finalDiff) >= 0.01) {
                    let reason = finalDiff > 0
                        ? '云端有新成绩未同步或定数变更'
                        : '本地可能含离线成绩，或 info.json 定数需更新'
                    await send.send_with_At(e,
                        `⚠️ 云端 (${cloudRealityForMode.toFixed(4)}) 与本地 (${localB20.reality.toFixed(4)}) 不一致\n` +
                        `差值: ${finalDiff.toFixed(4)} | ${reason}`,
                        true
                    )
                }
            } else {
                let hasChanges = recentUpdateEntry && recentUpdateEntry.totalChanges > 0
                if (hasChanges) {
                    let updateImg = await renderUpdateImage(userId, recentUpdateEntry)
                    send.send_with_At(e, updateImg)
                }
                let localRlt = save.getB20WithReality(20, getInfo, userMode).reality
                let note = (cloudRealityForMode != null && localRlt - cloudRealityForMode > 0.01)
                    ? ' | 本地含离线成绩，已是最全'
                    : ' | 数据一致'
                let noChangesHint = !hasChanges ? '\n暂无新成绩变动~' : ''
                send.send_with_At(e,
                    `云端 Reality(${userMode === 'touch' ? '触屏' : userMode === 'keyboard' ? '键盘' : '合并'}): ${cloudRealityForMode?.toFixed(4) || '未知'}${note}（未触发全量下载）${noChangesHint}`,
                    true
                )
            }
        } catch (err) {
            logger.error('[mil-cloud] 云端更新失败:', err)
            if (err.message.includes('GameSaveEmptyError')) {
                send.send_with_At(e, '云端没有找到你的存档数据哦！\n请在游戏内上传云存档后再使用更新功能~')
            } else if (err.message.includes('GameSaveDownloadLimitExceededError') || err.message.includes('Download limit reached')) {
                send.send_with_At(e, '今日存档下载次数已达上限（5次/天），请明天再试~')
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

        if (!(await nyaAuth.isBound())) {
            send.send_with_At(e, `你还没有授权 Re Nya Profiler！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} bind 进行授权`)
            return true
        }

        let username = await nyaAuth.getUsername()

        // 0. 缓存有效期检查（以 userId 为 key，避免用户名冲突）
        let ttlHours = this._getNyaCacheTTL()
        let ttlSeconds = ttlHours * 3600
        let cacheAge = await NyaProfilerAuth.getCacheAge(userId)
        let cacheBlocked = cacheAge !== null && cacheAge < ttlSeconds

        updatingUsers.add(userId)

        try {
            let queryResult
            let fromCache = false

            if (cacheBlocked) {
                // 缓存有效期内：使用缓存数据（不调用 API）
                queryResult = await NyaProfilerAuth.loadCache(userId)
                fromCache = true
                logger.info('[nya-profiler] TTL 保护：使用缓存数据, 缓存时间:', queryResult?.cachedAt)
            } else {
                // 非 TTL 保护期：始终调用 API 获取最新数据，便于 diff 比对
                try {
                    send.send_with_At(e, "正在更新，请稍等一下哦！>_<", false, { recallMsg: 5 })
                    queryResult = await nyaAuth.queryUserData(username)
                    await NyaProfilerAuth.saveCache(userId, queryResult)
                } catch (err) {
                    if (err.message.includes('401') || err.message.includes('needAuth')) {
                        await nyaAuth.clearToken()
                        send.send_with_At(e, `授权已过期，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
                        return true
                    }
                    // API 失败时尝试使用缓存兜底
                    let cached = await NyaProfilerAuth.loadCache(userId)
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
            // 恢复在线模式属性（新 SaveManager 默认为离线）
            save.setOnlineMode('nya_profiler')

            // 存储 Nya Profiler Best 数据（纯在线，用于在线模式 B20）
            let nyaBestData = [...(queryResult.best20 || []), ...(queryResult.extras || [])]
            save.cloudBestData = nyaBestData.map(r => ({
                ...r,
                _cloudMode: r._cloudMode || 'touch',
                _cloudReality: r.singleRating,
                // 统一字段名：Nya API 使用 accuracy，内部统一使用 score_accuracy
                score_accuracy: r.accuracy ?? r.score_accuracy ?? 0
            }))

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
            if (await auth.isBound()) {
                await auth.clearTokens()
                didUnbind = true
            }
        }

        // 清除 Nya Profiler 授权
        if (nyaApiKey) {
            let nyaAuth = new NyaProfilerAuth(userId, nyaApiKey)
            if (await nyaAuth.isBound()) {
                // 先获取用户名再清除
                let username = await nyaAuth.getUsername()
                await nyaAuth.clearToken()
                // 同时清除缓存（以 userId 为 key）
                if (username) {
                    await NyaProfilerAuth.clearCache(userId)
                }
                didUnbind = true
            }
        }

        // 清除直接令牌（API Token）绑定
        let directAuth = new MilthmCloudAuth(userId, '', '')
        await directAuth.loadToken()
        if (directAuth.isDirectTokenMode()) {
            await directAuth.clearTokens()
            didUnbind = true
        }

        if (!didUnbind) {
            send.send_with_At(e, '你还没有授权云存档哦~')
            return true
        }

        // 切换至离线模式，清除云端 Best 数据
        let saveUnbind = getSave.saves[userId]
        if (saveUnbind) {
            saveUnbind.ensureLoaded()  // 确保从磁盘加载已有存档数据，避免空覆盖
            saveUnbind.setOfflineMode()
            saveUnbind.cloudBestData = []
            saveUnbind.saveCache()
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
