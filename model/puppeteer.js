/**
 * puppeteer 渲染器
 * 参照 phi-plugin 实现，用于将 Art-template 模板渲染为图片
 */
import Renderer from "../../../lib/renderer/Renderer.js"
import puppeteer from "puppeteer"
import fs from "fs"
import Config from "../components/Config.js"
import logger from "../components/Logger.js"

const _path = process.cwd()
const Plugin_Name = "mil-plugin"
const pluginResources = `${_path}/plugins/${Plugin_Name}/resources`

class MilRenderer extends Renderer {
    constructor() {
        super({
            id: "puppeteer",
            type: "image",
            render: "screenshot",
        })
        this.browser = false
        this.lock = false
        this.renderNum = 0
        this.restartNum = 200
    }

    async browserInit() {
        if (this.browser) return this.browser
        if (this.lock) return false
        this.lock = true

        logger.info("[mil-plugin] Chromium 启动中...")

        try {
            this.browser = await puppeteer.launch({
                headless: "new",
                args: ["--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", "--no-zygote"],
            })
        } catch (err) {
            logger.error("[mil-plugin] Chromium 启动失败:", err)
            try {
                logger.error("尝试执行: node node_modules/puppeteer/install.js")
            } catch { }
            this.lock = false
            return false
        }

        this.lock = false
        logger.info("[mil-plugin] Chromium 启动成功")
        this.browser.on("disconnected", () => {
            this.browser = false
        })
        return this.browser
    }

    /**
     * @param {string} tplName 模板名如 "b20/b20", "atlas/atlas", "score/score"
     * @param {object} data 模板数据
     * @returns {Promise<Buffer|false>}
     */
    async screenshot(tplName, data = {}) {
        if (!(await this.browserInit())) return false

        let [app, tpl] = tplName.split("/")

        let resPath = `${pluginResources}/`
        let layoutPath = `${resPath}html/common/layout/`

        let scale = (Config.getUserCfg('config', 'renderScale') || 100) / 100

        data._res_path = resPath
        data._layout_path = layoutPath
        data.defaultLayout = layoutPath + "default.art"
        data.elemLayout = layoutPath + "elem.art"
        data.tplFile = `./plugins/${Plugin_Name}/resources/html/${app}/${tpl}.art`
        data.pluResPath = resPath
        data._imgPath = resPath
        data.saveId = tpl
        data.sys = {
            scale: `style="transform:scale(${scale})"`
        }

        // 使用Renderer的dealTpl生成HTML
        let savePath = this.dealTpl(tplName, data)
        if (!savePath) return false

        let buff
        const start = Date.now()

        try {
            const page = await this.browser.newPage()
            await page.goto(`file://${_path}${savePath.replace(/^\./, "")}`, {
                timeout: 60000,
                waitUntil: ["networkidle0", "load"],
            })

            const body = (await page.$("#container")) || (await page.$("body"))
            if (!body) {
                buff = await page.screenshot({ type: "jpeg", quality: 90, fullPage: true })
            } else {
                buff = await body.screenshot({ type: "jpeg", quality: 90 })
            }

            if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

            this.renderNum++
            const kb = (buff.length / 1024).toFixed(2) + "KB"
            logger.mark(`[mil-plugin][图片生成][${tplName}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`)

            page.close().catch(err => logger.error(err))
        } catch (err) {
            logger.error(`[mil-plugin][图片生成失败][${tplName}]`, err)
            this.browser = false
            return false
        }

        this.restart()
        return buff
    }

    restart(force = false) {
        if (!this.browser?.close || this.lock) return
        if (!force && this.renderNum % this.restartNum !== 0) return
        logger.info("[mil-plugin] Chromium 重启...")
        try { this.browser.close() } catch { }
        this.browser = false
        return this.browserInit()
    }
}

export default new MilRenderer()
