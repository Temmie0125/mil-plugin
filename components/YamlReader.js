import fs from 'fs'
import YAML from 'yaml'
import lodash from 'lodash'
import chokidar from 'chokidar'

export default class YamlReader {
    /**
     * @param {string} yamlPath yaml文件绝对路径
     * @param {boolean} isWatch 是否监听文件变化
     */
    constructor(yamlPath, isWatch = false) {
        this.yamlPath = yamlPath
        this.isWatch = isWatch
        this.initYaml()
    }

    initYaml() {
        try {
            this.document = YAML.parseDocument(fs.readFileSync(this.yamlPath, 'utf8'))
        } catch (error) {
            throw error
        }
        if (this.isWatch && !this.watcher) {
            this.watcher = chokidar.watch(this.yamlPath).on('change', () => {
                if (this.isSave) {
                    this.isSave = false
                    return
                }
                this.initYaml()
            })
        }
    }

    get jsonData() {
        if (!this.document) return null
        return this.document.toJSON()
    }

    has(keyPath) {
        return this.document.hasIn(keyPath.split('.'))
    }

    get(keyPath) {
        return lodash.get(this.jsonData, keyPath)
    }

    set(keyPath, value) {
        this.document.setIn(keyPath.split('.'), value)
        this.save()
    }

    delete(keyPath) {
        this.document.deleteIn(keyPath.split('.'))
        this.save()
    }

    addIn(keyPath, value) {
        this.document.addIn(keyPath.split('.'), value)
        this.save()
    }

    save() {
        this.isSave = true
        let yaml = this.document.toString()
        fs.writeFileSync(this.yamlPath, yaml, 'utf8')
    }
}
