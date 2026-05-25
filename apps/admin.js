/**
 * mil-plugin 管理命令
 *  - /mil gx 或 /mil 更新：从 git 拉取插件更新，智能判断是否需要重启
 *  - /mil downill：从独立仓库克隆/更新曲绘资源
 */
import { createRequire } from 'module'
import lodash from 'lodash'
import Config from '../components/Config.js'
import getInfo from '../model/getInfo.js'
import milPluginBase from '../components/baseClass.js'
import logger from '../components/Logger.js'
import { Restart } from '../../other/restart.js'
import fs from 'node:fs'
import send from '../model/send.js'

const require = createRequire(import.meta.url)
const { exec } = require('child_process')

const Plugin_Path = `${process.cwd()}/plugins/mil-plugin`
const Ill_Path = `${Plugin_Path}/resources/origin_ill`

/** 是否正在更新中（防重复） */
let uping = false

export class miladmin extends milPluginBase {
    constructor() {
        super({
            name: 'mil-管理',
            dsc: 'Milthm插件管理',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(gx|更新)$`,
                    fnc: 'update'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(downill|下载曲绘|更新曲绘)$`,
                    fnc: 'downill'
                }
            ]
        })
    }

    // ==================== 插件更新 ====================

    async update() {
        if (!this.e.isMaster) {
            send.send_with_At(this.e, '仅 Bot 主人可执行此操作')
            return true
        }
        if (uping) {
            send.send_with_At(this.e, '已有更新命令执行中，请勿重复操作')
            return true
        }
        if (!(await this._checkGit())) return true

        let isForce = this.e.msg.includes('强制') || this.e.msg.includes('qz')
        let ifRestart = false
        /** @type {string} */
        let time = ''

        try {
            if (isForce) {
                let result = await this._forceUpdate()
                ifRestart = result.ifRestart
                time = result.time
            } else {
                let result = await this._normalUpdate()
                ifRestart = result.ifRestart
                time = result.time
            }
        } catch (err) {
            logger.error('[mil-plugin] 更新失败:', err)
            send.send_with_At(this.e, 'mil-plugin 更新失败：' + err.message)
            return true
        }

        if (this._isUp) {
            if (ifRestart) {
                send.send_with_At(this.e, '更新完毕，正在重启云崽以应用更新')
                setTimeout(() => this.restart(), 2000)
            } else {
                // 仅资源/配置变化，重新加载歌曲信息和曲绘映射
                getInfo.init()
                send.send_with_At(this.e, `更新完毕，本次更新不需要进行重启。\n最后更新时间：${time}`)
            }

            // 检查是否自动更新曲绘
            let autoPull = Config.getUserCfg('config', 'autoPullIll')
            if (autoPull && autoPull !== false && autoPull !== 'false') {
                try {
                    await this.downill()
                } catch (err) {
                    logger.error('[mil-plugin] 自动更新曲绘失败:', err)
                }
            }
        }
        return true
    }
    restart() {
        new Restart(this.e).restart()
    }

    /** 普通更新：git pull */
    async _normalUpdate() {
        send.send_with_At(this.e, '开始检查 mil-plugin 更新...')
        this._oldCommitId = await this._getCommitId()

        uping = true
        let ret = await this._exec(`git -C "${Plugin_Path}" pull --no-rebase`)
        uping = false

        if (ret.error) {
            this._gitErr(ret.error, ret.stdout)
            throw new Error('git pull 失败')
        }

        let time = await this._getTime()

        if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
            send.send_with_At(this.e, `mil-plugin 已是最新版本\n最后更新：${time}`)
            return { ifRestart: false, time }
        }

        this._isUp = true
        send.send_with_At(this.e, `mil-plugin 更新成功\n最后更新：${time}`)

        // 分析变更日志，判断是否需要重启
        let ifRestart = await this._getLog()
        return { ifRestart, time }
    }

    /** 强制更新：reset --hard */
    async _forceUpdate() {
        send.send_with_At(this.e, '开始强制更新 mil-plugin...')
        this._oldCommitId = await this._getCommitId()

        let cmds = [
            `git -C "${Plugin_Path}" fetch --all --prune`,
            `git -C "${Plugin_Path}" reset --hard origin/main`,
            `git -C "${Plugin_Path}" clean -fd`
        ].join(' && ')

        uping = true
        let ret = await this._exec(cmds)
        uping = false

        if (ret.error) {
            this._gitErr(ret.error, ret.stdout)
            throw new Error('强制更新失败')
        }

        let time = await this._getTime()
        this._isUp = true
        send.send_with_At(this.e, `mil-plugin 强制更新完成\n最后更新：${time}`)
        let ifRestart = await this._getLog()
        return { ifRestart, time }
    }

    // ==================== 曲绘下载 ====================

    /**
     * 获取曲绘仓库地址（含代理处理）
     * 参照 phi-plugin 逻辑：githubProxy 非空时拼接到 URL 前面
     */
    _getIllUrl() {
        let url = String(Config.getUserCfg('config', 'illDownloadUrl') || '').trim()
        if (!url) {
            url = 'https://github.com/Temmie0125/mil-plugin-ill'
        }

        let proxy = Config.getUserCfg('config', 'githubProxy')
        if (!proxy || proxy === false || proxy === 'false' || proxy === '') {
            return url
        }

        // 仅对 GitHub 地址启用代理
        try {
            let parsed = new URL(url)
            if (parsed.hostname === 'github.com') {
                return `${String(proxy).replace(/\/$/, '')}/${url}`
            }
        } catch { /* URL 无效，直接返回原值 */ }

        return url
    }

    async downill() {
        if (!this.e.isMaster) {
            send.send_with_At(this.e, '仅 Bot 主人可执行此操作')
            return true
        }
        if (uping) {
            send.send_with_At(this.e, '已有命令执行中，请勿重复操作')
            return true
        }
        if (!(await this._checkGit())) return true

        if (!fs.existsSync(`${Ill_Path}/.git`)) {
            // 首次下载：git clone
            await this._illClone()
        } else {
            // 已存在：git pull 更新
            await this._illUpdate()
        }

        // 刷新曲绘映射
        await getInfo.loadIll()
        send.send_with_At(this.e, '曲绘资源已更新，映射已刷新~')
        return true
    }

    async _illClone() {
        let illUrl = this._getIllUrl()
        let cmd = `git clone "${illUrl}" "${Ill_Path}" --depth=1`
        send.send_with_At(this.e, '正在下载曲绘资源（首次可能较慢）...')

        uping = true
        let ret = await this._exec(cmd)
        uping = false

        if (ret.error) {
            // 如果目录已存在（非空），尝试删除后重试
            if (ret.error.toString().includes('already exists')) {
                send.send_with_At(this.e, '目录已存在且非空，尝试强制更新...')
                return await this._illForceUpdate()
            }
            this._gitErr(ret.error, ret.stdout)
            throw new Error('曲绘下载失败')
        }

        let time = await this._illGetTime()
        send.send_with_At(this.e, `曲绘资源下载完成！\n仓库：${illUrl}\n最后更新：${time}`)
    }

    async _illUpdate() {
        send.send_with_At(this.e, '正在更新曲绘资源...')

        // 确保 remote URL 正确
        try {
            let illUrl = this._getIllUrl()
            let gitCfg = fs.readFileSync(`${Ill_Path}/.git/config`, 'utf8')
            gitCfg = gitCfg.replace(/url\s*=\s*(.*)/, `url = ${illUrl}`)
            fs.writeFileSync(`${Ill_Path}/.git/config`, gitCfg, 'utf8')
        } catch { /* 非致命 */ }

        uping = true
        let ret = await this._exec(`git -C "${Ill_Path}" pull --no-rebase`)
        uping = false

        if (ret.error) {
            // pull 失败尝试强制更新
            return await this._illForceUpdate()
        }

        if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
            let time = await this._illGetTime()
            send.send_with_At(this.e, `曲绘资源已是最新版本\n最后更新：${time}`)
            return
        }

        let time = await this._illGetTime()
        send.send_with_At(this.e, `曲绘资源更新完成！\n最后更新：${time}`)
    }

    async _illForceUpdate() {
        send.send_with_At(this.e, '正在强制更新曲绘资源...')
        let cmds = [
            `git -C "${Ill_Path}" fetch --all --prune`,
            `git -C "${Ill_Path}" reset --hard origin/main`,
            `git -C "${Ill_Path}" clean -fd`
        ].join(' && ')

        uping = true
        let ret = await this._exec(cmds)
        uping = false

        if (ret.error) {
            this._gitErr(ret.error, ret.stdout)
            throw new Error('曲绘强制更新失败')
        }

        let time = await this._illGetTime()
        send.send_with_At(this.e, `曲绘资源强制更新完成！\n最后更新：${time}`)
    }

    // ==================== 工具方法 ====================

    /** 分析更新日志，判断是否需要重启 */
    async _getLog() {
        let cm = `git -C "${Plugin_Path}" log -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`
        let logAll
        try {
            let ret = await this._exec(cm)
            logAll = ret.stdout || ''
        } catch (err) {
            logger.error('[mil-plugin] 获取日志失败:', err)
            return false
        }

        if (!logAll) return false
        logAll = logAll.split('\n')

        let ifRestart = false
        let log = []
        for (let str of logAll) {
            str = str.split('||')
            if (str[0] === this._oldCommitId) break
            if (str[1] && str[1].includes('Merge branch')) continue
            if (str[1]) log.push(str[1])
            // 提交信息中没有 '√' 或 '✓' 标记的 → 需要重启
            if (str[1] && !(str[1].includes('√') || str[1].includes('✓'))) {
                ifRestart = true
            }
        }

        if (log.length > 0) {
            log.reverse()
            log.unshift(`mil-plugin 更新日志，共 ${log.length} 条：`)
            log.push(`更多详细信息，请前往github查看\nhttps://github.com/Temmie0125/mil-plugin-ill`)
            send.send_with_At(this.e, log.join('\n'))
        }
        return ifRestart
    }

    async _getCommitId() {
        let ret = await this._exec(`git -C "${Plugin_Path}" rev-parse --short HEAD`)
        return lodash.trim(ret.stdout || '')
    }

    async _getTime() {
        let ret = await this._exec(`git -C "${Plugin_Path}" log -1 --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`)
        return lodash.trim(ret.stdout || '') || '未知'
    }

    async _illGetTime() {
        if (!fs.existsSync(`${Ill_Path}/.git`)) return '未知'
        let ret = await this._exec(`git -C "${Ill_Path}" log -1 --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`)
        return lodash.trim(ret.stdout || '') || '未知'
    }

    _gitErr(err, stdout) {
        let errMsg = err ? err.toString() : ''
        stdout = stdout ? stdout.toString() : ''

        if (errMsg.includes('Timed out') || errMsg.includes('timeout')) {
            send.send_with_At(this.e, '更新失败：连接超时，请检查网络或稍后重试')
            return
        }
        if (/Failed to connect|unable to access|Could not resolve/.test(errMsg)) {
            send.send_with_At(this.e, '更新失败：无法连接到远程仓库，请检查网络')
            return
        }
        if (errMsg.includes('be overwritten by merge') || stdout.includes('CONFLICT')) {
            send.send_with_At(this.e, '更新失败：存在文件冲突\n请使用 /mil gx 强制更新（将丢失本地修改）')
            return
        }
        logger.error('[mil-plugin] git 错误:', errMsg, stdout)
        send.send_with_At(this.e, `更新失败：${errMsg}`)
    }

    _exec(cmd) {
        return new Promise((resolve) => {
            exec(cmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                resolve({ error, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() })
            })
        })
    }

    async _checkGit() {
        let ret = await this._exec('git --version')
        if (ret.error || !ret.stdout.includes('git version')) {
            send.send_with_At(this.e, '请先安装 Git 才能使用此功能')
            return false
        }
        return true
    }
}
