/**
 * Milthm 猜曲游戏主入口
 * 支持：开字母 (ltr/letter/开字母) 和 猜曲绘 (guess/猜曲绘)
 */
import Config from '../components/Config.js'
import send from '../model/send.js'
import guessLetter from './milguess/guessLetter.js'
import guessIll from './milguess/guessIll.js'
import getBanGroup from '../model/getBanGroup.js'
import milPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'

/** 游戏触发正则 */
let games = "(guess|猜曲绘|(ltr|letter|开字母).*)"

/** @import {botEvent} from '../components/baseClass.js' */

/**
 * @typedef {Record<string, {gameType: string}>} GameList
 */

/**
 * 进行中的游戏列表
 * @type {GameList}
 */
let gameList = {}

export class MilGames extends milPluginBase {
    constructor() {
        super({
            name: 'mil-games',
            dsc: 'mil-plugin 猜曲游戏',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)${games}$`,
                    fnc: 'start'
                },
                {
                    reg: `^.*$`,
                    fnc: 'guess',
                    log: false
                },
                {
                    reg: `^[#/](出|开|翻|揭|看|翻开|打开|揭开|open)(\\s*)[a-zA-Z\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\d\\S]$`,
                    fnc: 'reveal'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(tip|提示)$`,
                    fnc: 'getTip'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(ans|答案|结束)$`,
                    fnc: 'ans'
                }
            ]
        })
    }

    /**
     * 开始游戏
     * @param {botEvent} e 
     * @returns 
     */
    async start(e) {
        let msg = e.msg.match(new RegExp(games))?.[0]
        if (!e.group_id) {
            send.send_with_At(e, '请在群聊中使用这个功能嗷！')
            return false
        }
        if (gameList[e.group_id]) {
            send.send_with_At(e, `当前存在其他未结束的游戏嗷！想要开启新游戏请发送 /${Config.getUserCfg('config', 'cmdhead')} ans 结束当前游戏嗷！`)
            return false
        }
        if (!msg) {
            return false
        }
        switch (msg) {
            case "guess":
            case "猜曲绘": {

                if (await getBanGroup.get(e, 'guessgame')) {
                    send.send_with_At(e, '这里被管理员禁止使用这个功能了呐QAQ！')
                    return false
                }

                return await guessIll.start(e, gameList)
            }
            default: {
                if (msg.startsWith("ltr") || msg.startsWith("letter") || msg.startsWith("开字母")) {

                    if (await getBanGroup.get(e, 'ltrgame')) {
                        send.send_with_At(e, '这里被管理员禁止使用这个功能了呐QAQ！')
                        return false
                    }

                    return await guessLetter.start(e, gameList)
                }
                return false
            }
        }
    }

    /**
     * 翻开字母
     * @param {botEvent} e 
     * @returns 
     */
    async reveal(e) {
        switch (gameList[e.group_id]?.gameType) {
            case "guessLetter": {
                return await guessLetter.reveal(e, gameList)
            }
            default: {
                return false
            }
        }
    }

    /**
     * 猜测
     * @param {botEvent} e 
     * @returns 
     */
    async guess(e) {
        /** 过滤特殊消息 */
        if (!e.msg) {
            return false;
        }
        /** 过滤Bot自己的消息，防止循环调用 */
        if (e.user_id == Bot.uin || e.user_id == e.self_id){
            return false;
        }
        switch (gameList[e.group_id]?.gameType) {
            case "guessLetter": {
                logger.info(`[mil-games][guess][letter] ${e.msg}`)
                return await guessLetter.guess(e, gameList)
            }
            case "guessIll": {
                logger.info(`[mil-games][guess][ill] ${e.msg}`)
                return await guessIll.guess(e, gameList)
            }
            default: {
                return false
            }
        }
    }

    /**
     * 获取提示
     * @param {botEvent} e 
     * @returns 
     */
    async getTip(e) {
        switch (gameList[e.group_id]?.gameType) {
            case "guessLetter": {
                return await guessLetter.getTip(e, gameList)
            }
            default: {
                return false
            }
        }
    }

    /**
     * 结束游戏
     * @param {botEvent} e 
     * @returns 
     */
    async ans(e) {
        switch (gameList[e.group_id]?.gameType) {
            case "guessLetter": {
                return await guessLetter.ans(e, gameList)
            }
            case "guessIll": {
                return await guessIll.ans(e, gameList)
            }
            default: {
                e.reply(`当前没有进行中的游戏嗷！`)
                return false
            }
        }
    }
}
