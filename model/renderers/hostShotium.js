/**
 * 宿主渲染器适配层
 * 复用 TRSS-Yunzai 已加载的渲染后端（renderers/shotium），避免插件额外启动独立 Chromium
 * 宿主 shotium 引擎不执行 JS，模板数据会带上 renderNoJs 标记做静态化降级
 */
import Config from '../../components/Config.js'
import logger from '../../components/Logger.js'

const _path = process.cwd()
const Plugin_Name = 'mil-plugin'
const pluginResources = `${_path}/plugins/${Plugin_Name}/resources`

let loaderCache = null
let cfgCache = null
let loadingPromise = null

/** 按需加载宿主的渲染器加载器与全局配置（进程内单例，失败不缓存以便重试） */
function loadHost() {
    if (loaderCache && cfgCache) return Promise.resolve()
    if (!loadingPromise) {
        loadingPromise = Promise.all([
            import('../../../../lib/renderer/loader.js'),
            import('../../../../lib/config/config.js'),
        ]).then(([loader, cfg]) => {
            loaderCache = loader.default
            cfgCache = cfg.default
        }).catch(err => {
            loadingPromise = null
            throw err
        })
    }
    return loadingPromise
}

export default {
    /** 宿主 renderer.yaml 配置的渲染器名，读取失败返回空串 */
    async activeName() {
        try {
            await loadHost()
            return String(cfgCache.renderer?.name || '').trim().toLowerCase()
        } catch {
            return ''
        }
    },

    /** 宿主是否已加载指定渲染器 */
    async available(name) {
        try {
            await loadHost()
            // getRenderer 找不到时会返回 loader 自身（其 render 会轮询所有后端），需排除
            const renderer = loaderCache.getRenderer(name)
            return !!renderer && renderer !== loaderCache
        } catch {
            return false
        }
    },

    /**
     * 使用宿主渲染器截图
     * @param {string} tplName 模板名，如 "b20/b20"
     * @param {object} data 模板数据
     * @returns {Promise<Buffer|false>}
     */
    async screenshot(tplName, data = {}) {
        await loadHost()
        const renderer = loaderCache.getRenderer('shotium')
        if (!renderer || renderer === loaderCache) return false

        const [app, tpl] = tplName.split('/')
        const resPath = `${pluginResources}/`
        const layoutPath = `${resPath}html/common/layout/`
        const scale = (Config.getUserCfg('config', 'renderScale') || 100) / 100
        const quality = Math.min(100, Math.max(1, Math.round(Number(Config.getUserCfg('config', 'randerQuality')) || 90)))

        const renderData = {
            ...data,
            renderNoJs: true,
            _res_path: resPath,
            _layout_path: layoutPath,
            defaultLayout: layoutPath + 'default.art',
            elemLayout: layoutPath + 'elem.art',
            tplFile: `./plugins/${Plugin_Name}/resources/html/${app}/${tpl}.art`,
            pluResPath: resPath,
            _imgPath: resPath,
            saveId: data.saveId || tpl,
            sys: {
                scale: `style="transform:scale(${scale})"`,
            },
            imgType: 'jpeg',
            quality,
            pageGotoParams: {
                timeout: Number(Config.getUserCfg('config', 'timeout')) || 20000,
            },
        }

        const start = Date.now()
        const img = await renderer.render(tplName, renderData)
        if (!img) return false
        const buffer = Array.isArray(img) ? img[0] : img
        if (!Buffer.isBuffer(buffer)) return false
        logger.mark(`[mil-plugin][图片生成][shotium][${tplName}] ${(buffer.length / 1024).toFixed(2)}KB ${logger.green(`${Date.now() - start}ms`)}`)
        return buffer
    },
}
