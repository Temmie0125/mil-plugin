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
                    label: '更新记录保留条数',
                    bottomHelpMessage: '存档更新历史最多保留条数（10~99），超出自动删除最早记录',
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
