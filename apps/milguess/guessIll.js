/**
 * Milthm 猜曲绘游戏
 * 裁切并模糊曲绘的一部分，玩家通过模糊画面猜出曲目
 * 适配 1:1 和 16:9 多种尺寸的曲绘
 */
import Config from '../../components/Config.js'
import logger from '../../components/Logger.js'
import getInfo from '../../model/getInfo.js'
import send from '../../model/send.js'
import fCompute from '../../model/fCompute.js'
import picmodle from '../../model/picmodle.js'
import Version from '../../components/Version.js'
import fs from 'fs'

/**
 * 所有有曲绘的曲目ID列表
 * @type {string[]}
 */
let songIdList = Object.keys(getInfo.illMap || {}).filter(id => {
    const ill = getInfo.getill(id)
    return ill && fs.existsSync(ill)
})

/**
 * 存储权重
 * @type {Record<string, Record<string, number>>}
 */
let songweights = {}

// 初始洗牌
songIdList = fCompute.randArray(songIdList)

/**
 * @typedef {Object} IllGameData
 * @property {string} id 答案曲目ID
 * @property {string} illustration 曲绘路径
 * @property {number} imgW 曲绘实际宽度
 * @property {number} imgH 曲绘实际高度
 * @property {number} width 裁切窗口宽度
 * @property {number} height 裁切窗口高度
 * @property {number} x 裁切窗口X偏移
 * @property {number} y 裁切窗口Y偏移
 * @property {number} blur 模糊度
 * @property {number|boolean} style 全局视野 (0/1)
 */

/**
 * 答案映射 group_id -> IllGameData
 * @type {Record<string, IllGameData>}
 */
let ansList = {}

/**
 * @type {Record<string, any>}
 */
const eList = {}

/**
 * @import {GameList} from '../milguess.js'
 */

export default new class GuessIll {

    async start(e, gameList) {
        const { group_id } = e

        if (ansList[group_id]) {
            e.reply("请不要重复发起猜曲绘哦！", true)
            return true
        }

        if (songIdList.length == 0) {
            e.reply('当前曲库暂无有曲绘的曲目哦！更改曲库后需要重启哦！')
            return true
        }

        if (!songweights[group_id]) {
            songweights[group_id] = {}
            songIdList.forEach(song => {
                songweights[group_id][song] = 1
            })
        }

        let songId = getRandomSong(group_id)
        let songs_info = getInfo.info(songId)

        let cnnt = 0
        while (!songs_info || !songs_info.illustration) {
            ++cnnt
            if (cnnt >= 50) {
                logger.error(`[mil guess] 抽取曲目失败，请检查曲库设置`)
                e.reply(`抽取曲目失败，请检查曲库设置`)
                return true
            }
            songId = getRandomSong(group_id)
            songs_info = getInfo.info(songId)
        }

        // 读取曲绘实际尺寸
        let illPath = songs_info.illustration
        let imgDims = readPNGDimensions(illPath)
        if (!imgDims) {
            e.reply('读取曲绘失败QAQ')
            return true
        }
        let imgW = imgDims.width
        let imgH = imgDims.height

        // 根据图片尺寸决定裁切窗口大小（为原图的 5%~8% 左右）
        // 以曲绘高度为基准，宽高各自独立随机，避免初始区域泄露原图比例
        let w_ = Math.round(imgH * fCompute.randFloatBetween(0.05, 0.08, 3))
        let h_ = Math.round(imgH * fCompute.randFloatBetween(0.05, 0.08, 3))
        // 确保最小尺寸
        w_ = Math.max(w_, 80)
        h_ = Math.max(h_, 80)
        // 确保不超过原图
        w_ = Math.min(w_, imgW)
        h_ = Math.min(h_, imgH)

        let x_ = fCompute.randBetween(0, imgW - w_)
        let y_ = fCompute.randBetween(0, imgH - h_)
        let blur_ = fCompute.randBetween(8, 14)

        /** @type {IllGameData} */
        let data = {
            id: songs_info.id,
            illustration: illPath,
            imgW,
            imgH,
            width: w_,
            height: h_,
            x: x_,
            y: y_,
            blur: blur_,
            style: 0,
        }

        ansList[group_id] = data
        gameList[group_id] = { gameType: "guessIll" }
        eList[group_id] = e

        /**
         * 剩余可给出的文字提示类型
         * @type {string[]}
         */
        let remain_info = ['chapter', 'artist', 'illustrator']
        /**
         * @type {Record<string, string>}
         */
        let known_info = {}
        /**
         * fnc 类型: 0=区域扩大, 1=模糊度减小, 2=文字提示, 3=全局视野
         * @type {number[]}
         */
        let fnc = [0, 1, 2, 3]

        logger.info(`[mil guess] 开始猜曲绘: ${songs_info.song} (${imgW}x${imgH})`)

        e.reply([
            `下面开始进行猜曲绘哦！回答可以直接发送哦！`,
            `每过${Config.getUserCfg('config', 'GuessTipCd')}秒后将会给出进一步提示。`,
            `发送 /${Config.getUserCfg('config', 'cmdhead')} ans 结束游戏`
        ].join('\n'))

        if (Config.getUserCfg('config', 'GuessTipRecall'))
            await e.reply(await picmodle.guess(buildRenderData(data, false)), false, { recallMsg: Config.getUserCfg('config', 'GuessTipCd') })
        else
            await e.reply(await picmodle.guess(buildRenderData(data, false)))

        /** 单局时间不超过配置的最大时长 */
        const time = Config.getUserCfg('config', 'GuessTipCd')
        const maxLoops = Math.min(Math.floor(Config.getUserCfg('config', 'GuessMaxTime') / time), 30)

        for (let i = 0; i < maxLoops; ++i) {

            for (let j = 0; j < time; ++j) {
                await sleep(1000)
                if (!ansList[group_id] || ansList[group_id].id != data.id) {
                    // 被猜中，发送 gameover + atlas
                    await gameover(e, data)
                    return true
                }
            }

            let tipmsg = ''

            // 选择提示类型
            switch (fnc[fCompute.randBetween(0, fnc.length - 1)]) {
                case 0: {
                    area_increase(imgW, imgH, data, fnc)
                    tipmsg = `[区域扩增!]`
                    break
                }
                case 1: {
                    blur_down(data, fnc)
                    tipmsg = `[清晰度上升!]`
                    break
                }
                case 2: {
                    gave_a_tip(known_info, remain_info, songs_info, fnc)
                    tipmsg = `[追加提示!]`
                    break
                }
                case 3: {
                    data.style = 1
                    fnc.splice(fnc.indexOf(3), 1)
                    tipmsg = `[全局视野!]`
                    break
                }
            }

            if (known_info.chapter) tipmsg += `\n该曲目隶属于 ${known_info.chapter}`
            if (known_info.artist) tipmsg += `\n该曲目的曲师为 ${known_info.artist}`
            if (known_info.illustrator) tipmsg += `\n该曲目曲绘的画师为 ${known_info.illustrator}`

            e = eList[group_id]

            if (!ansList[group_id] || ansList[group_id].id != data.id) {
                await gameover(e, data)
                return true
            }

            let remsg = [await picmodle.guess(buildRenderData(data, false)), tipmsg]

            if (Config.getUserCfg('config', 'GuessTipRecall'))
                e.reply(remsg, false, { recallMsg: Config.getUserCfg('config', 'GuessTipCd') + 1 })
            else
                e.reply(remsg)
        }

        // 最后等待一轮
        for (let j = 0; j < time; ++j) {
            await sleep(1000)
            if (!ansList[group_id] || ansList[group_id].id != data.id) {
                await gameover(e, data)
                return true
            }
        }

        // 超时无人猜对
        e = eList[group_id]
        const expiredId = ansList[group_id]?.id
        delete eList[group_id]
        delete ansList[group_id]
        delete gameList[group_id]
        await e.reply("呜，怎么还没有人答对啊QAQ！只能说答案了喵……")
        if (expiredId) {
            await e.reply(await buildAtlasData(expiredId))
        }
        await gameover(e, data)
        return true
    }

    async guess(e, gameList) {
        const { group_id, msg } = e
        const gameData = ansList[group_id]
        if (!gameData) {
            return false
        }
        eList[group_id] = e
        if (typeof msg === 'string') {
            const ans = msg.replace(/[#/](我)?猜(\s*)/g, '')
            const ids = getInfo.fuzzysongsnick(ans, 0.85)
            if (ids[0]) {
                for (let i in ids) {
                    if (gameData.id == ids[i]) {
                        const correctId = gameData.id
                        delete ansList[group_id]
                        delete gameList[group_id]
                        send.send_with_At(e, '恭喜你，答对啦喵！ヾ(≧▽≦*)o', true)
                        // 发送图鉴图片
                        await e.reply(await buildAtlasData(correctId))
                        // 发送 gameover（显示曲绘截取位置）
                        // await gameover(e, gameData)
                        return true
                    }
                }
                if (ids[1]) {
                    send.send_with_At(e, `不是 ${ans} 哦喵！`, true, { recallMsg: 5 })
                } else {
                    send.send_with_At(e, `不是 ${getInfo.info(ids[0])?.song ?? ids[0]} 哦喵！`, true, { recallMsg: 5 })
                }
                return false
            }
        }
        return false
    }

    async ans(e, gameList) {
        const { group_id } = e
        const gameData = ansList[group_id]
        if (!gameData) {
            return false
        }
        const correctId = gameData.id
        delete ansList[group_id]
        delete gameList[group_id]

        await e.reply('好吧，下面开始公布答案。', true)
        // 发送图鉴图片
        await e.reply(await buildAtlasData(correctId))
        // 发送 gameover
        await gameover(e, gameData)
        return true
    }

    async mix(e) {
        const { group_id } = e

        if (ansList[group_id]) {
            await e.reply(`当前有正在进行的游戏，请等待游戏结束再执行该指令`, true)
            return false
        }

        songIdList = fCompute.randArray(songIdList)

        songweights[group_id] = songweights[group_id] || {}
        songIdList.forEach(song => {
            songweights[group_id][song] = 1
        })

        await e.reply(`洗牌成功了www`, true)
        return true
    }
}()

// ========== 辅助函数 ==========

/**
 * 将游戏数据转为渲染所需格式
 * @param {IllGameData} data
 * @param {boolean} [isAns=false] 是否为答案展示
 */
function buildRenderData(data, isAns = false) {
    return {
        illustration: data.illustration,
        width: data.width,
        height: data.height,
        x: data.x,
        y: data.y,
        blur: isAns ? 0 : data.blur,
        imgW: data.imgW,
        imgH: data.imgH,
        style: isAns ? 1 : data.style,
        ans: isAns ? data.illustration : false,
        filterStyle: (!isAns && data.blur > 0) ? `filter: blur(${data.blur}px);` : (isAns ? 'filter: brightness(50%);' : ''),
    }
}

/**
 * 游戏结束，发送曲绘截取位置提示图
 */
async function gameover(e, data) {
    let rd = buildRenderData(data, true)
    try {
        await e.reply(await picmodle.guess(rd))
    } catch { }
}

/**
 * 构建图鉴渲染数据并返回图片消息
 * @param {string} songId
 * @returns {Promise<any>}
 */
async function buildAtlasData(songId) {
    let infoData = getInfo.info(songId)
    if (!infoData) return `曲目信息不存在 (${songId})`

    /** @type {any[]} */
    let charts = []
    if (infoData.chart) {
        for (let level of fCompute.Level) {
            let chart = infoData.chart[level]
            if (!chart) continue
            charts.push({ ...chart, level, levelAbbr: fCompute.LevelAbbr[level] || level })
        }
    }

    let data = {
        song: infoData.song,
        artist: infoData.artist || '',
        illustrator: infoData.illustrator || [],
        chapter_zh: infoData.chapter_zh || infoData.chapter || '',
        illustration: infoData.illustration || '',
        charts,
        version: Version.ver,
        background: infoData.illustration || ''
    }

    return await picmodle.atlas(data)
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function area_increase(imgW, imgH, data, fnc) {
    let changed = false

    if (data.height < imgH) {
        let increase = Math.round(imgH * fCompute.randFloatBetween(0.03, 0.08, 3))
        increase = Math.max(increase, 20)
        if (data.height + increase >= imgH) {
            data.height = imgH
            data.y = 0
        } else {
            data.height += increase
            data.y = Math.max(0, data.y - Math.round(increase / 2))
            data.y = Math.min(data.y, imgH - data.height)
        }
        changed = true
    }
    if (data.width < imgW) {
        let increase = Math.round(imgW * fCompute.randFloatBetween(0.03, 0.08, 3))
        increase = Math.max(increase, 20)
        if (data.width + increase >= imgW) {
            data.width = imgW
            data.x = 0
            fnc.splice(fnc.indexOf(0), 1)
        } else {
            data.width += increase
            data.x = Math.max(0, data.x - Math.round(increase / 2))
            data.x = Math.min(data.x, imgW - data.width)
        }
        changed = true
    }

    if (!changed) {
        let idx = fnc.indexOf(0)
        if (idx !== -1) fnc.splice(idx, 1)
    }
}

function blur_down(data, fnc) {
    if (data.blur && data.blur > 0) {
        data.blur = Math.max(0, data.blur - 2)
        if (!data.blur) {
            let idx = fnc.indexOf(1)
            if (idx !== -1) fnc.splice(idx, 1)
        }
    } else {
        let idx = fnc.indexOf(1)
        if (idx !== -1) fnc.splice(idx, 1)
    }
}

/**
 * @param {Record<string, string>} known_info
 * @param {string[]} remain_info
 * @param {any} songs_info
 * @param {number[]} fnc
 */
function gave_a_tip(known_info, remain_info, songs_info, fnc) {
    if (!remain_info.length) {
        let idx = fnc.indexOf(2)
        if (idx !== -1) fnc.splice(idx, 1)
        return
    }

    const t = fCompute.randBetween(0, remain_info.length - 1)
    const aim = remain_info[t]
    remain_info.splice(t, 1)

    if (!remain_info.length) {
        let idx = fnc.indexOf(2)
        if (idx !== -1) fnc.splice(idx, 1)
    }

    switch (aim) {
        case 'chapter':
            known_info.chapter = songs_info.chapter_zh || songs_info.chapter || '未知'
            break
        case 'artist':
            known_info.artist = songs_info.artist || '未知'
            break
        case 'illustrator':
            let illustrators = Array.isArray(songs_info.illustrator)
                ? songs_info.illustrator.join(' / ')
                : (songs_info.illustrator || '未知')
            known_info.illustrator = illustrators
            break
    }
}

/**
 * 按权重随机抽取曲目
 */
function getRandomSong(group_id) {
    const weights = songweights[group_id]
    if (!weights) return songIdList[fCompute.randBetween(0, songIdList.length - 1)]

    const totalWeight = Object.values(weights).reduce((total, w) => total + w, 0)
    const randomWeight = fCompute.randFloatBetween(0, totalWeight, 6)

    let accumulatedWeight = 0
    const ids = Object.keys(weights)
    for (const id of ids) {
        const weight = weights[id]
        accumulatedWeight += weight
        if (accumulatedWeight >= randomWeight) {
            weights[id] *= 0.4
            return id
        }
    }

    return songIdList[fCompute.randBetween(0, songIdList.length - 1)]
}

/**
 * 读取 PNG 图片的实际尺寸
 * @param {string} filePath
 * @returns {{width: number, height: number}|null}
 */
function readPNGDimensions(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(24)
        fs.readSync(fd, buf, 0, 24, 0)
        fs.closeSync(fd)

        // 检查PNG签名
        if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
            logger.error(`[mil guess] 不是有效的PNG文件: ${filePath}`)
            return null
        }

        const width = buf.readUInt32BE(16)
        const height = buf.readUInt32BE(20)
        return { width, height }
    } catch (err) {
        logger.error(`[mil guess] 读取PNG尺寸失败: ${filePath}`, err)
        return null
    }
}
