/**
 * 图片渲染协调器
 * 依据 renderer 配置在 插件独立 Puppeteer 与 宿主 shotium 渲染器间选择
 * 并通过队列串行化渲染请求，避免并发访问浏览器
 */
import puppeteer from './puppeteer.js'
import hostShotium from './renderers/hostShotium.js'
import { buildIllWatermarkStyle } from './renderers/staticStyle.js'
import Config from '../components/Config.js'
import logger from '../components/Logger.js'
import { segment } from "oicq"

let renderQueue = []
let isRendering = false

async function enqueue(fn) {
    return new Promise((resolve) => {
        renderQueue.push({ fn, resolve })
        processQueue()
    })
}

async function processQueue() {
    if (isRendering || renderQueue.length === 0) return
    isRendering = true
    while (renderQueue.length > 0) {
        let { fn, resolve } = renderQueue.shift()
        try {
            let result = await fn()
            resolve(result)
        } catch (err) {
            logger.error('[mil-plugin] 渲染错误:', err)
            resolve('渲染失败QAQ：' + err.message)
        }
    }
    isRendering = false
}

let lastBackend = ''

/**
 * 依据配置解析当前应使用的渲染后端
 * @returns {Promise<'puppeteer'|'shotium'>}
 */
async function pickBackend() {
    const selected = String(Config.getUserCfg('config', 'renderer') || 'puppeteer').trim().toLowerCase()
    if (selected === 'shotium') return 'shotium'
    if (selected === 'auto') {
        return (await hostShotium.activeName()) === 'shotium' ? 'shotium' : 'puppeteer'
    }
    return 'puppeteer'
}

/**
 * 使用指定后端渲染；宿主渲染器不可用或渲染失败时回退到独立 Puppeteer
 * @param {'puppeteer'|'shotium'} backend
 * @param {string} tplName 模板名，如 "b20/b20"
 * @param {object} data 模板数据
 * @returns {Promise<Buffer|false>}
 */
async function renderWith(backend, tplName, data) {
    if (backend === 'shotium') {
        if (await hostShotium.available('shotium')) {
            let buff = false
            try {
                buff = await hostShotium.screenshot(tplName, data)
            } catch (err) {
                logger.error(`[mil-plugin] 宿主 shotium 渲染异常：${tplName}`, err)
            }
            if (buff) return buff
            logger.warn(`[mil-plugin] 宿主 shotium 渲染失败，本次回退独立 Puppeteer：${tplName}`)
        } else {
            logger.warn('[mil-plugin] 宿主 shotium 渲染器不可用，本次回退独立 Puppeteer（请确认 renderers/shotium 已安装）')
        }
    }
    return puppeteer.screenshot(tplName, data)
}

/**
 * 按当前配置渲染并输出后端切换日志
 * @param {string} tplName 模板名，如 "b20/b20"
 * @param {object} data 模板数据
 * @returns {Promise<Buffer|false>}
 */
async function renderImage(tplName, data) {
    const backend = await pickBackend()
    if (backend !== lastBackend) {
        lastBackend = backend
        logger.info(`[mil-plugin] 当前渲染器：${backend === 'shotium' ? 'shotium（复用宿主，模板 JS 不执行）' : 'puppeteer（插件独立 Chromium）'}`)
    }
    return renderWith(backend, tplName, data)
}

export default {
    /**
     * 渲染B20图片
     * @param {object} data
     * @returns {Promise<any>}
     */
    async b20(data) {
        return enqueue(async () => {
            let buff = await renderImage('b20/b20', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染曲目图鉴图片
     * @param {object} data
     * @returns {Promise<any>}
     */
    async atlas(data) {
        return enqueue(async () => {
            let buff = await renderImage('atlas/atlas', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染单曲成绩图片
     * @param {object} data
     * @returns {Promise<any>}
     */
    async score(data) {
        return enqueue(async () => {
            let buff = await renderImage('score/score', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染帮助菜单图片
     * @param {object} data - { title, subTitle, helpGroup, background, version }
     * @returns {Promise<any>}
     */
    async help(data) {
        return enqueue(async () => {
            let buff = await renderImage('help/help', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染存档更新图片
     * @param {object} data
     * @returns {Promise<any>}
     */
    async update(data) {
        return enqueue(async () => {
            let buff = await renderImage('update/update', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染带水印的曲绘图片
     * 不受 renderScale 影响，图像大小由曲绘原始尺寸决定
     * @param {object} data - { illustration: string, illustrator: string }
     * @returns {Promise<any>}
     */
    async ill(data) {
        return enqueue(async () => {
            const backend = await pickBackend()
            if (backend === 'shotium') {
                // shotium 不执行模板脚本，水印布局由服务端按图片尺寸预算（与 ill.art 内脚本同公式）
                Object.assign(data, buildIllWatermarkStyle(data.illustration))
            }
            let buff = await renderWith(backend, 'ill/ill', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染最近游玩记录
     */
    async recent(data) {
        return enqueue(async () => {
            let buff = await renderImage('recent/recent', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染猜曲绘图片
     * @param {object} data - { illustration, width, height, x, y, blur, imgW, imgH, style, ans, filterStyle, ... }
     * @returns {Promise<any>}
     */
    async guess(data) {
        return enqueue(async () => {
            let buff = await renderImage('guess/guess', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染个人设置面板
     * @param {object} data - 设置数据
     * @returns {Promise<any>}
     */
    async myset(data) {
        return enqueue(async () => {
            let buff = await renderImage('myset/myset', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    },

    /**
     * 渲染定数表图片
     * @param {object} data - { titleNumber, gameVersion, background, logoPath, sections, isSP }
     * @returns {Promise<any>}
     */
    async table(data) {
        return enqueue(async () => {
            let buff = await renderImage('table/table', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    }
}
