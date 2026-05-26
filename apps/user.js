import Config from '../components/Config.js'
import send from '../model/send.js'
import getInfo from '../model/getInfo.js'
import fCompute from '../model/fCompute.js'
import { calcReality, parseGameVersion } from '../model/reality.js'
import { getFileInfo, getFileContent } from '../components/common.js'
import getSave from '../model/getSave.js'
import SaveManager from '../model/SaveManager.js'
import picmodle from '../model/picmodle.js'
import milPluginBase from '../components/baseClass.js'
import Version from '../components/Version.js'
import logger from '../components/Logger.js'
import fs from 'fs'
import https from 'https'
import http from 'http'


/**@import {botEvent} from '../components/baseClass.js' */

// 随机头像列表
const avatarList = ['avatar.png', 'avatar_honoka.png', 'avatar_luvia.png', 'avatar_susan.png']

function randomAvatar() {
    return avatarList[fCompute.randBetween(0, avatarList.length - 1)]
}

/**
 * BestLevel → 评级映射 (saves.db)
 * 0=R, 1=M, 2=SS, 3=S, 4=A, 5=B, 6=C, 7=F
 */
const BEST_LEVEL_GRADE = ['R', 'M', 'SS', 'S', 'A', 'B', 'C', 'F']

/**
 * 根据记录和谱面信息获取评级与图标
 * 对于 saves.db 使用 BestLevel 映射；对于 data.db 从判定数据计算
 * @param {object} record - 成绩记录
 * @param {object} chartInfo - 谱面信息（含 combo）
 * @returns {{grade: string, iconName: string}}
 */
function getGradeForRecord(record, chartInfo) {
    if (record._source === 'saves') {
        // saves.db: BestLevel 定分数评级，acc=100% 判定 AP，AchievedStatus 含 4 判定 FC
        let scoreGrade = (record._bestLevel != null && BEST_LEVEL_GRADE[record._bestLevel]) || fCompute.getScoreGrade(record.score)
        let isAP = record.score_accuracy >= 0.9999
        let isFC = Array.isArray(record._achievedStatus) && record._achievedStatus.includes(4)

        if (record._bestLevel === 0) {
            // R 评（Rhythm of Rain）— 全 Exact，理论值
            return { grade: 'R', iconName: 'R' }
        }
        if (isAP) {
            return { grade: 'AP', iconName: 'AP' + scoreGrade }
        }
        if (isFC) {
            return { grade: 'FC', iconName: 'FC' + scoreGrade }
        }
        return { grade: scoreGrade, iconName: scoreGrade }
    }

    // data.db: 从判定数据计算评级
    let totalCombo = chartInfo?.combo || 1
    let isAllExact = (record.score_exact_count || 0) >= totalCombo
    let perfectAndExact = (record.score_exact_count || 0) + (record.score_perfect_count || 0)
    let isAllPerfectOrExact = perfectAndExact >= totalCombo
    let combo = totalCombo - (record.score_bad_count || 0) - (record.score_miss_count || 0)

    return fCompute.getGrade(
        record.score, combo, totalCombo,
        record.score_bad_count || 0, record.score_miss_count || 0,
        isAllExact, isAllPerfectOrExact
    )
}

export class miluser extends milPluginBase {
    constructor() {
        super({
            name: 'mil-user',
            dsc: 'Milthm成绩查询',
            event: 'message',
            priority: 1000,
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(删除存档|delsave)(\\s*)$`,
                    fnc: 'deleteSave'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)((b|B)\\s*[0-9]*|b20).*$`,
                    fnc: 'b20'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(score|单曲成绩|single).*$`,
                    fnc: 'singlescore'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(data|统计|stats)$`,
                    fnc: 'data'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)help$`,
                    fnc: 'help'
                },
                {
                    // 监听文件导入存档
                    reg: '',
                    fnc: 'importSave',
                    log: false
                }
            ]
        })
    }

    /**
     * 导入存档 - 使用OneBotv11适配器获取文件
     */
    async importSave(e) {
        const fileInfo = getFileInfo(e);
        if (!fileInfo) {
            return false;
        }
        const { fileName, fileId, busid } = fileInfo;
        if (!fileName.endsWith('.db')) {
            return false
        }
        send.send_with_At(e, '正在下载并解析存档文件...', true);
        // 2. 获取文件内容（字符串）
        let fileContent;
        try {
            fileContent = await getFileContent(e, fileId, busid);
        } catch (err) {
            logger.error('[mil-plugin] 获取文件内容失败:', err);
            send.send_with_At(e, '读取存档文件失败，请重新发送！');
            return true;
        }
        if (!fileContent) {
            send.send_with_At(e, '无法获取文件内容，可能是文件格式不支持或网络问题。');
            return true;
        }
        // 3. 保存为临时文件
        const downloadPath = `${process.cwd()}/plugins/mil-plugin/data/temp_${e.user_id}.db`;
        try {
            fs.writeFileSync(downloadPath, fileContent);
        } catch (err) {
            logger.error('[mil-plugin] 写入临时文件失败:', err);
            send.send_with_At(e, '保存文件失败，请重试！');
            return true;
        }
        // 4. 调用原有导入逻辑
        let result = await getSave.importSave(e.user_id, downloadPath);
        try { fs.unlinkSync(downloadPath); } catch { }
        if (result.success) {
            let saveType = result.saveType || 'data'
            let saveTypeName = saveType === 'saves' ? 'saves.db（推荐）' : 'data.db'
            let saveTypeHint = saveType === 'saves'
                ? '\n'
                : '\n提示：推荐使用 saves.db（而非 data.db）'
            send.send_with_At(e, `${result.msg}\n用户名：${result.username}\n数据来源：${saveTypeName}\n共导入${getSave.saves[e.user_id]?.scores?.length || 0}条成绩记录${saveTypeHint}\n现在可以查询成绩了！`);
        } else {
            send.send_with_At(e, `${result.msg}`);
        }
        return true;
    }

    /**
     * 删除存档
     */
    async deleteSave(e) {
        let save = await getSave.getSave(e.user_id)
        if (!save || !save.hasSave()) {
            send.send_with_At(e, '你还没有导入存档哦！')
            return true
        }
        getSave.deleteSave(e.user_id)
        send.send_with_At(e, '存档已删除！')
        return true
    }

    /**
     * B20查询（图像渲染）
     */
    async b20(e) {
        let save = await getSave.getSave(e.user_id)
        if (!save || (!save.hasSave() && save.scores.length === 0)) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或者发送存档文件(.db)给BOT进行导入哦`)
            return true
        }

        let msg = e.msg
        let numMsg = msg.match(/^.*?(b|B)\s*([0-9]+)/i)?.[0]
        let nnum = numMsg ? Number(numMsg.replace(/^.*?(b|B)\s*/i, '')) : 20
        // 至少显示22个（满足2个OVERFLOW）
        if (!nnum || nnum <= 22) nnum = 22
        
        let maxNum = Config.getUserCfg('config', 'B20MaxNum') || 50
        nnum = Math.min(nnum, maxNum)

        // Best 固定前 20 首，第 21 起为 OVERFLOW
        let bestNum = 20
        // 获取足够数量用于 Reality 计算（多取 2 首保证精度）
        let fetchNum = Math.min(nnum + 2, maxNum + 2)

        // 获取成绩并计算Reality
        let { scores, reality } = save.getB20WithReality(fetchNum, getInfo)
        let player = save.getPlayerInfo()

        // --- 计算星星和 Reality 版本 ---
        let starLevel = 0
        let allV3 = true
        let scoreData = []
        for (let i = 0; i < scores.length; i++) {
            let record = scores[i]
            let songKey = getInfo.chartIdToSongKey(record.chart_id)
            let songName = record.chart_id
            let songArtist = ''
            let illustration = ''
            let diffLevel = 'Drizzle'
            let difficulty = record._difficulty || 0
            let bpm = ''
            let totalCombo = 1

            if (songKey) {
                let info = getInfo.info(songKey)
                if (info) {
                    songName = info.song || songKey
                    songArtist = info.artist || ''
                    illustration = info.illustration || ''
                    for (let level of fCompute.Level) {
                        if (info.chart[level]?.chartid === record.chart_id) {
                            diffLevel = level
                            difficulty = info.chart[level].difficulty || 0
                            bpm = info.chart[level].bpm || ''
                            totalCombo = info.chart[level].combo || 1
                            break
                        }
                    }
                }
            }

            let gradeInfo = getGradeForRecord(record, { combo: totalCombo })

            let singleRlt = record._reality || calcReality(record.score, difficulty, parseGameVersion(record.game_version), record.score_accuracy)

            // 星星判定：AP(acc=100%) 或 R(BestLevel=0 / 全Exact理论值) 且定数达到阈值（只看 Best 范围内）
            let isAP = record.score_accuracy >= 0.9999
            let isR = gradeInfo.grade === 'R'
            if ((isAP || isR) && i < bestNum) {
                if (difficulty >= 12.0) starLevel = Math.max(starLevel, 3)
                else if (difficulty >= 9.0) starLevel = Math.max(starLevel, 2)
                else if (difficulty >= 6.0) starLevel = Math.max(starLevel, 1)
            }

            // Reality 版本判定（只看 Best 范围内的）
            if (i < bestNum) {
                let gv = parseGameVersion(record.game_version)
                if (gv < 4.0) allV3 = false
            }

            scoreData.push({
                song: songName,
                artist: songArtist,
                illustration,
                level: diffLevel,
                levelAbbr: fCompute.LevelAbbr[diffLevel] || diffLevel,
                difficulty,
                bpm,
                score: record.score,
                accuracy: record.score_accuracy || 0,
                reality: singleRlt,
                grade: gradeInfo.grade,
                gradeIcon: gradeInfo.iconName,
                exact: record.score_exact_count || 0,
                perfect: record.score_perfect_count || 0,
                good: record.score_good_count || 0,
                bad: record.score_bad_count || 0,
                miss: record.score_miss_count || 0,
                isOverflow: i >= bestNum
            })
        }

        // 随机背景曲绘
        let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

        let data = {
            avatar: randomAvatar(),
            username: player.username,
            reality,
            realityIcon: allV3 ? 'reality_v3' : 'reality',
            starLevel,
            scores: scoreData.slice(0, nnum),
            overflowIndex: bestNum,
            totalCount: nnum,
            updateTime: fCompute.formatDate(new Date().toISOString()),
            background: bgIll,
            version: Version.ver
        }

        send.send_with_At(e, await picmodle.b20(data))
        return true
    }

    /**
     * 单曲成绩（图像渲染）
     */
    async singlescore(e) {
        let save = await getSave.getSave(e.user_id)
        if (!save || (!save.hasSave() && save.scores.length === 0)) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或发送存档文件(saves.db)给BOT，进行导入嗷`)
            return true
        }

        let song = e.msg.replace(/[#/](.*?)(score|单曲成绩|single)(\s*)/g, '').trim()
        if (!song) {
            send.send_with_At(e, `请指定曲名哦！\n格式：/${Config.getUserCfg('config', 'cmdhead')} score <曲名>`)
            return true
        }

        let ids = getInfo.fuzzysongsnick(song)
        if (!ids[0]) {
            send.send_with_At(e, `未找到"${song}"的相关曲目信息QAQ, 如果想要投稿别名可前往别名提案申请填写表：https://www.kdocs.cn/wo/sl/v12VZ1RD`)
            return true
        }
        if (ids.length > 1) {
            this.choseMutiNick(e, ids, {}, async (e, id) => {
                send.send_with_At(e, await renderScore(save, id))
            })
            return true
        }
        send.send_with_At(e, await renderScore(save, ids[0]))
        return true
    }

    /**
     * 数据统计
     */
    async data(e) {
        let save = await getSave.getSave(e.user_id)
        if (!save || (!save.hasSave() && save.scores.length === 0)) {
            send.send_with_At(e, `你还没有导入存档哦！请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或发送存档文件进行导入哦`)
            return true
        }

        let player = save.getPlayerInfo()
        let scores = save.scores
        let { reality } = save.getB20WithReality(20, getInfo)

        let gradeCount = {}
        let totalAcc = 0
        for (let record of scores) {
            let songKey = getInfo.chartIdToSongKey(record.chart_id)
            let chartInfo = { combo: 1 }
            if (songKey) {
                let info = getInfo.info(songKey)
                if (info) {
                    for (let level of fCompute.Level) {
                        if (info.chart[level]?.chartid === record.chart_id) {
                            chartInfo = info.chart[level]
                            break
                        }
                    }
                }
            }

            let gradeInfo = getGradeForRecord(record, chartInfo)
            let grade = gradeInfo?.grade || '?'
            gradeCount[grade] = (gradeCount[grade] || 0) + 1
            totalAcc += record.score_accuracy || 0
        }

        let avgAcc = scores.length > 0 ? (totalAcc / scores.length * 100).toFixed(2) : 0

        let saveTypeNote = player.saveType === 'saves'
            ? '\n数据来源：saves.db'
            : player.saveType === 'data'
                ? '\n数据来源：data.db'
                : ''

        let msg = `====== ${player.username} 的数据统计 ======\n`
        msg += `Reality: ${reality.toFixed(2)}\n`
        msg += `总成绩数：${player.totalScores}\n`
        msg += `平均ACC：${avgAcc}%\n`
        msg += `\n------ 评级分布 ------${saveTypeNote}\n`
        for (let grade of ['R', 'AP', 'FC', 'M', 'SS', 'S', 'A', 'B', 'C', 'F']) {
            if (gradeCount[grade]) {
                msg += `${grade}: ${gradeCount[grade]}\n`
            }
        }

        send.send_with_At(e, msg)
        return true
    }

    /**
     * 帮助（图像化）
     */
    async help(e) {
        let cmd = Config.getUserCfg('config', 'cmdhead')

        // 随机背景曲绘
        let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

        let data = {
            title: 'Milthm 帮助',
            subTitle: 'mil-plugin',
            background: bgIll,
            version: Version.ver,
            helpGroup: [
                {
                    group: '曲目信息',
                    list: [
                        { title: `/${cmd} song <曲名>`, desc: '查看曲目图鉴（图片）' },
                        { title: `/${cmd} ill <曲名>`, desc: '查看曲绘' },
                        { title: `/${cmd} alias <曲名>`, desc: '查看别名' },
                        { title: `/${cmd} setnick <原名> ---> <别名>`, desc: '设置别名（管理员）' }
                    ]
                },
                {
                    group: '成绩查询',
                    list: [
                        { title: '发送 saves.db 文件', desc: '导入存档（推荐 saves.db，数据更精确）' },
                        { title: `/${cmd} b20 [数量]`, desc: '查询 Best 成绩，例: /mil b30' },
                        { title: `/${cmd} score <曲名>`, desc: '单曲成绩明细' },
                        { title: `/${cmd} data`, desc: '数据统计' },
                        { title: `/${cmd} delete`, desc: '删除存档' }
                    ]
                },
                {
                    group: '云存档',
                    list: [
                        { title: `/${cmd} bind`, desc: '授权 Milthm 云存档（自动续期）' },
                        { title: `/${cmd} update`, desc: '从云端下载并导入最新存档' },
                        { title: `/${cmd} unbind`, desc: `解除授权（不删除本地存档）` }
                    ]
                },
                {
                    group: '其他',
                    list: [
                        { title: `/${cmd} tips`, desc: '随机Tips' }
                    ]
                }
            ]
        }

        send.send_with_At(e, await picmodle.help(data))
        return true
    }
}

/**
 * 渲染单曲成绩图片
 */
async function renderScore(save, songKey) {
    let info = getInfo.info(songKey)
    if (!info) return `未找到${songKey}的曲目信息QAQ！`

    let player = save.getPlayerInfo()
    let { reality } = save.getB20WithReality(20, getInfo)

    let scoreData = []
    for (let level of fCompute.Level) {
        let chart = info.chart[level]
        if (!chart || !chart.chartid) continue

        let record = save.getChartScore(chart.chartid)

        if (record) {
            let gradeInfo = getGradeForRecord(record, chart)
            let singleRlt = calcReality(record.score, chart.difficulty, parseGameVersion(record.game_version), record.score_accuracy)
            // saves.db 不含判定明细，不显示判定详细
            let showJudges = record._source !== 'saves'

            scoreData.push({
                level,
                levelAbbr: fCompute.LevelAbbr[level] || level,
                difficulty: chart.difficulty,
                score: record.score,
                accuracy: record.score_accuracy || 0,
                reality: singleRlt,
                combo: chart.combo,
                grade: gradeInfo.grade,
                gradeIcon: gradeInfo.iconName,
                exact: showJudges ? (record.score_exact_count || 0) : 0,
                perfect: showJudges ? (record.score_perfect_count || 0) : 0,
                good: showJudges ? (record.score_good_count || 0) : 0,
                bad: showJudges ? (record.score_bad_count || 0) : 0,
                miss: showJudges ? (record.score_miss_count || 0) : 0,
                showJudges,
                notPlayed: false,
                played_at: record.played_at ? fCompute.formatDate(record.played_at) : ''
            })
        } else {
            // 未游玩该难度
            scoreData.push({
                level,
                levelAbbr: fCompute.LevelAbbr[level] || level,
                difficulty: chart.difficulty,
                score: 0,
                accuracy: 0,
                reality: 0,
                combo: chart.combo,
                grade: '',
                gradeIcon: '',
                notPlayed: true,
                showJudges: false
            })
        }
    }

    // 计算星星等级（同 B20 逻辑：AP/R 所在难度定数决定）
    let starLevel = 0
    for (let item of scoreData) {
        if (item.notPlayed) continue
        let isAP = item.accuracy >= 0.9999
        let isR = item.grade === 'R'
        if (isAP || isR) {
            if (item.difficulty >= 12.0) starLevel = Math.max(starLevel, 3)
            else if (item.difficulty >= 9.0) starLevel = Math.max(starLevel, 2)
            else if (item.difficulty >= 6.0) starLevel = Math.max(starLevel, 1)
        }
    }

    return await picmodle.score({
        avatar: randomAvatar(),
        username: player.username,
        reality,
        starLevel,
        songName: info.song,
        artist: info.artist || '',
        chapter_zh: info.chapter_zh || '',
        illustration: info.illustration || '',
        scoreData,
        version: Version.ver,
        background: info.illustration || ''
    })
}

/**
 * 文件下载
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        let protocol = url.startsWith('https') ? https : http
        let file = fs.createWriteStream(destPath)
        protocol.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close()
                try { fs.unlinkSync(destPath) } catch { }
                return downloadFile(response.headers.location, destPath).then(resolve).catch(reject)
            }
            response.pipe(file)
            file.on('finish', () => { file.close(); resolve() })
        }).on('error', (err) => {
            file.close()
            try { fs.unlinkSync(destPath) } catch { }
            reject(err)
        })
    })
}
