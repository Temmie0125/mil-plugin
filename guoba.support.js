import Config from './components/Config.js'

// 支持锅巴
export function supportGuoba() {
    return {
        pluginInfo: {
            name: 'mil-plugin',
            title: 'Mil-Plugin',
            author: 'Temmie',
            authorLink: 'https://github.com/Temmie0125',
            link: 'https://github.com/Temmie0125/mil-plugin',
            isV3: true,
            isV2: false,
            description: 'Milthm游戏查分及图鉴插件',
            icon: 'game-icons:musical-score',
            iconColor: '#4A90D9'
        },
        configInfo: {
            schemas: [
                {
                    label: '渲染设置',
                    component: 'SOFT_GROUP_BEGIN'
                },
                {
                    field: 'renderScale',
                    label: '渲染精度',
                    bottomHelpMessage: '对所有的图片生效，设置渲染精度',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 50,
                        max: 200,
                        placeholder: '请输入渲染精度',
                        addonAfter: "%"
                    },
                },
                {
                    field: 'randerQuality',
                    label: '渲染质量',
                    bottomHelpMessage: '对所有的图片生效，设置渲染的质量',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 1,
                        max: 100,
                        placeholder: '请输入渲染质量',
                        addonAfter: "%"
                    },
                },
                {
                    field: 'timeout',
                    label: '渲染超时时间',
                    bottomHelpMessage: '对所有的图片生效，超时后重启puppeteer，单位ms',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 1000,
                        max: 120000,
                        placeholder: '请输入渲染超时时间',
                        addonAfter: "ms"
                    },
                },
                {
                    label: '',
                    component: 'Divider'
                },
                {
                    label: '系统设置',
                    component: 'SOFT_GROUP_BEGIN'
                },
                {
                    field: 'B20MaxNum',
                    label: 'B20最大限制',
                    bottomHelpMessage: '用户可以获取B20图片成绩的最大数量',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 20,
                        max: 1000,
                        placeholder: '请输入B20最大限制',
                    },
                },
                {
                    field: 'cmdhead',
                    label: '命令头',
                    bottomHelpMessage: '命令正则匹配开头，不包含#/',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: '请输入命令头',
                    },
                },
                {
                    field: 'mutiNickWaitTimeOut',
                    label: '多个曲目回复序号等待时长',
                    bottomHelpMessage: '别名重复触发多个曲目选择时，等待回复序号的时长，单位：秒',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 5,
                        max: 999,
                        placeholder: '请输入等待时长',
                    },
                },
                {
                    field: 'isGuild',
                    label: '频道模式',
                    bottomHelpMessage: '开启后文字版仅限私聊，关闭文字版图片',
                    component: 'Switch',
                },
                {
                    label: '',
                    component: 'Divider'
                },
                {
                    label: '曲绘资源',
                    component: 'SOFT_GROUP_BEGIN'
                },
                {
                    field: 'illDownloadUrl',
                    label: '曲绘仓库地址',
                    bottomHelpMessage: 'Git 克隆地址，默认 GitHub 仓库',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: 'https://github.com/Temmie0125/mil-plugin-ill',
                    },
                },
                {
                    field: 'githubProxy',
                    label: 'GitHub 代理',
                    bottomHelpMessage: '国内加速用，如 https://gh-proxy.com/，留空则直连',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: '填写false关闭，或填入代理地址',
                    },
                },
                {
                    field: 'autoPullIll',
                    label: '自动更新曲绘',
                    bottomHelpMessage: '插件本体更新后是否自动同步更新曲绘资源',
                    component: 'Switch',
                },
                {
                    label: '',
                    component: 'Divider'
                },
                {
                    label: '云存档设置',
                    component: 'SOFT_GROUP_BEGIN'
                },
                {
                    field: 'maxUpdateEntries',
                    label: '更新记录条数',
                    bottomHelpMessage: '存档更新历史最多显示的曲目条数（10~99），超出的将不显示在图片中',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 10,
                        max: 99,
                        placeholder: '请输入保留条数（10~99）',
                    },
                },
                {
                    field: 'client_id',
                    label: 'Client ID',
                    bottomHelpMessage: 'Milthm 云存档 OIDC 客户端 ID，留空则禁用云存档功能',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: '请输入 client_id',
                    },
                },
                {
                    field: 'client_secret',
                    label: 'Client Secret',
                    bottomHelpMessage: 'Milthm 云存档 OIDC 客户端密钥，留空则禁用云存档功能',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: '请输入 client_secret',
                        type: 'password',
                    },
                },
                {
                    label: '',
                    component: 'Divider'
                },
                {
                    field: 'nya_api_key',
                    label: 'Nya Profiler API Key',
                    bottomHelpMessage: 'Re Nya Profiler API Key，在 https://renya.mhtl.im/apikey 创建。优先级低于官方 OIDC，仅当 client_id 未配置时才使用此接口',
                    component: 'Input',
                    required: false,
                    componentProps: {
                        placeholder: '请输入 Nya Profiler API Key',
                        type: 'password',
                    },
                },
                {
                    field: 'nyaCacheTTL',
                    label: 'Nya 缓存有效期（小时）',
                    bottomHelpMessage: '缓存有效期内重复请求将提示等待，避免浪费每日下载次数（上限5次/天）。最小1小时，默认2小时',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 1,
                        max: 24,
                        placeholder: '请输入缓存有效期（1~24小时）',
                    },
                },
                {
                    label: '',
                    component: 'Divider'
                },
                {
                    label: '娱乐功能设置',
                    component: 'SOFT_GROUP_BEGIN'
                },
                {
                    label: '开字母设置',
                    component: 'Divider'
                },
                {
                    field: 'LetterNum',
                    label: '曲目数量',
                    bottomHelpMessage: '每局开字母抽取的曲目数量',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 5,
                        max: 12,
                        placeholder: '请输入曲目数量（5~12）',
                    },
                },
                {
                    field: 'LetterTimeLength',
                    label: '单局时长（秒）',
                    bottomHelpMessage: '超时后无人猜对将自动结束并公布答案',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 60,
                        max: 1200,
                        placeholder: '请输入秒数',
                    },
                },
                {
                    field: 'LetterRevealCd',
                    label: '翻字母冷却（秒）',
                    bottomHelpMessage: '群内翻开字母的全局冷却时间',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 0,
                        max: 60,
                        placeholder: '请输入秒数',
                    },
                },
                {
                    field: 'LetterGuessCd',
                    label: '猜测冷却（秒）',
                    bottomHelpMessage: '群内猜测的全局冷却时间',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 0,
                        max: 30,
                        placeholder: '请输入秒数',
                    },
                },
                {
                    field: 'LetterTipCd',
                    label: '提示冷却（秒）',
                    bottomHelpMessage: '群内使用提示的全局冷却时间',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 0,
                        max: 60,
                        placeholder: '请输入秒数',
                    },
                },
                {
                    field: 'LetterIllustration',
                    label: '展示曲绘',
                    bottomHelpMessage: '出于版权考虑，仅支持水印版或不展示',
                    component: 'Select',
                    required: true,
                    componentProps: {
                        options: [
                            { label: '水印版', value: '水印版' },
                            { label: '不展示', value: '不展示' },
                        ],
                    },
                },
                {
                    field: 'LetterTitleMode',
                    label: '曲目标题模式',
                    bottomHelpMessage: '影响开字母中隐藏/显示的曲目标题。默认优先中文，拉丁文优先更适合开字母玩法',
                    component: 'Select',
                    required: true,
                    componentProps: {
                        options: [
                            { label: '默认（中文优先）', value: '默认' },
                            { label: '拉丁文优先', value: '拉丁文优先' },
                        ],
                    },
                },
                {
                    label: '猜曲绘设置',
                    component: 'Divider'
                },
                {
                    field: 'GuessTipCd',
                    label: '提示间隔（秒）',
                    bottomHelpMessage: '每隔多少秒给出一次进一步提示（区域扩大/模糊降低/文字提示/全局视野）',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 5,
                        max: 60,
                        placeholder: '请输入秒数',
                    },
                },
                {
                    field: 'GuessTipRecall',
                    label: '提示自动撤回',
                    bottomHelpMessage: '每次新提示发出后是否自动撤回上一张图',
                    component: 'Switch',
                },
                {
                    field: 'GuessMaxTime',
                    label: '单局最大时长（秒）',
                    bottomHelpMessage: '超时后无人猜对将自动结束并公布答案',
                    component: 'InputNumber',
                    required: true,
                    componentProps: {
                        min: 60,
                        max: 600,
                        placeholder: '请输入秒数',
                    },
                },
            ],
            getConfigData() {
                const defset = Config.getdefSet('config')
                let config = {}
                for (var i in defset) {
                    config[i] = Config.getUserCfg('config', i)
                }
                return config
            },
            setConfigData(data, { Result }) {
                for (let [keyPath, value] of Object.entries(data)) {
                    Config.modify('config', keyPath, value)
                }
                return Result.ok({}, '保存成功~')
            },
        },
    }
}
