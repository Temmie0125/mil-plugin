/**
 * Milthm 云存档命令
 * - /mil bind   : 授权 Milthm 云存档（Device Auth 流程，token 自动续期）
 * - /mil update : 从云端下载并导入最新存档
 * - /unbind     : 解除授权（不删除本地存档）
 */
import Config from '../components/Config.js'
import send from '../model/send.js'
import getSave from '../model/getSave.js'
import milPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'
import MilthmCloudAuth from '../components/MilthmCloudAuth.js'
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
     */
    async bind(e) {
        let userId = e.user_id

        // 检查配置
        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()
        if (!clientId) {
            send.send_with_At(e, '❌ 尚未配置 client_id，请联系 Bot 主人在 Guoba 面板中填写 Milthm 云存档的 client_id 和 client_secret')
            return true
        }

        // 检查是否已经在授权中
        if (bindingUsers.has(userId)) {
            send.send_with_At(e, '⏳ 你已有一个授权流程在进行中，请先完成或等待超时~')
            return true
        }

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        // 检查是否已授权且 token 有效
        if (auth.isBound()) {
            let isValid = await auth.ensureValidToken()
            if (isValid) {
                send.send_with_At(e, `✅ 你已授权 Milthm 云存档，Token 自动续期中，无需重复授权\n如需更换账号，请先使用 /unbind 解除授权`)
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
            send.send_with_At(e, `❌ 发起设备授权失败：${err.message}`)
            return true
        }

        // 发送授权链接给用户，120 秒后自动撤回
        send.send_with_At(e,
            `Milthm 云存档授权\n` +
            `请点击下方链接完成授权：\n${deviceAuthInfo.verification_uri_complete}\n\n` +
            `或手动输入用户码: ${deviceAuthInfo.user_code}\n` +
            `授权码有效期: ${deviceAuthInfo.expires_in} 秒\n\n` +
            `⚠️ 链接将在 120 秒后撤回，请尽快完成授权\n` +
            `⚠️ 3 分钟内未完成授权将自动取消`,
            false,
            { recallMsg: 120 }
        )

        // 开始轮询（3 分钟超时自动取消）
        bindingUsers.add(userId)
        try {
            await this._pollLoop(e, auth, deviceAuthInfo, { timeoutSec: 180 })
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
    async _pollLoop(e, auth, deviceAuthInfo, { timeoutSec } = {}) {
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
                send.send_with_At(e, '❌ 轮询授权状态时发生错误，请稍后重试')
                return
            }

            if (result.success) {
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
                send.send_with_At(e, '❌ 授权被拒绝，操作已取消')
                return
            }

            if (result.error === 'expired') {
                send.send_with_At(e, `⌛ 授权码已过期，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
                return
            }

            // 其他错误
            if (slowDownCount > 2) {
                send.send_with_At(e, `⚠️ 授权轮询出现异常，请检查链接是否已授权。如需帮助请联系 Bot 主人`)
                return
            }
        }

        // 超时
        if (wasCancelled || timeoutSec) {
            send.send_with_At(e, `⌛ 授权已超时自动取消（${timeoutSec || effectiveExpire} 秒内未完成），请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
        } else {
            send.send_with_At(e, `⌛ 授权等待超时，请重新 /${Config.getUserCfg('config', 'cmdhead')} bind 授权`)
        }
    }

    /**
     * 从云端更新存档
     */
    async updateSave(e) {
        let userId = e.user_id

        // 检查配置
        let clientId = this._getClientId()
        let clientSecret = this._getClientSecret()
        if (!clientId) {
            send.send_with_At(e, '❌ 尚未配置 client_id，请联系 Bot 主人在 Guoba 面板中填写')
            return true
        }

        // 防重复
        if (updatingUsers.has(userId)) {
            send.send_with_At(e, '⏳ 你已有一个更新流程在进行中，请稍后~')
            return true
        }

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        if (!auth.isBound()) {
            send.send_with_At(e, `❌ 你还没有授权 Milthm 云存档！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} bind 进行授权`)
            return true
        }

        updatingUsers.add(userId)
        send.send_with_At(e, '⏳ 正在从云端获取存档信息...', true)

        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        try {
            // 1. 获取存档信息（预览）
            let saveInfo
            try {
                saveInfo = await auth.fetchSaveInfo()
            } catch (err) {
                if (err.message.includes('未授权') || err.message.includes('token 已失效')) {
                    send.send_with_At(e, `❌ 临时授权已过期，请重新 /${cmdHead} bind 授权`)
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
                    send.send_with_At(e, `❌ 临时授权已过期，请重新 /${cmdHead} bind 授权`)
                    return true
                }
                throw err
            }

            send.send_with_At(e, '⏳ 正在下载存档文件...', true)

            // 3. 下载存档文件
            let fileBuffer = await auth.downloadSaveFile(saveData.fileUrl)

            // 4. 检测文件格式并导入
            // JSON 格式（云存档直接返回）：以 '{' 开头
            // SQLite 格式：以 'SQLite format 3' 二进制头开头
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
                let metaStr = ''
                if (saveInfo.meta) {
                    try {
                        let meta = typeof saveInfo.meta === 'string'
                            ? JSON.parse(saveInfo.meta)
                            : saveInfo.meta
                        metaStr = `\nReality: ${meta.reality_value || '?'}`
                            + ` | AP: ${meta.ap_count || 0} FC: ${meta.fc_count || 0}`
                            + ` | 更新时间: ${meta.date || '?'}`
                    } catch { }
                }

                send.send_with_At(e,
                    `云存档更新成功！\n` +
                    `用户名：${result.username}\n` +
                    `数据来源：${result.saveType || 'save'}${metaStr}\n` +
                    `共导入 ${getSave.saves[userId]?.scores?.length || 0} 条成绩记录\n\n` +
                    `现在可以查询成绩了~`
                )
            } else {
                send.send_with_At(e, `❌ 存档导入失败：${result.msg}`)
            }
        } catch (err) {
            logger.error('[mil-cloud] 云端更新失败:', err)
            send.send_with_At(e, `❌ 云端更新失败：${err.message}`)
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

        let auth = new MilthmCloudAuth(userId, clientId, clientSecret)

        if (!auth.isBound()) {
            send.send_with_At(e, '你还没有授权 Milthm 云存档哦~')
            return true
        }

        // 清除 token
        auth.clearTokens()
        // 本地存档由 /delete 命令管理，解绑不删除

        send.send_with_At(e,
            `已解除授权\n` +
            `Milthm 云存档授权数据已清除\n` +
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

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
