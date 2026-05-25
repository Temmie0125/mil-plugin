import lodash from 'lodash'
import fs from 'fs'

const _path = process.cwd()
const plugin = 'mil-plugin'
const getRoot = (root = '') => {
    if (root === 'root' || root === 'yunzai') {
        root = `${_path}/`
    } else if (!root) {
        root = `${_path}/plugins/${plugin}/`
    }
    return root
}

let Data = {
    createDir(path = '', root = '', includeFile = false) {
        root = getRoot(root)
        let pathList = path.split('/')
        let nowPath = root
        pathList.forEach((name, idx) => {
            name = name.trim()
            if (!includeFile && idx <= pathList.length - 1) {
                nowPath += name + '/'
                if (name) {
                    if (!fs.existsSync(nowPath)) {
                        fs.mkdirSync(nowPath)
                    }
                }
            }
        })
    },

    readJSON(file = '', root = '') {
        root = getRoot(root)
        if (fs.existsSync(`${root}/${file}`)) {
            try {
                return JSON.parse(fs.readFileSync(`${root}/${file}`, 'utf8'))
            } catch (e) {
                logger.error(e)
            }
        }
        return {}
    },

    writeJSON(file, data, root = '', space = '\t') {
        Data.createDir(file, root, true)
        root = getRoot(root)
        try {
            fs.writeFileSync(`${root}/${file}`, JSON.stringify(data, null, space))
            return true
        } catch (err) {
            logger.error(err)
            return false
        }
    },

    async getCacheJSON(key) {
        try {
            let txt = await redis.get(key)
            if (txt) return JSON.parse(txt)
        } catch (e) {
            logger.error(e)
        }
        return {}
    },

    async setCacheJSON(key, data, EX = 3600 * 24 * 90) {
        await redis.set(key, JSON.stringify(data), { EX })
    },

    getData(target, keyList = '', cfg = {}) {
        target = target || {}
        let defaultData = cfg.defaultData || {}
        let ret = {}
        if (typeof (keyList) === 'string') {
            keyList = keyList.split(',')
        }
        lodash.forEach(keyList, (keyCfg) => {
            let _keyCfg = keyCfg.split(':')
            let keyTo = _keyCfg[0].trim()
            let keyFrom = (_keyCfg[1] || _keyCfg[0]).trim()
            let keyRet = keyTo
            if (cfg.lowerFirstKey) keyRet = lodash.lowerFirst(keyRet)
            if (cfg.keyPrefix) keyRet = cfg.keyPrefix + keyRet
            ret[keyRet] = Data.getVal(target, keyFrom, defaultData[keyTo], cfg)
        })
        return ret
    },

    getVal(target, keyFrom, defaultValue) {
        return lodash.get(target, keyFrom, defaultValue)
    },

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    },

    def() {
        for (let idx in arguments) {
            if (!lodash.isUndefined(arguments[idx])) {
                return arguments[idx]
            }
        }
    },

    regRet(reg, txt, idx) {
        if (reg && txt) {
            let ret = reg.exec(txt)
            if (ret && ret[idx]) return ret[idx]
        }
        return false
    }
}

export default Data
