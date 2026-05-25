
import YAML from 'yaml'
import chokidar from 'chokidar'
import fs from 'node:fs'
import YamlReader from './YamlReader.js'

const Path = process.cwd()
const Plugin_Name = 'mil-plugin'
const Plugin_Path = `${Path}/plugins/${Plugin_Name}`

class Config {
    constructor() {
        this.config = {}
        /** 监听文件 */
        this.watcher = { config: {}, defSet: {} }
        this.initCfg()
    }

    /** 初始化配置 */
    initCfg() {
        let path = `${Plugin_Path}/config/config/`
        let pathDef = `${Plugin_Path}/config/default_config/`
        if (!fs.existsSync(path)) {
            fs.mkdirSync(path, { recursive: true })
        }
        const files = fs.readdirSync(pathDef).filter(file => file.endsWith('.yaml'))
        for (let file of files) {
            if (!fs.existsSync(`${path}${file}`)) {
                fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`)
            }
            this.watch(`${path}${file}`, file.replace('.yaml', ''), 'config')
        }
    }

    /**
     * @param {'config'|'nickconfig'} name 文件名
     * @param {any} [style] key值
     */
    getUserCfg(name, style = undefined) {
        let def = this.getdefSet(name)
        let config = this.getConfig(name)
        if (style) {
            if (typeof config[style] != 'undefined') {
                return config[style]
            } else {
                /** 对设置进行补全 */
                if (name == 'config') {
                    this.modify(name, style, def[style])
                }
                return def[style]
            }
        } else {
            return (config ? config : def)
        }
    }

    /** 默认配置 */
    getdefSet(name) {
        return this.getYaml('default_config', name)
    }

    /** 用户配置 */
    getConfig(name) {
        return this.getYaml('config', name)
    }

    /**
     * @param {'config'|'default_config'} type
     * @param {string} name
     */
    getYaml(type, name) {
        let file = `${Plugin_Path}/config/${type}/${name}.yaml`
        let key = `${type}.${name}`

        if (this.config[key]) return this.config[key]

        this.config[key] = YAML.parse(
            fs.readFileSync(file, 'utf8')
        )

        this.watch(file, name, type)

        return this.config[key]
    }

    watch(file, name, type = 'default_config') {
        let key = `${type}.${name}`

        if (this.watcher[key]) return

        const watcher = chokidar.watch(file)
        watcher.on('change', path => {
            delete this.config[key]
            if (typeof Bot == 'undefined') return
            logger.mark(`[mil修改配置文件][${type}][${name}]`)
        })

        this.watcher[key] = watcher
    }

    /**
     * @param {'config'|'nickconfig'} name
     * @param {any} key
     * @param {any} value
     * @param {'config'|'default_config'} [type]
     */
    modify(name, key, value, type = 'config') {
        let path = `${Plugin_Path}/config/${type}/${name}.yaml`
        new YamlReader(path).set(key, value)
        delete this.config[`${type}.${name}`]
    }

    /**
     * @param {'config'|'nickconfig'} name
     * @param {string|number} key
     * @param {string|number} value
     * @param {'add'|'del'} category
     * @param {'config'|'default_config'} type
     */
    modifyarr(name, key, value, category = 'add', type = 'config') {
        let path = `${Plugin_Path}/config/${type}/${name}.yaml`
        let yaml = new YamlReader(path)
        if (category == 'add') {
            yaml.addIn(key, value)
        } else {
            let index = yaml.jsonData[key].indexOf(value)
            yaml.delete(`${key}.${index}`)
        }
    }
}

export default new Config()
