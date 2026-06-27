import Config from '../components/Config.js'
import send from '../model/send.js'
import getInfo from '../model/getInfo.js'
import fCompute from '../model/fCompute.js'
import picmodle from '../model/picmodle.js'
import milPluginBase from '../components/baseClass.js'
import Version from '../components/Version.js'
import fs from 'fs'
import { segment } from "oicq"

/**@import {botEvent} from '../components/baseClass.js' */

export class milsong extends milPluginBase {
    constructor() {
        super({
            name: 'mil-图鉴',
            dsc: 'Milthm图鉴',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(曲|song|图鉴).*$`,
                    fnc: 'song'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(曲绘|ill|Ill).*$`,
                    fnc: 'ill'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)alias.*$`,
                    fnc: 'alias'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(设置别名|setnic(k?)).*$`,
                    fnc: 'setnick'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)tips$`,
                    fnc: 'tips'
                }
            ]
        })
    }

    /**
     * 曲目图鉴（图像渲染）
     */
    async song(e) {
        let msg = e.msg.replace(/[#/](.*?)(曲|song|图鉴)(\s*)/, "")
        if (!msg) {
            send.send_with_At(e, `请指定曲名哦！\n格式：/${Config.getUserCfg('config', 'cmdhead')} song <曲名>`)
            return true
        }
        let ids = getInfo.fuzzysongsnick(msg)
        if (ids[0]) {
            if (!ids[1]) {
                send.send_with_At(e, await renderAtlas(ids[0]))
            } else {
                this.choseMutiNick(e, ids, {}, async (e, id) => {
                    send.send_with_At(e, await renderAtlas(id))
                })
            }
        } else {
            send.send_with_At(e, `未找到"${msg}"的相关曲目信息QAQ, 如果想要投稿别名可前往别名提案申请填写表：https://www.kdocs.cn/wo/sl/v12VZ1RD`)
        }
        return true
    }

    /**
     * 曲绘
     */
    async ill(e) {
        let msg = e.msg.replace(/[#/](.*?)(曲绘|ill|Ill)(\s*)/, "")
        if (!msg) {
            send.send_with_At(e, `请指定曲名哦！\n格式：/${Config.getUserCfg('config', 'cmdhead')} ill <曲名>`)
            return true
        }
        let ids = getInfo.fuzzysongsnick(msg)
        if (ids[0]) {
            if (!ids[1]) {
                await sendIll(e, ids[0])
            } else {
                this.choseMutiNick(e, ids, {}, async (e, id) => {
                    await sendIll(e, id)
                })
            }
        } else {
            send.send_with_At(e, `未找到"${msg}"的相关曲目信息QAQ, 如果想要投稿别名可前往别名提案申请填写表：https://www.kdocs.cn/wo/sl/v12VZ1RD`)
        }
        return true
    }

    /**
     * 别名查询
     */
    async alias(e) {
        let msg = e.msg.replace(/[#/](.*?)alias(\s*)/, "")
        let ids = getInfo.fuzzysongsnick(msg)
        if (ids[0]) {
            if (!ids[1]) {
                await makeNickMsg(e, ids[0])
            } else {
                this.choseMutiNick(e, ids, {}, async (e, id) => {
                    await makeNickMsg(e, id)
                })
            }
        } else {
            send.send_with_At(e, `未找到"${msg}"的相关曲目信息QAQ！如果想要投稿别名可前往别名提案申请填写表：https://www.kdocs.cn/wo/sl/v12VZ1RD`)
        }
        return true
    }

    /**
     * 设置别名
     */
    async setnick(e) {
        if (!(e.is_admin || e.isMaster)) {
            e.reply("只有管理员可以设置别名哦！")
            return true
        }
        let msg = e.msg.replace(/[#/](.*?)(设置别名|setnic(k?))(\s*)/g, "")
        let parts = []
        if (msg.includes("--->")) {
            msg = msg.replace(/(\s*)--->(\s*)/g, " ---> ")
            parts = msg.split(" ---> ")
        } else if (msg.includes("\n")) {
            parts = msg.split("\n")
        } else {
            let lastSpaceIdx = msg.lastIndexOf(' ')
            if (lastSpaceIdx > 0) {
                parts = [msg.substring(0, lastSpaceIdx), msg.substring(lastSpaceIdx + 1)]
            }
        }
        if (parts[0] && parts[1]) {
            let P0Ids = getInfo.fuzzysongsnick(parts[0].trim())
            if (P0Ids[0]) {
                await getInfo.setnick(P0Ids[0], parts[1].trim())
                e.reply(`设置完成！已将 "${parts[1].trim()}" 设为 "${getInfo.idgetsong(P0Ids[0])}" 的别名`)
            } else {
                e.reply(`没有找到"${parts[0].trim()}"这首曲子呢！`)
            }
        } else {
            e.reply(`输入有误哦！请按照\n原名（或已有别名） ---> 别名\n的格式发送！`)
        }
        return true
    }

    /**
     * 随机tips
     */
    async tips(e) {
        let tips = getInfo.tips
        if (tips && tips.length > 0) {
            let tip = tips[fCompute.randBetween(0, tips.length - 1)].replace(/(\r\n|\n|\r)/gm, "")
            // 获取发送者昵称
            let nickname = e.sender?.nickname || e.member?.nick || e.user_id || "你"
            tip = tip.replace(/\{Name\}/g, nickname)
            send.send_with_At(e, tip)
        } else {
            send.send_with_At(e, '暂无tips~')
        }
        return true
    }
}

/**
 * 渲染曲目图鉴
 */
async function renderAtlas(id) {
    let infoData = getInfo.info(id)
    if (!infoData) return `未找到${id}的曲目信息QAQ！`

    let charts = []
    for (let level of fCompute.Level) {
        let chart = infoData.chart[level]
        if (!chart) continue
        charts.push({ ...chart, level, levelAbbr: fCompute.LevelAbbr[level] || level })
    }

    let data = {
        song: infoData.song,
        artist: infoData.artist || '',
        illustrator: infoData.illustrator || [],
        chapter_zh: infoData.chapter_zh || infoData.chapter || '',
        illustration: infoData.illustration || '',
        charts,
        version: Version.ver,
        background: infoData.illustration || '', // 使用该曲目的曲绘作为背景
        Original: infoData.Original || false
    }

    return await picmodle.atlas(data)
}

/**
 * 发送曲绘（带水印）
 */
async function sendIll(e, id) {
    let info = getInfo.info(id)
    if (!info) {
        send.send_with_At(e, `未找到${id}的曲目信息QAQ！`)
        return
    }
    let illPath = info.illustration
    if (illPath && fs.existsSync(illPath)) {
        let illustrator = Array.isArray(info.illustrator) ? info.illustrator.join(', ') : info.illustrator || '未知'
        let illImg = await picmodle.ill({
            illustration: illPath,
            illustrator
        })
        send.send_with_At(e, [
            illImg,
            `\n${info.song} - ${info.artist}\n画师：${illustrator}`
        ])
    } else {
        send.send_with_At(e, `未找到"${info.song}"的曲绘文件QAQ`)
    }
}

/**
 * 别名信息（曲绘带水印）
 */
async function makeNickMsg(e, id) {
    let info = getInfo.info(id)
    if (!info) {
        send.send_with_At(e, `未找到${id}的曲目信息QAQ！如果想要投稿别名可前往别名提案申请填写表：https://www.kdocs.cn/wo/sl/v12VZ1RD`)
        return
    }
    let nicks = new Set()
    let usernick = Config.getUserCfg('nickconfig')
    for (let nick of fCompute.objectKeys(usernick)) {
        if (usernick[nick].includes(id)) nicks.add(nick)
    }
    if (getInfo.nicklist) {
        for (let nick of fCompute.objectKeys(getInfo.nicklist)) {
            if (getInfo.nicklist[nick].includes(id)) nicks.add(nick)
        }
    }

    let illPath = info.illustration
    let illustrator = Array.isArray(info.illustrator) ? info.illustrator.join(', ') : info.illustrator || '未知'
    let msgParts = [`name: ${info.song}\n========\n已有别名：\n${[...nicks].slice(0, 30).join('\n') || '无'}`]
    if (illPath && fs.existsSync(illPath)) {
        let illImg = await picmodle.ill({
            illustration: illPath,
            illustrator
        })
        msgParts.unshift(illImg)
    }
    send.send_with_At(e, msgParts)
}
