/**
 * 图片渲染协调器
 * 协调 puppeteer 渲染各类图片
 */
import puppeteer from './puppeteer.js'
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

export default {
    /**
     * 渲染B20图片
     * @param {object} data
     * @returns {Promise<any>}
     */
    async b20(data) {
        return enqueue(async () => {
            let buff = await puppeteer.screenshot('b20/b20', data)
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
            let buff = await puppeteer.screenshot('atlas/atlas', data)
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
            let buff = await puppeteer.screenshot('score/score', data)
            if (!buff) return '图片生成失败QAQ'
            return segment.image(buff)
        })
    }
}
