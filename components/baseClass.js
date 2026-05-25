import plugin from '../../../lib/plugins/plugin.js'
import Config from './Config.js'
import send from "../model/send.js"
import getInfo from '../model/getInfo.js'
import logger from './Logger.js'

/**@typedef {{msg: string} & Object.<string, any>} botEvent */

/** @type {Record<string, {ids: string[], options: any, callback: Function}>} */
const wait_to_chose_song = {}

export default class milPluginBase extends plugin {
    /**
     * @param {object} config
     * @param {string} [config.name="your-plugin"]
     * @param {string} [config.dsc="无"]
     * @param {string} [config.event="message"]
     * @param {number} [config.priority=5000]
     * @param {object[]} [config.rule=[]]
     * @param {string} config.rule[].reg
     * @param {string} config.rule[].fnc
     */
    constructor({
        name = "your-plugin",
        dsc = "无",
        event = "message",
        priority = 5000,
        rule = []
    }) {
        super({
            name, dsc, event, priority,
            // @ts-ignore
            rule
        })
        /** @type {botEvent} */
        this.e = { msg: '' }
    }

    /**
     * @param {botEvent} e
     * @param {string[]} idList
     * @param {any} options
     * @param {Function} callback
     */
    choseMutiNick(e, idList, options, callback) {
        let nickNames = []
        for (let id of idList) {
            let info = getInfo.info(id)
            nickNames.push(`${nickNames.length + 1}. ${info ? info.song : id}`)
        }
        send.send_with_At(e, `找到多个匹配曲目，请发送序号选择：\n${nickNames.join('\n')}`)
        wait_to_chose_song[e.user_id] = {
            ids: idList,
            options,
            callback
        }
        this.setContext('mutiNick', false, Config.getUserCfg('config', 'mutiNickWaitTimeOut') || 30, '操作超时已取消，请注意@BOT进行回复呐！')
    }

    async mutiNick() {
        const { msg } = this.e
        const num = Number(msg.match(/([0-9]+)/)?.[0])
        const ids = wait_to_chose_song[this.e.user_id]?.ids || []
        if (!num) {
            send.send_with_At(this.e, `请输入正确的序号哦！`)
        } else if (!ids[num - 1]) {
            send.send_with_At(this.e, `未找到${num}所对应的曲目哦！`)
        } else {
            wait_to_chose_song[this.e.user_id]?.callback(this.e, ids[num - 1], wait_to_chose_song[this.e.user_id]?.options)
            delete wait_to_chose_song[this.e.user_id]
            this.finish('mutiNick', false)
            return true
        }
    }
}
