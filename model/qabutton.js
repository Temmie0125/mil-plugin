/**
 * QQ 官方 Bot（QQBot 适配器）按钮适配层
 * 在官方 Bot 环境下为常用命令回复附带快捷指令按钮；其他平台返回空数组，不影响发送
 * 按钮统一采用 toCallback 指令按钮：点击后经回调以用户身份发送对应命令，由插件正常响应
 */
import { segment } from "oicq"
import Config from '../components/Config.js'
import logger from '../components/Logger.js'

/** 是否为官方 Bot（QQBot 适配器）环境 */
function isQQBot(e) {
    return e?.adapter_id === 'QQBot' || e?.bot?.adapter?.id === 'QQBot'
}

/** 拼接带命令头的完整命令 */
function cmd(...args) {
    return `#${Config.getUserCfg('config', 'cmdhead')} ${args.filter(Boolean).join(' ')}`
}

/** 指令按钮：点击后自动以用户身份发送命令 */
function cmdBtn(text, command, clickedText = '请稍等…') {
    return { text, callback: command, toCallback: true, clicked_text: clickedText }
}

/** 构建按钮消息段数组；非官方 Bot 环境、无可用按钮或构建失败时返回空数组 */
function build(e, ...rows) {
    if (!isQQBot(e)) return []
    const validRows = rows.filter(row => Array.isArray(row) && row.length > 0)
    if (!validRows.length) return []
    try {
        return [segment.button(...validRows)]
    } catch (err) {
        logger.warn('[mil-plugin] 按钮构建失败，已跳过:', err.message)
        return []
    }
}

export default {
    /**
     * /mil bind 帮助回复按钮
     * @param {*} e 事件对象
     * @param {{hasOIDC?: boolean}} [options] 是否已配置 OIDC（决定是否展示 OIDC绑定 按钮）
     * @returns {Array} 按钮消息段数组，非官方 Bot 环境为空
     */
    bind(e, { hasOIDC = false } = {}) {
        return build(e, [
            ...(hasOIDC ? [cmdBtn('OIDC绑定', cmd('bind', 'OIDC'))] : []),
            cmdBtn('tk帮助', cmd('tk', 'help')),
        ])
    },

    /** 授权成功回复按钮：更新存档 */
    bindSuccess(e) {
        return build(e, [cmdBtn('更新存档', cmd('update'))])
    },

    /** 图鉴回复按钮：B20、查成绩（携带曲名直接查分） */
    atlas(e, songName) {
        const row = [cmdBtn('B20', cmd('b20'))]
        if (songName) row.push(cmdBtn('查成绩', cmd('score', songName)))
        return build(e, row)
    },

    /** 曲绘回复按钮：查成绩（携带曲名）、图鉴 */
    ill(e, songName) {
        if (!songName) return []
        return build(e, [
            cmdBtn('查成绩', cmd('score', songName)),
            cmdBtn('图鉴', cmd('song', songName)),
        ])
    },

    /** B20 回复按钮：更新存档、ap20 */
    b20(e) {
        return build(e, [
            cmdBtn('更新存档', cmd('update')),
            cmdBtn('ap20', cmd('ap20')),
        ])
    },

    /** ap20 回复按钮：更新存档、B20 */
    ap20(e) {
        return build(e, [
            cmdBtn('更新存档', cmd('update')),
            cmdBtn('B20', cmd('b20')),
        ])
    },
}
