import Config from '../components/Config.js'
import send from '../model/send.js'
import getInfo from '../model/getInfo.js'
import fCompute from '../model/fCompute.js'
import { calcReality, realityv2, realityv3, parseGameVersion } from '../model/reality.js'
import { calcPushSuggestion } from '../model/pushSuggestion.js'
import { getFileInfo, getFileContent, makeForwardMsg } from '../components/common.js'
import getSave from '../model/getSave.js'
import SaveManager from '../model/SaveManager.js'
import UpdateLog from '../model/UpdateLog.js'
import picmodle from '../model/picmodle.js'
import { buildRksHistory, renderUpdateImage } from '../model/updateRender.js'
import milPluginBase from '../components/baseClass.js'
import Version from '../components/Version.js'
import logger from '../components/Logger.js'
import UserSettingsStore from '../model/userSettings.js'
import fs from 'fs'
import https from 'https'
import http from 'http'


/**@import {botEvent} from '../components/baseClass.js' */

// 随机头像列表
const avatarList = getInfo.getAvatar();

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
    if (record._source === 'saves' || record._source === 'nya_profiler') {
        // saves.db / nya_profiler: BestLevel 定分数评级，acc=100% 判定 AP，AchievedStatus 含 4 判定 FC
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

/**
 * 遍历全部存档成绩计算星星等级
 * 只要存档中任意谱面AP过对应定数阈值即可获得星星
 * @param {SaveManager} save
 * @param {object} getInfo
 * @returns {number}
 */
function computeStarLevel(save, getInfo) {
    let starLevel = 0
    for (let record of save.scores) {
        let songKey = getInfo.chartIdToSongKey(record.chart_id)
        if (!songKey) continue
        let info = getInfo.info(songKey)
        if (!info) continue

        let difficulty = 0
        for (let level of fCompute.Level) {
            if (info.chart[level]?.chartid === record.chart_id) {
                difficulty = info.chart[level].difficulty || 0
                break
            }
        }

        let isAP = record.score_accuracy >= 0.9999
        // 对于 data.db，检查是否全Perfect/Exact
        if (record._source !== 'saves' && record._source !== 'nya_profiler' && !isAP) {
            let songKey2 = getInfo.chartIdToSongKey(record.chart_id)
            if (songKey2) {
                let info2 = getInfo.info(songKey2)
                if (info2) {
                    let totalCombo = 1
                    for (let level of fCompute.Level) {
                        if (info2.chart[level]?.chartid === record.chart_id) {
                            totalCombo = info2.chart[level].combo || 1
                            break
                        }
                    }
                    let perfectAndExact = (record.score_exact_count || 0) + (record.score_perfect_count || 0)
                    isAP = perfectAndExact >= totalCombo
                }
            }
        }
        // BestLevel === 0 即 R 评（全Exact理论值）
        let isR = record._bestLevel === 0

        if (isAP || isR) {
            if (difficulty >= 12.0) starLevel = Math.max(starLevel, 3)
            else if (difficulty >= 9.0) starLevel = Math.max(starLevel, 2)
            else if (difficulty >= 6.0) starLevel = Math.max(starLevel, 1)
        }
    }
    return starLevel
}

/**
 * 根据原始记录字段计算「质量排序值」（数字越小越好）
 * 用于同一谱面新旧版本间选最优记录
 * @param {object} record 原始成绩记录
 * @param {number} combo 谱面总combo
 * @returns {number}
 */
function getRecordQualityRank(record, combo) {
    if (record._source === 'saves' || record._source === 'nya_profiler') {
        // saves.db / nya_profiler / 云存档 JSON：BestLevel 0=R, 1=M, 2=SS, 3=S, 4=A, 5=B, 6=C, 7=F
        // AP 看 acc >= 0.9999；FC 看 AchievedStatus 含 4
        let isR = record._bestLevel === 0
        let isAP = !isR && record.score_accuracy >= 0.9999
        let isFC = !isR && !isAP && Array.isArray(record._achievedStatus) && record._achievedStatus.includes(4)
        if (isR) return 0
        if (isAP) return 1
        if (isFC) return 2
        // 纯分数评级：BestLevel 越大越差（1~7 映射到 3~9）
        return 3 + (record._bestLevel != null ? record._bestLevel : 7)
    } else {
        // data.db：从判定明细计算
        let totalCombo = combo || 1
        let exactCount = record.score_exact_count || 0
        let perfectCount = record.score_perfect_count || 0
        let perfectAndExact = exactCount + perfectCount
        let badCount = record.score_bad_count || 0
        let missCount = record.score_miss_count || 0
        let actualCombo = totalCombo - badCount - missCount

        let isAllExact = exactCount >= totalCombo
        let isAllPerfectOrExact = perfectAndExact >= totalCombo
        let isFC = (badCount === 0 && missCount === 0) || actualCombo >= totalCombo

        if (isAllExact && record.score >= 1010000) return 0  // R
        if (isAllPerfectOrExact && !isAllExact) return 1     // AP（非R）
        if (isFC && !isAllPerfectOrExact) return 2           // FC（非AP）
        // 纯分数评级
        let scoreGrade = fCompute.getScoreGrade(record.score)
        let gradeMap = { 'M': 3, 'SS': 4, 'S': 5, 'A': 6, 'B': 7, 'C': 8, 'F': 9 }
        return gradeMap[scoreGrade] != null ? gradeMap[scoreGrade] : 9
    }
}

/**
 * 将推分计算结果转为模板显示用的 {pushText, pushClass}
 * @param {number|string|null} pushDisplay - calcPushSuggestion 输出的简化值
 * @returns {{pushText: string|null, pushClass: string}}
 */
function formatPushDisplay(pushDisplay) {
    if (pushDisplay === null || pushDisplay === undefined) {
        return { pushText: null, pushClass: '' }
    }
    if (pushDisplay === '无法推分') {
        return { pushText: '无法推分', pushClass: 'push-fail' }
    }
    // number
    let score = pushDisplay
    let cls
    if (score > 980000) cls = 'push-98'
    else if (score >= 950000) cls = 'push-95'
    else if (score >= 920000) cls = 'push-92'
    else if (score >= 880000) cls = 'push-88'
    else cls = 'push-low'
    return { pushText: String(score), pushClass: cls }
}

/**
 * 遍历全部存档成绩，按谱面去重后统计各难度 C/FC/AP 数量
 * 同一谱面的新旧版本记录取评级最高的一条（基于原始数据字段判断）
 *
 * C/FC/AP 判定逻辑（直接读取原始字段，不依赖 grade 字符串）：
 *   - saves.db / 云存档 JSON：
 *     C  = BestLevel ≤ 6（非 F）
 *     FC = BestLevel === 0(R) 或 AchievedStatus 包含 4
 *     AP = BestLevel === 0(R) 或 score_accuracy ≥ 0.9999
 *   - data.db（有判定明细）：
 *     C  = score ≥ 600000
 *     FC = combo 完整（无 Bad/Miss）
 *     AP = 全部 Perfect 或 Exact（无 Good/Bad/Miss）
 *
 * @param {SaveManager} save
 * @param {object} getInfo
 * @returns {{ byDiff: object, stats: Array<{title: string, c: number, fc: number, ap: number}> }}
 */
function computeAllChartStats(save, getInfo) {
    // 按 chart_id 分组
    let chartGroups = {}
    for (let record of save.scores) {
        if (!chartGroups[record.chart_id]) chartGroups[record.chart_id] = []
        chartGroups[record.chart_id].push(record)
    }

    let byDiff = {}
    for (let level of fCompute.Level) {
        byDiff[level] = { c: 0, fc: 0, ap: 0 }
    }

    for (let [chartId, records] of Object.entries(chartGroups)) {
        let songKey = getInfo.chartIdToSongKey(chartId)
        if (!songKey) continue
        let info = getInfo.info(songKey)
        if (!info) continue

        let diffLevel = null
        let totalCombo = 1
        for (let level of fCompute.Level) {
            if (info.chart[level]?.chartid === chartId) {
                diffLevel = level
                totalCombo = info.chart[level].combo || 1
                break
            }
        }
        if (!diffLevel) continue

        // 取质量最优的记录（按原始字段排名）
        let bestRecord = null
        let bestRank = 999
        for (let record of records) {
            let rank = getRecordQualityRank(record, totalCombo)
            if (rank < bestRank) {
                bestRank = rank
                bestRecord = record
            }
        }

        if (!bestRecord) continue

        // ----- 按原始字段判定 C / FC / AP -----
        let isC, isFC, isAP

        if (bestRecord._source === 'saves' || bestRecord._source === 'nya_profiler') {
            // saves.db / nya_profiler / 云存档 JSON
            let bestLevel = bestRecord._bestLevel
            isC = bestLevel == null || bestLevel <= 6  // 非 F(7)
            isFC = bestLevel === 0  // R 也是 FC
                || (Array.isArray(bestRecord._achievedStatus) && bestRecord._achievedStatus.includes(4))
            isAP = bestLevel === 0  // R 也是 AP
                || bestRecord.score_accuracy >= 0.9999
        } else {
            // data.db：从判定明细计算
            let exactCount = bestRecord.score_exact_count || 0
            let perfectCount = bestRecord.score_perfect_count || 0
            let perfectAndExact = exactCount + perfectCount
            let badCount = bestRecord.score_bad_count || 0
            let missCount = bestRecord.score_miss_count || 0
            let actualCombo = totalCombo - badCount - missCount

            isC = bestRecord.score >= 600000
            isFC = (badCount === 0 && missCount === 0) || actualCombo >= totalCombo
            isAP = perfectAndExact >= totalCombo
        }

        // AP ⊂ FC ⊂ C：高等级向下兼容累加
        if (isAP) {
            byDiff[diffLevel].ap++
            byDiff[diffLevel].fc++
            byDiff[diffLevel].c++
        } else if (isFC) {
            byDiff[diffLevel].fc++
            byDiff[diffLevel].c++
        } else if (isC) {
            byDiff[diffLevel].c++
        }
    }

    let stats = []
    for (let level of fCompute.Level) {
        stats.push({
            title: fCompute.LevelAbbr[level],
            c: byDiff[level].c,
            fc: byDiff[level].fc,
            ap: byDiff[level].ap
        })
    }

    return { byDiff, stats }
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
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(p|ap|P|AP)\\s*[0-9]*.*$`,
                    fnc: 'p20'
                },
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(com|cal|计算)(\\s+).*$`,
                    fnc: 'com'
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
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(recent|最近)$`,
                    fnc: 'recent'
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
        const { fileName, fileId, busid, fileHash, fileUrl } = fileInfo;
        if (!fileName.endsWith('.db')) {
            return false
        }
        send.send_with_At(e, '正在下载并解析存档文件...', true);
        // 2. 获取文件内容（字符串）
        let fileContent;
        try {
            fileContent = await getFileContent(e, fileId, busid, fileHash, fileUrl);
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
            let saved = getSave.saves[e.user_id]
            let onlineNote = (saved && saved.isOnline()) ? '\n⚠️ 你已绑定在线平台，B20 将使用在线数据。本次导入的存档仅用于补充详细判定和离线回退。' : ''
            let baseMsg = `${result.msg}\n用户名：${result.username}\n数据来源：${saveTypeName}\n共导入${getSave.saves[e.user_id]?.scores?.length || 0}条成绩记录${saveTypeHint}${onlineNote}\n现在可以查询成绩了！`

            // 始终渲染 update 图片（首次导入展示 top 6，后续展示 diff）
            let updateImg = await renderUpdateImage(e.user_id, result.updateEntry)
            send.send_with_At(e, updateImg)
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

        // 检测在线/离线状态
        let isOnline = save.isOnline()
        let userSettings = UserSettingsStore.getSettings(e.user_id)
        let mode = userSettings.cloudMode || 'touch'

        if (!isOnline && !save.hasSave() && save.scores.length === 0) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定Milkloud账号，或者发送存档文件(.db)给BOT进行导入`)
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

        // 获取成绩并计算Reality（按用户模式过滤；在线模式自动走云端）
        let { scores, reality, displayReality } = save.getB20WithReality(fetchNum, getInfo, mode)

        // 在线模式：使用云端返回的 Reality 值（与游戏内一致，并向下取整）
        if (isOnline) {
            if (mode === 'touch') {
                reality = save.cloudData.touch?.rankReality || reality
            } else if (mode === 'keyboard') {
                reality = save.cloudData.keyboard?.rankReality || reality
            }
        }
        displayReality = fCompute.floorReality(reality)

        let player = save.getPlayerInfo()

        // --- 计算星星（优先使用 Nya Profiler 的预计算结果） ---
        let starLevel
        if (save.nyaStarCount != null) {
            starLevel = save.nyaStarCount
        } else {
            starLevel = computeStarLevel(save, getInfo)
        }

        // --- 谱面完成统计（优先使用 Nya Profiler 的 chartProgress） ---
        let stats
        if (save.nyaChartProgress) {
            // 将 API 的 chartProgress 转为 stats 格式
            // API: { CL: {all,ap,fc,cl}, CB: {...}, SK: {...}, DZ: {...} }
            // stats: [{title:'DZ',c,fc,ap}, {title:'SK',c,fc,ap}, {title:'CB',c,fc,ap}, {title:'CL',c,fc,ap}]
            let cp = save.nyaChartProgress
            let diffOrder = ['DZ', 'SK', 'CB', 'CL']
            stats = diffOrder.map(code => ({
                title: code,
                c: (cp[code]?.cl || cp[code]?.c || 0),
                fc: (cp[code]?.fc || 0),
                ap: (cp[code]?.ap || 0)
            }))
        } else {
            let result = computeAllChartStats(save, getInfo)
            stats = result.stats
        }

        // --- 构建 B20 成绩列表 ---
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

            // Reality 版本判定（只看 Best 范围内的）
            if (i < bestNum) {
                let gv = parseGameVersion(record.game_version)
                if (gv < 4.0) allV3 = false
            }

            // --- 推分建议计算 ---
            let pushText = null, pushClass = ''
            try {
                let pushSuggestion = calcPushSuggestion({
                    currentReality: reality,
                    b20Scores: scores,
                    targetChartId: record.chart_id,
                    chartDifficulty: difficulty,
                    chartBestScore: record._displayScore != null ? record._displayScore : record.score,
                    chartBestReality: singleRlt
                })
                if (pushSuggestion) {
                    let formatted = formatPushDisplay(pushSuggestion.achievable ? pushSuggestion.targetScore : '无法推分')
                    pushText = formatted.pushText
                    pushClass = formatted.pushClass
                }
            } catch (err) {
                logger.error(`[mil-plugin][推分建议] 计算失败:`, err)
            }
            // 显示分取最高分（可能不同于计算 Reality 的版本），匹配游戏内行为
            let displayScore = record._displayScore != null ? record._displayScore : record.score
            let displayAcc = record._displayAccuracy != null ? record._displayAccuracy : (record.score_accuracy || 0)
            scoreData.push({
                song: songName,
                artist: songArtist,
                illustration,
                level: diffLevel,
                levelAbbr: fCompute.LevelAbbr[diffLevel] || diffLevel,
                difficulty,
                bpm,
                score: displayScore,
                accuracy: displayAcc,
                reality: fCompute.floorReality(singleRlt),
                grade: gradeInfo.grade,
                gradeIcon: gradeInfo.iconName,
                exact: record.score_exact_count || 0,
                perfect: record.score_perfect_count || 0,
                great: record.score_great_count || 0,
                good: record.score_good_count || 0,
                bad: record.score_bad_count || 0,
                miss: record.score_miss_count || 0,
                isOverflow: i >= bestNum,
                pushText,
                pushClass
            })
        }

        // 随机背景曲绘
        let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

        let modeLabel = mode === 'touch' ? '触屏' : mode === 'keyboard' ? '键盘' : '合并'
        let sourceLabel = isOnline
            ? (save.onlineBackend === 'milkloud' ? 'Milkloud 在线' : 'Nya Profiler 在线')
            : '本地存档'

        let data = {
            avatar: randomAvatar(),
            username: player.username,
            reality: reality,
            realityIcon: allV3 ? 'reality_v3' : 'reality',
            starLevel,
            scores: scoreData.slice(0, nnum),
            overflowIndex: bestNum,
            stats,
            updateTime: fCompute.formatDate(new Date().toISOString()),
            background: bgIll,
            version: Version.ver,
            modeLabel,
            sourceLabel
        }
        if (!Config.getUserCfg('config', 'isGuild')) {
            e.reply("正在生成图片，请稍等一下哦！\n//·/w\\·\\\\", false, { recallMsg: 5 })
        }
        send.send_with_At(e, await picmodle.b20(data))

        return true
    }

    /**
     * P20 查询（All Perfect B20）
     * 仅统计 acc=100%（AP）曲目的 Best 20 Reality
     * 与 B20 复用同一渲染模板，添加 "All Perfect Mode" 标识
     */
    async p20(e) {
        let save = await getSave.getSave(e.user_id)
        let isOnline = save.isOnline()
        if (!isOnline && !save.hasSave() && save.scores.length === 0) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或者发送存档文件(.db)给BOT进行导入哦`)
            return true
        }

        let userSettings = UserSettingsStore.getSettings(e.user_id)
        let mode = userSettings.cloudMode || 'touch'

        let msg = e.msg
        let numMsg = msg.match(/^.*?(p|ap|P|AP)\s*([0-9]+)/i)?.[0]
        let nnum = numMsg ? Number(numMsg.replace(/^.*?(p|ap|P|AP)\s*/i, '')) : 20
        if (!nnum || nnum <= 22) nnum = 22

        let maxNum = Config.getUserCfg('config', 'B20MaxNum') || 50
        nnum = Math.min(nnum, maxNum)

        let bestNum = 20
        let fetchNum = Math.min(nnum + 2, maxNum + 2)

        // 使用 AP 过滤的 Reality 计算（按用户模式过滤）
        let { scores, reality } = save.getAP20WithReality(fetchNum, getInfo, mode)
        // 同时获取普通 B20 Reality 做比对
        let { reality: normalReality } = save.getB20WithReality(20, getInfo, mode)
        let player = save.getPlayerInfo()

        // 构建 stars / stats（与 b20 一致）
        let starLevel = save.nyaStarCount ?? computeStarLevel(save, getInfo)

        let stats
        if (save.nyaChartProgress) {
            let cp = save.nyaChartProgress
            let diffOrder = ['DZ', 'SK', 'CB', 'CL']
            stats = diffOrder.map(code => ({
                title: code,
                c: (cp[code]?.cl || cp[code]?.c || 0),
                fc: (cp[code]?.fc || 0),
                ap: (cp[code]?.ap || 0)
            }))
        } else {
            stats = computeAllChartStats(save, getInfo).stats
        }

        // 构建成绩列表（与 b20 逻辑一致）
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

            if (i < bestNum) {
                let gv = parseGameVersion(record.game_version)
                if (gv < 4.0) allV3 = false
            }

            let pushText = null, pushClass = ''
            try {
                let pushSuggestion = calcPushSuggestion({
                    currentReality: reality,
                    b20Scores: scores,
                    targetChartId: record.chart_id,
                    chartDifficulty: difficulty,
                    chartBestScore: record._displayScore != null ? record._displayScore : record.score,
                    chartBestReality: singleRlt
                })
                if (pushSuggestion) {
                    let formatted = formatPushDisplay(pushSuggestion.achievable ? pushSuggestion.targetScore : '无法推分')
                    pushText = formatted.pushText
                    pushClass = formatted.pushClass
                }
            } catch {}
            let displayScore = record._displayScore != null ? record._displayScore : record.score
            let displayAcc = record._displayAccuracy != null ? record._displayAccuracy : (record.score_accuracy || 0)
            scoreData.push({
                song: songName,
                artist: songArtist,
                illustration,
                level: diffLevel,
                levelAbbr: fCompute.LevelAbbr[diffLevel] || diffLevel,
                difficulty,
                bpm,
                score: displayScore,
                accuracy: displayAcc,
                reality: fCompute.floorReality(singleRlt),
                grade: gradeInfo.grade,
                gradeIcon: gradeInfo.iconName,
                exact: record.score_exact_count || 0,
                perfect: record.score_perfect_count || 0,
                great: record.score_great_count || 0,
                good: record.score_good_count || 0,
                bad: record.score_bad_count || 0,
                miss: record.score_miss_count || 0,
                isOverflow: i >= bestNum,
                pushText,
                pushClass
            })
        }

        let bgIll = getInfo.getill(getInfo.all_id[fCompute.randBetween(0, getInfo.all_id.length - 1)] || '')

        let data = {
            avatar: randomAvatar(),
            username: player.username,
            reality,
            realityIcon: allV3 ? 'reality_v3' : 'reality',
            starLevel,
            scores: scoreData.slice(0, nnum),
            overflowIndex: bestNum,
            stats,
            updateTime: fCompute.formatDate(new Date().toISOString()),
            background: bgIll,
            version: Version.ver,
            spInfo: ['All Perfect Mode']
        }

        let res = []
        if (!Config.getUserCfg('config', 'isGuild')) {
            e.reply("正在生成图片，请稍等一下哦！\n//·/w\\·\\\\", false, { recallMsg: 5 })
        }
        res.push(await picmodle.b20(data))
        // 追加文本：计算 Reality vs 存档 Reality
        res.push(`计算AP Reality：${reality.toFixed(4)}\n存档Reality：${normalReality.toFixed(4)}`)
        if (scores.length < 20) {
            res.push(`\nAP 曲目不足 20 首（当前仅 ${scores.length} 首），Reality 仅基于已有数据计算`)
        }
        send.send_with_At(e, res)

        return true
    }

    /**
     * 单曲Reality计算器
     * 命令格式：/mil com <定数> <分数>
     * 例：/mil com 12.5 1000000
     */
    async com(e) {
        let msg = e.msg.replace(/[#/](.*?)(com|cal|计算)(\s*)/, '').trim()
        // 提取两个数字：定数 和 分数
        let parts = msg.split(/\s+/)
        if (parts.length < 2) {
            send.send_with_At(e, `格式有误！请使用：/${Config.getUserCfg('config', 'cmdhead')} com <定数> <分数>\n例：/${Config.getUserCfg('config', 'cmdhead')} com 12.5 1000000`)
            return true
        }

        let difficulty = parseFloat(parts[0])
        let score = parseInt(parts[1])

        if (isNaN(difficulty) || isNaN(score)) {
            send.send_with_At(e, `请输入有效的数字！\n定数如 12.5，分数如 1000000`)
            return true
        }

        if (difficulty < 0 || difficulty > 16) {
            send.send_with_At(e, `定数范围应为 0~16，你输入的是 ${difficulty}`)
            return true
        }
        if (score < 0 || score > 1010000) {
            send.send_with_At(e, `分数范围应为 0~1010000，你输入的是 ${score}`)
            return true
        }

        let v2 = realityv2(score, difficulty)
        let v3 = realityv3(score, difficulty)

        // 实际采用的 Reality：旧版(<4.0)和新版(≥4.0)分别计算
        let rltOld = calcReality(score, difficulty, 3.0)   // 旧版 (gameVersion < 4.0)
        let rltNew = calcReality(score, difficulty, 5.0)   // 新版 (gameVersion >= 4.0)

        let msg2 = `====== 单曲 Reality 计算 ======\n`
        msg2 += `定数: ${difficulty.toFixed(1)}\n`
        msg2 += `分数: ${score}\n`
        msg2 += `------ 公式结果 ------\n`
        msg2 += `V2 公式: ${v2.toFixed(4)}\n`
        msg2 += `V3 公式: ${v3.toFixed(4)}\n`
        msg2 += `------ 实际采用 ------\n`
        msg2 += `旧版 (<4.0): ${rltOld.toFixed(4)}\n`
        msg2 += `新版 (≥4.0): ${rltNew.toFixed(4)}\n`
        msg2 += `\n注：旧版非AP且分数≤1005000时采用V2，否则V3；新版统一V3`

        send.send_with_At(e, msg2)
        return true
    }

    /**
     * 单曲成绩（图像渲染）
     */
    async singlescore(e) {
        let save = await getSave.getSave(e.user_id)
        let isOnline = save.isOnline()
        if (!isOnline && !save.hasSave() && save.scores.length === 0) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或发送存档文件(saves.db)给BOT，进行导入嗷`)
            return true
        }

        let userSettings = UserSettingsStore.getSettings(e.user_id)
        let mode = userSettings.cloudMode || 'touch'

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
                send.send_with_At(e, await renderScore(save, id, mode))
            })
            return true
        }
        send.send_with_At(e, await renderScore(save, ids[0], mode))
        return true
    }

    /**
     * 数据统计
     */
    async data(e) {
        let save = await getSave.getSave(e.user_id)

        let isOnline = save.isOnline()
        if (!isOnline && !save.hasSave() && save.scores.length === 0) {
            send.send_with_At(e, `你还没有导入存档哦！请先使用/${Config.getUserCfg('config', 'cmdhead')} bind绑定存档，或发送存档文件进行导入哦`)
            return true
        }

        let userSettings = UserSettingsStore.getSettings(e.user_id)
        let mode = userSettings.cloudMode || 'touch'

        let player = save.getPlayerInfo()
        let scores = save.scores
        let { reality, displayReality } = save.getB20WithReality(20, getInfo, mode)

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

        let saveTypeNote = isOnline
            ? `\n数据来源：${save.onlineBackend === 'milkloud' ? 'Milkloud 在线' : 'Nya Profiler 在线'}`
            : player.saveType === 'saves'
                ? '\n数据来源：saves.db'
                : player.saveType === 'data'
                    ? '\n数据来源：data.db'
                    : ''

        let msg = `====== ${player.username} 的数据统计 ======\n`
        msg += `Reality: ${displayReality.toFixed(2)}\n`
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
     * 最近游玩记录
     */
    async recent(e) {
        let save = await getSave.getSave(e.user_id)
        let isOnline = save.isOnline()
        if (!isOnline && !save.hasSave() && save.scores.length === 0) {
            send.send_with_At(e, `你还没有导入存档哦！\n请先使用 /${Config.getUserCfg('config', 'cmdhead')} update 更新数据`)
            return true
        }

        let userSettings = UserSettingsStore.getSettings(e.user_id)
        let mode = userSettings.cloudMode || 'touch'

        // 按用户模式获取最近游玩记录
        let record = null
        if (mode === 'touch') {
            record = save.cloudData?.touch?.recentPlay || null
        } else if (mode === 'keyboard') {
            record = save.cloudData?.keyboard?.recentPlay || null
        }
        // merge 模式或无对应模式记录时回退
        if (!record && mode === 'merge') {
            let touchRecent = save.cloudData?.touch?.recentPlay
            let keyboardRecent = save.cloudData?.keyboard?.recentPlay
            if (touchRecent && keyboardRecent) {
                record = (touchRecent.played_at || '') > (keyboardRecent.played_at || '')
                    ? touchRecent : keyboardRecent
            } else {
                record = touchRecent || keyboardRecent || null
            }
        }
        // 兼容旧格式 fallback
        if (!record) record = save.cloudRecentPlay

        if (!record) {
            let hint = mode !== 'merge'
                ? `当前为${mode === 'touch' ? '触屏' : '键盘'}模式，无最近记录。可使用 #${Config.getUserCfg('config', 'cmdhead')} myset mode merge 切换至合并模式查看`
                : '暂无最近游玩记录！'
            send.send_with_At(e, `${hint}\n请使用 /${Config.getUserCfg('config', 'cmdhead')} update 同步云端数据后再试~`)
            return true
        }

        let player = save.getPlayerInfo()
        let { reality } = save.getB20WithReality(20, getInfo, mode)
        let starLevel = computeStarLevel(save, getInfo)

        // 解析歌曲信息
        let songKey = getInfo.chartIdToSongKey(record.chart_id)
        let songName = record.chart_id
        let artist = ''
        let illustration = ''
        let chapter_zh = ''
        let diffLevel = 'Drizzle'
        let difficulty = 0
        let gradeIcon = ''

        if (songKey) {
            let info = getInfo.info(songKey)
            if (info) {
                songName = info.song || songKey
                artist = info.artist || ''
                illustration = info.illustration || ''
                chapter_zh = info.chapter_zh || ''
                for (let level of fCompute.Level) {
                    if (info.chart[level]?.chartid === record.chart_id) {
                        diffLevel = level
                        difficulty = info.chart[level].difficulty || 0
                        break
                    }
                }
            }
        }

        // 评级图标（使用真实 combo）
        let chartInfo = { combo: 1 }
        if (songKey) {
            let info = getInfo.info(songKey)
            if (info && info.chart[diffLevel]) {
                chartInfo = info.chart[diffLevel]
            }
        }
        let gradeInfo = getGradeForRecord(record, chartInfo)
        gradeIcon = gradeInfo.iconName

        // 格式化游玩时间
        let playedAt = record.played_at ? fCompute.formatDate(record.played_at) : ''

        send.send_with_At(e, await picmodle.recent({
            avatar: randomAvatar(),
            username: player.username,
            reality,
            starLevel,
            songName,
            artist,
            chapter_zh,
            illustration,
            level: diffLevel,
            levelAbbr: fCompute.LevelAbbr[diffLevel] || diffLevel,
            difficulty,
            score: record.score,
            accuracy: record.score_accuracy || 0,
            grade: gradeInfo.grade,
            gradeIcon,
            exact: record.score_exact_count || 0,
            perfect: record.score_perfect_count || 0,
            great: record.score_great_count || 0,
            good: record.score_good_count || 0,
            bad: record.score_bad_count || 0,
            miss: record.score_miss_count || 0,
            played_at: playedAt,
            background: illustration,
            version: Version.ver,
            songreality: record.reality
        }))
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
                        { title: `/${cmd} table <曲名>`, desc: '查看定数表' },
                        { title: `/${cmd} setnick <原名> ---> <别名>`, desc: '设置别名（管理员）' }
                    ]
                },
                {
                    group: '成绩查询',
                    list: [
                        { title: '发送 saves.db 文件', desc: '导入存档（推荐 saves.db，数据更精确）' },
                        { title: `/${cmd} b20 [数量]`, desc: '查询 Best 成绩，例: /mil b30' },
                        { title: `/${cmd} p20 [数量]`, desc: '查询 All Perfect Best 成绩，例: /mil p20' },
                        { title: `/${cmd} score <曲名>`, desc: '单曲成绩明细' },
                        { title: `/${cmd} recent`, desc: '最近一次游玩记录' },
                        { title: `/${cmd} data`, desc: '数据统计' },
                        { title: `/${cmd} delete`, desc: '删除存档' }
                    ]
                },
                {
                    group: '云存档 / 查分',
                    list: [
                        { title: `/${cmd} bind`, desc: '授权云存档或查分器（自动续期）' },
                        { title: `/${cmd} update`, desc: '从云端 / 查分器获取并导入最新数据' },
                        { title: `/${cmd} unbind`, desc: `解除授权（不删除本地存档）` }
                    ]
                },
                {
                    group: '娱乐功能',
                    list: [
                        { title: `/${cmd} guess`, desc: '猜曲绘游戏，回答可以直接发送' },
                        { title: `/${cmd} letter`, desc: '开字母游戏，用#open开字母，#n猜测答案' },
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
async function renderScore(save, songKey, mode = 'merge') {
    let info = getInfo.info(songKey)
    if (!info) return `未找到${songKey}的曲目信息QAQ！`

    let player = save.getPlayerInfo()
    let { scores: b20Scores, reality } = save.getB20WithReality(22, getInfo, mode)

    let scoreData = []
    for (let level of fCompute.Level) {
        let chart = info.chart[level]
        if (!chart || !chart.chartid) continue

        let record = save.getChartScore(chart.chartid)

        // --- 推分建议计算 ---
        let pushText = null, pushClass = ''
        try {
            let chartBestRlt = 0
            let chartBestScore = 0
            if (record) {
                chartBestRlt = calcReality(record.score, chart.difficulty, parseGameVersion(record.game_version), record.score_accuracy)
                chartBestScore = record.score
            }
            let pushSuggestion = calcPushSuggestion({
                currentReality: reality,
                b20Scores,
                targetChartId: chart.chartid,
                chartDifficulty: chart.difficulty,
                chartBestScore,
                chartBestReality: chartBestRlt
            })
            if (pushSuggestion) {
                let formatted = formatPushDisplay(pushSuggestion.achievable ? pushSuggestion.targetScore : '无法推分')
                pushText = formatted.pushText
                pushClass = formatted.pushClass
                // logger.info(`[mil-plugin][推分建议] ${info.song} [${fCompute.LevelAbbr[level]}] 推分建议:`, JSON.stringify(pushSuggestion))
            }
        } catch (err) {
            logger.error(`[mil-plugin][推分建议] 计算失败:`, err)
        }

        if (record) {
            let gradeInfo = getGradeForRecord(record, chart)
            let singleRlt = calcReality(record.score, chart.difficulty, parseGameVersion(record.game_version), record.score_accuracy)
            // saves.db / nya_profiler 不含判定明细，不显示判定详细
            // 但若被云端 Rank 接口富化过（_cloudEnriched），则有详细判定数据可展示
            let showJudges = (record._source !== 'saves' && record._source !== 'nya_profiler') || record._cloudEnriched

            scoreData.push({
                level,
                levelAbbr: fCompute.LevelAbbr[level] || level,
                difficulty: chart.difficulty,
                isMultiFinger: chart.isMultiFinger || false,
                score: record.score,
                accuracy: record.score_accuracy || 0,
                reality: fCompute.floorReality(singleRlt),
                combo: chart.combo,
                grade: gradeInfo.grade,
                gradeIcon: gradeInfo.iconName,
                exact: showJudges ? (record.score_exact_count || 0) : 0,
                perfect: showJudges ? (record.score_perfect_count || 0) : 0,
                great: showJudges ? (record.score_great_count || 0) : 0,
                good: showJudges ? (record.score_good_count || 0) : 0,
                bad: showJudges ? (record.score_bad_count || 0) : 0,
                miss: showJudges ? (record.score_miss_count || 0) : 0,
                showJudges,
                notPlayed: false,
                played_at: record.played_at ? fCompute.formatDate(record.played_at) : '',
                pushText,
                pushClass
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
                showJudges: false,
                pushText,
                pushClass
            })
        }
    }

    // 计算星星等级（遍历全部存档成绩，而非仅当前曲目）
    let starLevel = computeStarLevel(save, getInfo)

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
        spinfo: info.spinfo || '',
        isRemoved: Array.isArray(info.tags) && info.tags.includes('removed'),
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
