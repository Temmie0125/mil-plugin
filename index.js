import fs from 'node:fs'
import chalk from 'chalk'

import getInfo from './model/getInfo.js'
import Version from './components/Version.js'
import Config from './components/Config.js'
import logger from './components/Logger.js'

// 初始化歌曲信息
await getInfo.init()

logger.mark(chalk.rgb(74, 144, 217)('-------☂ Milthm -------'))
logger.mark('正在载入mil插件...')

const files = fs.readdirSync('./plugins/mil-plugin/apps').filter(file => file.endsWith('.js'))
let pend = []

files.forEach((file) => {
    pend.push(import(`./apps/${file}`))
})

let ret = await Promise.allSettled(pend)

/**
 * @type {Record<string, any>}
 */
let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')

    if (ret[i].status != 'fulfilled') {
        console.error(files[i])
        throw new Error(ret[i].reason)
    }
    // @ts-ignore
    apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

export { apps }

logger.mark(chalk.rgb(178, 233, 250)('--------------------------------------'))
logger.mark(chalk.rgb(74, 144, 217)(`|mil-plugin ${Version.ver} 载入完成~`))
logger.mark(chalk.rgb(74, 144, 217)(`|Milthm游戏辅助插件`))
logger.mark(chalk.rgb(178, 233, 250)('--------------------------------------'))
