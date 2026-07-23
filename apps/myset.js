/**
 * 个人设置命令
 * #mil myset — 查看/修改个人设置（平台模式选择）
 */
import Config from '../components/Config.js'
import send from '../model/send.js'
import getInfo from '../model/getInfo.js'
import fCompute from '../model/fCompute.js'
import picmodle from '../model/picmodle.js'
import UserSettingsStore from '../model/userSettings.js'
import milPluginBase from '../components/baseClass.js'
import Version from '../components/Version.js'

/** 平台模式元数据 */
const CLOUD_MODE_META = {
    cloudMode: {
        key: 'cloudMode',
        title: '平台模式',
        description: '选择查看触屏（移动端）或键盘（PC）平台的成绩。已绑定云平台时自动使用在线数据，未绑定时使用本地存档计算。',
        aliases: ['cloudMode', 'cloudmode', 'mode', '模式', '平台', 'cloud']
    }
}

/** 平台模式选项 */
const CLOUD_MODE_OPTIONS = {
    cloudMode: {
        touch:    { value: 'touch',    title: '[0] 触屏模式',    description: '仅显示触屏（移动端）成绩（默认）' },
        keyboard: { value: 'keyboard', title: '[1] 键盘模式',    description: '仅显示PC键盘端成绩' },
        merge:    { value: 'merge',    title: '[2] 合并模式',    description: '显示所有平台成绩' }
    }
}

/** mode 值 → 标题 */
const MODE_TITLE = {
    touch: '触屏模式',
    keyboard: '键盘模式',
    merge: '合并模式'
}

/** mode 值 → 序号 */
const MODE_INDEX = { touch: 0, keyboard: 1, merge: 2 }
/** 序号 → mode 值 */
const INDEX_MODE = { 0: 'touch', 1: 'keyboard', 2: 'merge' }

export class milsetting extends milPluginBase {
    constructor() {
        super({
            name: 'mil-setting',
            dsc: 'Milthm个人设置',
            event: 'message',
            priority: 100,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(myset|个人设置|用户设置)(\\s*.*)?$`,
                    fnc: 'showUserSetting'
                }
            ]
        })
    }

    /**
     * 显示 / 修改个人设置
     * @param {object} e - Yunzai bot 事件对象
     */
    async showUserSetting(e) {
        let userId = e.user_id
        let settings = UserSettingsStore.getSettings(userId)
        let cmdHead = Config.getUserCfg('config', 'cmdhead')

        // 解析参数
        let msg = e.msg || ''
        // 去掉命令前缀，提取参数部分
        let rawArgs = msg
            .replace(new RegExp(`^[#/]${cmdHead}\\s*(myset|个人设置|用户设置)\\s*`, 'i'), '')
            .trim()

        if (rawArgs) {
            // 规范化参数：将 ：:= 替换为空格
            let normalized = rawArgs
                .replace(/[：:=]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
            let args = normalized.split(' ')

            if (args.length >= 2) {
                // 查找匹配的设置键
                let settingKey = null
                let settingMeta = null
                for (let key of Object.keys(CLOUD_MODE_META)) {
                    let meta = CLOUD_MODE_META[key]
                    if (meta.aliases.some(a => a.toLowerCase() === args[0].toLowerCase())) {
                        settingKey = key
                        settingMeta = meta
                        break
                    }
                }

                if (settingMeta) {
                    // 解析值
                    let rawValue = args[1]
                    let optionMap = CLOUD_MODE_OPTIONS[settingKey]
                    let newValue = null

                    // 尝试直接匹配 value
                    if (optionMap[rawValue]) {
                        newValue = rawValue
                    } else {
                        // 尝试序号匹配
                        let idx = parseInt(rawValue, 10)
                        if (!isNaN(idx) && INDEX_MODE[idx]) {
                            newValue = INDEX_MODE[idx]
                        } else {
                            // 尝试中文/英文别名匹配
                            for (let key of Object.keys(optionMap)) {
                                if (key.toLowerCase() === rawValue.toLowerCase() ||
                                    optionMap[key].title.includes(rawValue)) {
                                    newValue = key
                                    break
                                }
                            }
                        }
                    }

                    if (newValue) {
                        settings[settingKey] = newValue
                        UserSettingsStore.saveSettings(userId, settings)
                        send.send_with_At(e, `✅ 已切换至 ${MODE_TITLE[newValue]}`)
                        // 修改成功后也展示面板
                    } else {
                        // 无效值：展示选项
                        let validValues = Object.values(optionMap).map(o => o.title).join('、')
                        send.send_with_At(e, `无效的模式值，可选：${validValues}\n或者使用数字序号 0/1/2`)
                        return true
                    }
                } else {
                    send.send_with_At(e, `未知设置项，当前仅支持：${Object.values(CLOUD_MODE_META).map(m => m.aliases[0]).join('、')}`)
                    return true
                }
            } else {
                // 参数不足
                send.send_with_At(e, `用法：#${cmdHead} myset mode <触屏/键盘/合并>\n例如：#${cmdHead} myset mode 1`)
                return true
            }
        }

        // 重新加载最新设置
        settings = UserSettingsStore.getSettings(userId)
        let currentMode = settings.cloudMode || 'touch'

        // 构建模板数据
        let optionMap = CLOUD_MODE_OPTIONS.cloudMode
        let items = [
            {
                key: 'cloudMode',
                title: '平台模式',
                description: '选择查看触屏（移动端）或键盘（PC）平台的成绩。已绑定云平台时自动使用在线数据，未绑定时使用本地存档。切换后即时生效，无需重新更新。',
                currentTitle: MODE_TITLE[currentMode] || '触屏模式',
                options: Object.values(optionMap).map(opt => ({
                    value: opt.value,
                    title: opt.title,
                    description: opt.description,
                    selected: opt.value === currentMode
                }))
            }
        ]
        // 随机背景曲绘
        let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

        let data = {
            pageTitle: 'mil-plugin 个人设置',
            background: bgIll,
            pageDescription: '以下选项为你的个人偏好设置，影响成绩查询展示。',
            items,
            cmdHead,
            version: Version.ver
        }

        let img = await picmodle.myset(data)
        send.send_with_At(e, img)
        return true
    }
}
