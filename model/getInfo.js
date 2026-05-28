/**
 * 歌曲信息管理器
 * 从 resources/info/info.json 加载所有歌曲信息
 * 管理别名、模糊搜索等功能
 */
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import Config from '../components/Config.js'
import fCompute from './fCompute.js'
import logger from '../components/Logger.js'

const Plugin_Path = `${process.cwd()}/plugins/mil-plugin`

class GetInfo {
    constructor() {
        /** @type {Record<string, any>} 原始歌曲信息 */
        this.ori_info = {}
        /** @type {Record<string, string>} chart_id -> song_key 映射 */
        this.chartid_map = {}
        /** @type {Record<string, string>} id -> song 名称 */
        this.songsid = {}
        /** @type {Record<string, string>} song名 -> id */
        this.songsname = {}
        /** @type {string[]} 所有歌曲ID列表 */
        this.idList = []
        /** @type {Record<string, string[]>} 别名列表（来自info.json的tags） */
        this.nicklist = {}
        /** @type {string[]} 所有曲绘文件列表 */
        this.illlist = []
        /** @type {string[]} tips列表 */
        this.tips = []

        this.initialized = false
    }

    /**
     * 初始化 - 加载所有信息
     */
    async init() {
        await this.loadInfo()
        await this.loadTips()
        await this.loadIll()
        this.initNickConfig()
        this.loadDefaultNicklist()
        this.initialized = true
        logger.mark('[mil-plugin] 歌曲信息初始化完成')
    }

    /**
     * 获取头像文件名列表
     */
    getAvatar() {
        let avatarPath = `${Plugin_Path}/resources/avatar/`;
        try {
            const files = fs.readdirSync(avatarPath);
            // 过滤出 .png 结尾的文件（不区分大小写）
            const pngFiles = files.filter(file => path.extname(file).toLowerCase() === '.png');
            return pngFiles;
        } catch (error) {
            logger.error(`读取头像目录失败: ${error}`);
            return []; // 出错时返回空数组
        }
    }

    /**
     * 加载 info.json
     */
    async loadInfo() {
        let infoPath = `${Plugin_Path}/resources/info/info.json`
        try {
            let rawData = JSON.parse(fs.readFileSync(infoPath, 'utf8'))

            this.ori_info = rawData

            // 构建映射表
            for (let key of Object.keys(rawData)) {
                let song = rawData[key]
                let songId = key

                this.songsid[songId] = song.latinTitle || key
                this.songsname[song.latinTitle || key] = songId
                this.idList.push(songId)

                // 构建 chart_id -> song_key 映射
                if (song.difficulty) {
                    for (let diffName of Object.keys(song.difficulty)) {
                        let chart = song.difficulty[diffName]
                        if (chart.chartid) {
                            this.chartid_map[chart.chartid] = key
                        }
                    }
                }
            }
        } catch (e) {
            logger.error('[mil-plugin] 加载info.json失败:', e)
        }
    }

    /**
     * 初始化别名配置（用户自定义）
     */
    initNickConfig() {
        try {
            let userNick = Config.getUserCfg('nickconfig')
            if (userNick && typeof userNick === 'object') {
                for (let nick of Object.keys(userNick)) {
                    if (!this.nicklist[nick]) this.nicklist[nick] = []
                    let ids = userNick[nick]
                    if (Array.isArray(ids)) {
                        for (let id of ids) {
                            if (!this.nicklist[nick].includes(id)) {
                                this.nicklist[nick].push(id)
                            }
                        }
                    }
                }
            }
        } catch (e) {
            logger.error('[mil-plugin] 加载别名配置失败:', e)
        }
    }

    /**
     * 加载默认别名（phi 风格 nicklist.yaml：songKey → [别名列表]）
     */
    loadDefaultNicklist() {
        let nicklistPath = `${Plugin_Path}/resources/info/nicklist.yaml`
        try {
            if (!fs.existsSync(nicklistPath)) return

            let raw = YAML.parse(fs.readFileSync(nicklistPath, 'utf8'))
            if (!raw || typeof raw !== 'object') return

            // phi 风格: { songKey: [alias1, alias2, ...] }
            // 转换为内部格式: nicklist[alias] → [songIds]
            for (let songKey of Object.keys(raw)) {
                let aliases = raw[songKey]
                if (!Array.isArray(aliases)) continue
                for (let alias of aliases) {
                    if (!alias || typeof alias !== 'string') continue
                    alias = alias.trim()
                    if (!alias) continue
                    if (!this.nicklist[alias]) this.nicklist[alias] = []
                    if (!this.nicklist[alias].includes(songKey)) {
                        this.nicklist[alias].push(songKey)
                    }
                }
            }
        } catch (e) {
            logger.error('[mil-plugin] 加载默认别名失败:', e)
        }
    }

    /**
     * 加载 tips
     */
    async loadTips() {
        let tipsPath = `${Plugin_Path}/resources/info/tips.txt`
        try {
            if (fs.existsSync(tipsPath)) {
                this.tips = fs.readFileSync(tipsPath, 'utf8').split('\n').filter(line => line.trim())
            }
        } catch (e) {
            logger.error('[mil-plugin] 加载tips失败:', e)
        }
    }

    /**
     * 加载曲绘列表并建立 songKey -> illPath 映射
     */
    async loadIll() {
        let illDir = `${Plugin_Path}/resources/origin_ill/ill`
        try {
            if (fs.existsSync(illDir)) {
                this.illlist = fs.readdirSync(illDir).filter(f => f.endsWith('.png'))
            }
        } catch (e) {
            logger.error('[mil-plugin] 加载曲绘列表失败:', e)
        }

        // 建立 songKey -> illPath 映射
        this.illMap = {}
        if (!this.illlist || this.illlist.length === 0) return

        for (let key of Object.keys(this.ori_info)) {
            let info = this.ori_info[key]
            let latin = info.latinTitle || ''
            let artist = info.artist || ''

            // 精确匹配
            let exactName = `${latin} - ${artist}.png`
            if (this.illlist.includes(exactName)) {
                this.illMap[key] = `${illDir}/${exactName}`
                continue
            }

            // 去掉非法文件名字符后匹配
            let safeName = sanitizeFilename(`${latin} - ${artist}.png`)
            let match = this.illlist.find(f => sanitizeFilename(f) === safeName)
            if (match) {
                this.illMap[key] = `${illDir}/${match}`
                continue
            }

            // 模糊匹配：latinTitle 包含匹配
            if (latin.length >= 4) {
                let fuzzy = this.illlist.find(f =>
                    f.toLowerCase().includes(latin.toLowerCase().substring(0, Math.min(latin.length, 12)))
                )
                if (fuzzy) {
                    this.illMap[key] = `${illDir}/${fuzzy}`
                }
            }
        }
    }

    /**
     * 获取歌曲完整信息
     * @param {string} id - 歌曲key
     * @param {boolean} [createNew] - 是否创建新对象
     * @returns {any}
     */
    info(id, createNew = false) {
        if (!this.ori_info[id]) return null
        let rawInfo = this.ori_info[id]
        let songTitle = rawInfo.latinTitle || id
        if (rawInfo.Title_zh_Hans) {
            songTitle = rawInfo.Title_zh_Hans
        }

        let result = {
            id,
            song: songTitle,
            latinTitle: rawInfo.latinTitle,
            zhTitle: rawInfo.Title_zh_Hans || '',
            artist: rawInfo.artist || '',
            illustrator: rawInfo.illustrator || [],
            chapter: rawInfo.chapter || '',
            chapter_zh: rawInfo.chapter_zh_hans || '',
            songid: rawInfo.songid || '',
            illustration: this.getill(id),
            chart: {},
            tags: rawInfo.tags || []
        }

        // 处理谱面信息
        if (rawInfo.difficulty) {
            for (let diffName of Object.keys(rawInfo.difficulty)) {
                let chart = rawInfo.difficulty[diffName]
                result.chart[diffName] = {
                    chartid: chart.chartid,
                    difficulty: chart.difficultyValue || chart.difficultyValuev2 || 0,
                    charter: chart.charter || '',
                    tap: chart.tap || 0,
                    hold: chart.hold || 0,
                    drag: chart.drag || 0,
                    fracture: chart.fracture || 0,
                    ex: chart.ex || 0,
                    combo: chart.combo || 0,
                    bpmInfo: chart.bpmInfo || [],
                    bpm: fCompute.getBpmStr(chart.bpmInfo),
                    length: chart['谱面时长'] || '',
                    tags: chart.tags || []
                }
            }
        }

        return result
    }

    /**
     * 获取所有歌曲信息
     * @returns {Record<string, any>}
     */
    all_info() {
        let result = {}
        for (let id of this.idList) {
            result[id] = this.info(id)
        }
        return result
    }

    /**
     * 通过chart_id获取歌曲key
     * @param {string} chartId
     * @returns {string|null}
     */
    chartIdToSongKey(chartId) {
        return this.chartid_map[chartId] || null
    }

    /**
     * 模糊搜索歌曲（基于 Jaro-Winkler 相关度排序）
     * @param {string} query - 搜索词
     * @param {number} [threshold=0.85] - JaroWinkler 相似度阈值（0~1）
     * @param {number} [limit] - 限制结果数量
     * @returns {string[]}
     */
    fuzzysongsnick(query, threshold = 0.85, limit = undefined) {
        if (!query || !query.trim()) return []

        query = query.trim().toLowerCase()

        // 1. 别名精确匹配——若仅匹配到唯一结果则直接返回
        if (this.nicklist[query]) {
            let exactMatches = [...this.nicklist[query]]
            if (exactMatches.length === 1) {
                return exactMatches
            }
            // 多个精确匹配，记录下来后续参与排序（得分=1.0）
        }

        // 2. 相关度匹配（JaroWinkler）
        /** @type {Map<string, number>} id -> best score */
        let scoredResults = new Map()

        const addResult = (id, score) => {
            if (!scoredResults.has(id) || scoredResults.get(id) < score) {
                scoredResults.set(id, score)
            }
        }

        // 2a. 别名匹配
        for (let nick of Object.keys(this.nicklist)) {
            let dis = fCompute.jaroWinklerDistance(query, nick)
            if (dis >= threshold) {
                for (let id of this.nicklist[nick]) {
                    addResult(id, dis)
                }
            }
        }

        // 2b. 歌曲 ID/key 匹配
        for (let id of this.idList) {
            let dis = fCompute.jaroWinklerDistance(query, id.toLowerCase())
            if (dis >= threshold) {
                addResult(id, dis)
            }
        }

        // 2c. 拉丁标题匹配
        for (let id of this.idList) {
            let info = this.ori_info[id]
            if (info && info.latinTitle) {
                let dis = fCompute.jaroWinklerDistance(query, info.latinTitle.toLowerCase())
                if (dis >= threshold) {
                    addResult(id, dis)
                }
            }
        }

        // 2d. 中文标题匹配
        for (let id of this.idList) {
            let info = this.ori_info[id]
            if (info && info.Title_zh_Hans) {
                let dis = fCompute.jaroWinklerDistance(query, info.Title_zh_Hans.toLowerCase())
                if (dis >= threshold) {
                    addResult(id, dis)
                }
            }
        }

        // 2e. 曲师匹配
        for (let id of this.idList) {
            let info = this.ori_info[id]
            if (info && info.artist) {
                let dis = fCompute.jaroWinklerDistance(query, info.artist.toLowerCase())
                if (dis >= threshold) {
                    addResult(id, dis)
                }
            }
        }

        // 3. 精确别名匹配兜底（得分=1.0，最高优先级）
        if (this.nicklist[query]) {
            for (let id of this.nicklist[query]) {
                addResult(id, 1.0)
            }
        }

        // 4. chart_id 搜索（精确匹配或部分匹配，仅当query较长时）
        if (query.length >= 8) {
            let songKey = this.chartIdToSongKey(query)
            if (songKey) {
                addResult(songKey, 1.0)
            }
            for (let chartId of Object.keys(this.chartid_map)) {
                if (chartId.includes(query)) {
                    let key = this.chartid_map[chartId]
                    if (key) {
                        addResult(key, 0.95)
                    }
                }
            }
        }

        if (scoredResults.size === 0) return []

        // 5. 按相关度降序排列
        let sorted = [...scoredResults.entries()]
            .sort((a, b) => b[1] - a[1])

        // 6. 如果最高分是精确匹配（1.0），仅保留精确匹配的结果
        if (sorted[0][1] >= 1.0) {
            sorted = sorted.filter(([, score]) => score >= 1.0)
        }

        // 7. 提取ID列表并应用数量限制
        let result = sorted.map(([id]) => id)
        if (limit && result.length > limit) {
            result = result.slice(0, limit)
        }

        return result
    }

    /**
     * 获取曲绘路径
     * @param {string} id - 歌曲key
     * @param {string} [type] - 'blur' 或 'low' 暂不处理，返回原图
     * @returns {string}
     */
    getill(id, type = '') {
        // 优先使用初始化时建立的映射
        if (this.illMap && this.illMap[id]) {
            return this.illMap[id]
        }
        return ''
    }

    /**
     * 获取曲绘Buffer
     * @param {string} id
     * @returns {Buffer|null}
     */
    getillBuffer(id) {
        let path = this.getill(id)
        if (path && fs.existsSync(path)) {
            return fs.readFileSync(path)
        }
        return null
    }

    /**
     * 设置别名
     * @param {string} id - 歌曲key
     * @param {string} nick - 别名
     */
    async setnick(id, nick) {
        // 更新内存
        if (!this.nicklist[nick]) this.nicklist[nick] = []
        if (!this.nicklist[nick].includes(id)) {
            this.nicklist[nick].push(id)
        }

        // 持久化到配置文件
        let path = `${Plugin_Path}/config/config/nickconfig.yaml`
        let YamlReader = (await import('../components/YamlReader.js')).default
        let reader = new YamlReader(path)
        reader.addIn(nick, id)
    }

    /**
     * 获取歌曲key对应的排序信息
     * @param {string} id
     * @returns {string}
     */
    idgetsong(id) {
        return this.songsid[id] || id
    }

    /** 获取所有ID */
    get all_id() {
        return this.idList
    }
}

/**
 * 过滤文件名中的非法字符
 * Windows 非法字符: < > : " / \ | ? *
 * 另外 # 和 。也常见被去除
 */
function sanitizeFilename(name) {
    return name
        .replace(/["#:。<>/\|?*]/g, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

export default new GetInfo()
