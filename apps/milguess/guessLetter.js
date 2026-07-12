/**
 * Milthm 开字母猜曲名游戏
 * 随机抽取 n 首歌曲，隐藏曲名大部分字符，通过翻开字母猜测曲名
 */
import { pinyin } from 'pinyin-pro'

import Config from '../../components/Config.js'
import send from '../../model/send.js'
import logger from '../../components/Logger.js'
import getInfo from '../../model/getInfo.js'
import fCompute from '../../model/fCompute.js'
import picmodle from '../../model/picmodle.js'
import fs from 'fs'

/**
 * @type {string[]}
 */
let songIdList = getInfo.idList || []

/**
 * 存储每首歌曲被抽取的权重
 * @type {Record<string, Record<string, number>>}
 */
let songweights = {}

class LetterGameData {
    /**
     * @param {number} letterNum 曲目数量
     */
    constructor(letterNum = 8) {
        /** 曲目数量 */
        this.letterNum = letterNum
        /** 答案曲名列表 */
        this.ansList = new Array(letterNum).fill('')
        /** 曲目ID列表 */
        this.ansIdList = new Array(letterNum).fill('')
        /** 模糊后的曲名列表 */
        this.blurlist = new Array(letterNum).fill('')
        /** 猜对者列表 */
        this.winnerlist = new Array(letterNum).fill('')
        /** 翻开的字母列表 */
        this.alphalist = []
        /** 上次猜测时间 */
        this.lastGuessedTime = 0
        /** 上次翻开时间 */
        this.lastRevealedTime = 0
        /** 上次提示时间 */
        this.lastTipTime = 0
        /** 上一条谜题板消息ID，发送新题板时用于撤回 */
        this.puzzleMsgId = null
    }
}

/** @type {Record<string, LetterGameData>} */
const letterGameData = {}

/**
 * 存储群聊游戏计时器
 * @type {Record<string, {startTime: number, newTime: number}>}
 */
let timeCount = {}

/**
 * @import {GameList} from '../milguess.js'
 */

export default new class GuessLetter {

    async start(e, gameList) {
        const { group_id } = e

        if (letterGameData[group_id]) {
            e.reply(`已经有群友发起开字母啦，不要重复发起哦！输入'/#第X个 曲名'来猜曲名或'/#出X'来揭开字母！结束请发送 /${Config.getUserCfg('config', 'cmdhead')} ans 嗷！`, true, { recallMsg: 10 })
            return true
        }

        let { msg } = e
        msg = msg.replace(/[#/](.*?)(ltr|letter|开字母)(\s*)/, "")

        // 初始化游戏数据
        letterGameData[group_id] = new LetterGameData(Config.getUserCfg('config', 'LetterNum'))
        const currentGame = letterGameData[group_id]

        if (songIdList.length < currentGame.letterNum) {
            e.reply("曲库中曲目的数量小于开字母的条数哦！更改曲库后需要重启哦！", { recallMsg: 5 })
            delete letterGameData[group_id]
            return true
        }

        if (!songweights[group_id]) {
            songweights[group_id] = {}
        }

        // 将每一首曲目的权重初始化为1
        songIdList.forEach(id => {
            if (!songweights[group_id][id]) {
                songweights[group_id][id] = 1
            } else {
                songweights[group_id][id] *= 1.1
                songweights[group_id][id] = Math.min(songweights[group_id][id], 5)
            }
        })

        let nowTime = Date.now()

        for (let i = 0; i < currentGame.letterNum; i++) {
            let randId = getRandomSong(group_id, songIdList)

            // 防止抽到重复曲目
            let cnnt = 0
            while (currentGame.ansIdList.includes(randId)) {
                ++cnnt
                if (cnnt >= 50) {
                    logger.error(`[mil-plugin][letter] 抽取曲目失败，请检查曲库设置`)
                    e.reply(`抽取曲目失败，请检查曲库设置`, { recallMsg: 10 })
                    delete letterGameData[group_id]
                    return true
                }
                randId = getRandomSong(group_id, songIdList)
            }

            const songs_info = getInfo.info(randId)
            const song_name = getDisplayTitle(songs_info, randId)

            currentGame.ansIdList[i] = randId
            currentGame.ansList[i] = song_name
            currentGame.blurlist[i] = encrypt_song_name(song_name)
            gameList[group_id] = { gameType: "guessLetter" }
            timeCount[group_id] = {
                startTime: nowTime,
                newTime: Date.now() + (1000 * Config.getUserCfg('config', 'LetterTimeLength'))
            }
        }

        // 输出提示
        e.reply(`开字母开启成功！输入'/nx XXXX'猜测曲名，例如：/n1 命日；\n发送'/开X'来揭开字母（不区分大小写），如'/open A'；\n发送'/${Config.getUserCfg('config', 'cmdhead')} ans'结束并查看答案哦！`, true, { recallMsg: 20 })

        await timeout(1000)

        let output = '开字母进行中：\n'
        output += getPuzzle(currentGame)
        const sentMsg = await e.reply(output, true)
        if (sentMsg?.message_id) currentGame.puzzleMsgId = sentMsg.message_id

        /** 超时自动结束 */
        while (timeCount[group_id]?.startTime == nowTime && Date.now() < timeCount[group_id].newTime) {
            await timeout(1000)
        }

        if (!letterGameData[group_id] || nowTime != timeCount[group_id]?.startTime) {
            return false
        }

        if (letterGameData[group_id]) {
            const game = letterGameData[group_id]
            await recallPuzzleMsg(e, game)
            await e.reply('呜，怎么还没有人答对啊QAQ！只能说答案了喵……', true, { recallMsg: 10 })
            e.reply(gameover(group_id, gameList))
            return true
        }
        return true
    }

    /**
     * 翻开字母
     */
    async reveal(e, gameList) {
        const { group_id, msg } = e
        timeCount[group_id] && (timeCount[group_id].newTime = Date.now() + (1000 * Config.getUserCfg('config', 'LetterTimeLength')))

        if (!letterGameData[group_id]) {
            e.reply(`现在还没有进行的开字母捏，赶快输入'/${Config.getUserCfg('config', 'cmdhead')} ltr'开始新的一局吧！`, true, { recallMsg: 10 })
            return false
        }

        const currentGame = letterGameData[group_id]
        const time = Config.getUserCfg('config', 'LetterRevealCd')
        const currentTime = Date.now()
        const timetik = currentTime - currentGame.lastRevealedTime
        const timeleft = Math.floor((1000 * time - timetik) / 1000)

        if (timetik < 1000 * time) {
            e.reply(`翻字符还有${timeleft}s冷却时间呐，先耐心等下哇QAQ`, true, { recallMsg: 10 })
            return true
        }

        currentGame.lastRevealedTime = currentTime
        const newMsg = msg.replace(/([#/](出|开|翻|揭|看|翻开|打开|揭开|open)|\s*)/g, '').match(/./)?.[0]

        if (newMsg) {
            const letter = newMsg.toLowerCase()
            let output = []
            let included = false

            if (currentGame.alphalist.includes(letter.toUpperCase())) {
                e.reply(`字符[ ${letter} ]已经被打开过了ww，不用再重复开啦！`, true, { recallMsg: 10 })
                return true
            }

            for (let i in currentGame.ansList) {
                const songname = currentGame.ansList[i]
                const blurname = currentGame.blurlist[i]
                let characters = ''
                let letters = ''

                if (/[\u4e00-\u9fa5]/.test(songname)) {
                    characters = [...songname].filter(char => /[\u4e00-\u9fa5]/.test(char)).join("")
                    letters = pinyin(characters, { pattern: 'first', toneType: 'none', type: 'string' })
                }

                if (!songname.toLowerCase().includes(letter) && !letters.includes(letter)) {
                    continue
                }

                included = true

                if (!blurname) {
                    continue
                }

                let newBlurname = [...songname].map((char, index) => {
                    if (/^[\u4E00-\u9FFF]$/.test(char)) {
                        return pinyin(char, { pattern: 'first', toneType: 'none', type: 'string' }) === letter ? char : blurname[index]
                    }
                    return char.toLowerCase() === letter ? char : blurname[index]
                }).join('')

                currentGame.blurlist[i] = newBlurname

                if (!newBlurname.includes('*')) {
                    currentGame.blurlist[i] = null
                }
            }

            if (included) {
                currentGame.alphalist = currentGame.alphalist || []
                currentGame.alphalist.push(/^[A-Za-z]+$/g.test(letter) ? letter.toUpperCase() : letter)
                output.push(`成功翻开字母[ ${letter} ]`)
            } else {
                output.push(`这几首曲目中不包含字母[ ${letter} ]`)
            }

            const opened = '当前所有翻开的字符[' + currentGame.alphalist.join(' ') + ']'
            output.push(opened)

            const isEmpty = allGuessed(currentGame)
            await recallPuzzleMsg(e, currentGame)
            if (!isEmpty) {
                output.push('开字母进行中：')
                output.push(getPuzzle(currentGame))
            } else {
                output.unshift('所有字母已翻开，答案如下：')
                output.push(gameover(group_id, gameList))
            }
            const sentMsg = await e.reply(output.join('\n'), true)
            if (sentMsg?.message_id && letterGameData[group_id]) {
                letterGameData[group_id].puzzleMsgId = sentMsg.message_id
            }
            return true
        }
        return false
    }

    /**
     * 猜测
     */
    async guess(e, gameList) {
        const { group_id, msg, user_id, sender } = e
        const currentGame = letterGameData[group_id]
        if (!currentGame) {
            return false
        }

        const time = Config.getUserCfg('config', 'LetterGuessCd')
        const currentTime = Date.now()
        const timetik = currentTime - currentGame.lastGuessedTime
        const timeleft = Math.floor((1000 * time - timetik) / 1000)

        if (timetik < 1000 * time) {
            e.reply(`猜测还有${timeleft}s冷却时间呐，先耐心等下哇QAQ`, true, { recallMsg: 10 })
            return true
        }

        currentGame.lastGuessedTime = currentTime

        const opened = `\n所有翻开的字母[ ${currentGame.alphalist.join(' ')}]\n`
        const regex = /^[#/]\s*[第n]\s*(\d+|[一二三四五六七八九十百]+)\s*[个首\.]?(.*)$/
        const result = msg.match(regex)

        if (!result) {
            return false
        }

        // 真正的猜歌尝试才续期计时器
        timeCount[group_id] && (timeCount[group_id].newTime = Date.now() + (1000 * Config.getUserCfg('config', 'LetterTimeLength')))

        const output = []
        let num = 0

        if (isNaN(result[1])) {
            num = NumberToArabic(result[1])
        } else {
            num = Number(result[1])
        }

        const content = result[2]

        if (num > Config.getUserCfg('config', 'LetterNum')) {
            e.reply(`没有第${num}个啦！看清楚再回答啊喂！`, true, { recallMsg: 10 })
            return true
        }
        if (num < 0) {
            return false
        }

        const ids = getInfo.fuzzysongsnick(content, 0.85)
        const standard_id = currentGame.ansIdList[num]
        const standard_name = currentGame.ansList[num]

        if (!ids[0]) {
            e.reply(`没有找到[${content}]的曲目信息呐QAQ`, true, { recallMsg: 10 })
            return true
        }

        for (const id of ids) {
            if (standard_id === id) {
                // 已经猜完的不能再猜
                if (!currentGame.blurlist[num]) {
                    e.reply(`曲目[${standard_name}]已经猜过了，要不咱们换一个吧uwu`, true, { recallMsg: 10 })
                    return true
                }

                currentGame.blurlist[num] = null

                send.send_with_At(e, `恭喜你ww，答对啦喵，第${num}首答案是[${standard_name}]!`, true)

                /** 发送曲绘（仅水印版，出于版权考虑） */
                const info = getInfo.info(standard_id)
                if (info?.illustration) {
                    switch (Config.getUserCfg('config', 'LetterIllustration')) {
                        case "水印版": {
                            let illData = { illustration: info.illustration, illustrator: Array.isArray(info.illustrator) ? info.illustrator.join(' / ') : (info.illustrator || '') }
                            e.reply(await picmodle.ill(illData))
                            break
                        }
                        default:
                            break
                    }
                }

                currentGame.winnerlist[num] = sender.card
                const isEmpty = allGuessed(currentGame)

                await recallPuzzleMsg(e, currentGame)
                if (!isEmpty) {
                    output.push('开字母进行中：')
                    output.push(opened)
                    output.push(getPuzzle(currentGame))
                    const sentMsg = await e.reply(output.join('\n'), true)
                    if (sentMsg?.message_id) currentGame.puzzleMsgId = sentMsg.message_id
                    return true
                } else {
                    output.push('所有曲目均已被猜出，答案如下：')
                    output.push(gameover(group_id, gameList))
                    await e.reply(output.join('\n'), true)
                    return true
                }
            }
        }

        if (ids[1]) {
            e.reply(`第${num}首不是[${content}]www，要不再想想捏？如果实在不会可以悄悄发个[/${Config.getUserCfg('config', 'cmdhead')} tip]哦`, true, { recallMsg: 10 })
        } else {
            e.reply(`第${num}首不是[${getInfo.info(ids[0])?.song ?? ids[0]}]www，要不再想想捏？如果实在不会可以悄悄发个[/${Config.getUserCfg('config', 'cmdhead')} tip]哦`, true, { recallMsg: 10 })
        }
        return false
    }

    /**
     * 答案
     */
    async ans(e, gameList) {
        const { group_id } = e
        const currentGame = letterGameData[group_id]
        if (!currentGame) {
            e.reply(`现在还没有进行的开字母捏，赶快输入'/${Config.getUserCfg('config', 'cmdhead')} ltr'开始新的一局吧！`, true, { recallMsg: 10 })
            return false
        }

        await recallPuzzleMsg(e, currentGame)
        await e.reply('好吧好吧，既然你执着要放弃，那就公布答案好啦。', true, { recallMsg: 10 })
        e.reply(gameover(group_id, gameList))
        return true
    }

    /**
     * 提示
     */
    async getTip(e, gameList) {
        const { group_id } = e
        const currentGame = letterGameData[group_id]

        if (!currentGame) {
            e.reply(`现在还没有进行的开字母捏，赶快输入'/${Config.getUserCfg('config', 'cmdhead')} ltr'开始新的一局吧！`, true, { recallMsg: 5 })
            return false
        }

        timeCount[group_id] && (timeCount[group_id].newTime = Date.now() + (1000 * Config.getUserCfg('config', 'LetterTimeLength')))

        const time = Config.getUserCfg('config', 'LetterTipCd')
        const currentTime = Date.now()
        const timetik = currentTime - currentGame.lastTipTime
        const timeleft = Math.floor((1000 * time - timetik) / 1000)

        if (timetik < 1000 * time) {
            e.reply(`使用提示还有${timeleft}s冷却时间呐，还请先耐心等下哇QAQ`, true, { recallMsg: 5 })
            return false
        }

        currentGame.lastTipTime = currentTime

        const commonKeys = []
        currentGame.blurlist.forEach((value, index) => {
            if (value) {
                commonKeys.push(index)
            }
        })

        if (commonKeys.length === 0) {
            e.reply('所有字母都已经翻开了，不需要提示啦！', true, { recallMsg: 5 })
            return true
        }

        let randsymbol
        let safety = 0
        while ((typeof randsymbol === 'undefined' || randsymbol === '*') && safety < 100) {
            const key = commonKeys[fCompute.randBetween(0, commonKeys.length - 1)]
            const songname = currentGame.ansList[key]
            if (!currentGame.blurlist[key]) continue
            randsymbol = getRandCharacter(songname, currentGame.blurlist[key])
            safety++
        }

        if (typeof randsymbol === 'undefined' || randsymbol === '*') {
            e.reply('提示出错了QAQ，试试 /ans 吧', { recallMsg: 5 })
            return true
        }

        const output = []

        currentGame.ansList.forEach((value, index) => {
            const songname = value
            let blurname = currentGame.blurlist[index]

            if (!blurname) {
                return
            }

            let newBlurname = ''
            for (let i = 0; i < songname.length; i++) {
                if (/^[\u4E00-\u9FFF]$/.test(songname[i]) && pinyin(songname[i], { pattern: 'first', toneType: 'none', type: 'string' }) == randsymbol.toLowerCase()) {
                    newBlurname += songname[i]
                    continue
                }
                if (songname[i].toLowerCase() == randsymbol.toLowerCase()) {
                    newBlurname += songname[i]
                } else {
                    newBlurname += blurname[i]
                }
            }

            currentGame.blurlist[index] = newBlurname
            if (!newBlurname.includes('*')) {
                currentGame.blurlist[index] = null
            }
        })

        const reg = /^[A-Za-z]+$/g
        if (reg.test(randsymbol)) {
            currentGame.alphalist.push(randsymbol.toUpperCase())
        } else {
            currentGame.alphalist.push(randsymbol)
        }

        output.push(`已经帮你随机翻开一个字符[ ${randsymbol} ]了捏\n`)

        const opened = '当前所有翻开的字符[' + currentGame.alphalist.join(' ') + ']'
        output.push(opened)

        const isEmpty = allGuessed(currentGame)
        await recallPuzzleMsg(e, currentGame)
        if (!isEmpty) {
            output.push('开字母进行中：')
            output.push(getPuzzle(currentGame))
        } else {
            output.unshift('所有字母已翻开，答案如下：')
            output.push(gameover(group_id, gameList))
        }
        const sentMsg = await e.reply(output.join('\n'), true)
        if (sentMsg?.message_id && letterGameData[group_id]) {
            letterGameData[group_id].puzzleMsgId = sentMsg.message_id
        }
        return true
    }
}()


// ========== 辅助函数 ==========

/**
 * 撤回上一条谜题板消息
 * @param {object} e - 事件对象
 * @param {LetterGameData} gameData - 游戏数据
 */
async function recallPuzzleMsg(e, gameData) {
    if (!gameData?.puzzleMsgId) return
    const msgId = Array.isArray(gameData.puzzleMsgId)
        ? gameData.puzzleMsgId[0]
        : gameData.puzzleMsgId
    gameData.puzzleMsgId = null
    try {
        if (e.isGroup && e.group?.recallMsg) {
            await e.group.recallMsg(msgId)
        } else if (e.friend?.recallMsg) {
            await e.friend.recallMsg(msgId)
        }
    } catch { /* 撤回失败不影响游戏流程 */ }
}

function timeout(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms, 'done')
    })
}

/**
 * 根据配置选择用于开字母显示的曲目标题
 * @param {any} songs_info 
 * @param {string} fallbackId 
 * @returns {string}
 */
function getDisplayTitle(songs_info, fallbackId) {
    if (!songs_info) return fallbackId
    const mode = Config.getUserCfg('config', 'LetterTitleMode')
    if (mode === '拉丁文优先' && songs_info.latinTitle) {
        return songs_info.latinTitle
    }
    return songs_info.song || fallbackId
}

function encrypt_song_name(name) {
    // 不提前展示任何字符，全部用 * 隐藏
    const num = 0
    const numset = Array.from({ length: num }, () => {
        let numToShow = fCompute.randBetween(0, name.length - 1)
        while (name[numToShow] == ' ') {
            numToShow = fCompute.randBetween(0, name.length - 1)
        }
        return numToShow
    })

    return Array.from(name, (char, index) => {
        if (numset.includes(index)) {
            return char
        } else if (char === ' ' || char === '\u00A0') {
            return ' '
        } else {
            return '*'
        }
    }).join('')
}

function NumberToArabic(digit) {
    const numberMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    const unitMap = { 十: 10, 百: 100, 千: 1000 }

    const total = digit.split('').reduce((acc, character) => {
        const numberValue = numberMap[character]
        const unitValue = unitMap[character]

        if (numberValue !== undefined) {
            acc.currentUnit = numberValue
        } else if (unitValue !== undefined) {
            acc.currentUnit *= unitValue
            acc.total += acc.currentUnit
            acc.currentUnit = 0
        }
        return acc
    }, { total: 0, currentUnit: 1 })

    return total.total + total.currentUnit
}

function getRandCharacter(str, blur) {
    const temlist = []
    for (let i = 0; i < blur.length; i++) {
        if (blur[i] === '*') {
            temlist.push(i)
        }
    }
    const randomIndex = fCompute.randBetween(0, temlist.length - 1)
    return str.charAt(temlist[randomIndex])
}

function gameover(group_id, gameList) {
    const currentGame = letterGameData[group_id]
    if (!currentGame) return '游戏已结束'
    const t = [...currentGame.ansList]
    const winner = [...currentGame.winnerlist]

    delete letterGameData[group_id]
    delete gameList[group_id]
    delete timeCount[group_id]

    const output = []
    t.forEach((value, index) => {
        const correct_name = value
        const winner_card = winner[index]
        output.push(`【${index}】${correct_name}` + (winner_card ? ` @${winner_card}` : ''))
    })
    return output.join('\n')
}

function allGuessed(currentGame) {
    return currentGame.blurlist.every(v => v === null)
}

function getPuzzle(currentGame) {
    const output = []
    currentGame.ansList.forEach((song, index) => {
        if (currentGame.blurlist[index]) {
            output.push(`【${index}】${currentGame.blurlist[index]}`)
        } else {
            output.push(`【${index}】${song}`)
            if (currentGame.winnerlist[index]) {
                output.push(` @${currentGame.winnerlist[index]}`)
            }
        }
    })
    return output.join('\n')
}

function getRandomSong(group_id, allSelectSongId) {
    const weights = songweights[group_id]
    if (!weights) return allSelectSongId[fCompute.randBetween(0, allSelectSongId.length - 1)]

    const totalWeight = Object.values(weights).reduce((total, weight) => total + weight, 0)
    const randomWeight = fCompute.randFloatBetween(0, totalWeight, 6)

    let accumulatedWeight = 0
    const ids = Object.keys(weights)
    for (const id of ids) {
        const weight = weights[id]
        accumulatedWeight += weight
        if (accumulatedWeight >= randomWeight) {
            weights[id] *= 0.5
            return id
        }
    }

    if (allSelectSongId) {
        return allSelectSongId[fCompute.randBetween(0, allSelectSongId.length - 1)]
    }
    return songIdList[fCompute.randBetween(0, songIdList.length - 1)]
}


