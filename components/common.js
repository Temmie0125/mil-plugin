import fs from 'node:fs';
import path from 'node:path';
/**
 *
 * 制作转发消息
 * @param e
 * @param msg 消息体
 * @param dec 描述
 * @returns {Promise<boolean|*>}
 */
export async function makeForwardMsg(e, msg = [], dec = '') {
    const bot = e.bot || Bot
    let nickname = bot.nickname
    if (e.isGroup && bot.getGroupMemberInfo) try {
        const info = await bot.getGroupMemberInfo(e.group_id, bot.uin)
        nickname = info.card || info.nickname
    } catch { }
    let userInfo = {
        user_id: bot.uin,
        nickname,
    }
    let forwardMsg = []
    msg.forEach(v => {
        forwardMsg.push({
            ...userInfo,
            message: v,
        })
    })
    /** 制作转发内容 */
    if (e.group?.makeForwardMsg) {
        forwardMsg = await e.group.makeForwardMsg(forwardMsg)
    } else if (e.friend?.makeForwardMsg) {
        forwardMsg = await e.friend.makeForwardMsg(forwardMsg)
    } else {
        forwardMsg = await Bot.makeForwardMsg(forwardMsg)
    }
    if (dec) {
        /** 处理描述 */
        if (typeof (forwardMsg.data) === 'object') {
            let detail = forwardMsg.data?.meta?.detail
            if (detail) {
                detail.news = [{ text: dec }]
            }
        } else {
            forwardMsg.data = forwardMsg.data
                .replace(/\n/g, '')
                .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
                .replace(/___+/, `<title color="#777777" size="26">${dec}</title>`)
        }
    }
    return forwardMsg
}
/**
 * 权限检查（群管理员或主人）
 * @param {*} e 
 * @returns Boolean
 */
export function checkPermission(e) {
    if (e.isMaster) return true
    if (!e.isGroup) return false  // 非群聊只允许主人使用
    const member = e.group.pickMember(e.user_id)
    if (e.isGroup && e.member?.role && ['owner', 'admin'].includes(e.member.role)) return true
    if (e.isGroup && (member.is_admin || member.is_owner)) return true
    return false
}
/**
 * 检查是否是好友
 * @param {*} userId 用户QQ号
 * @returns Boolean
 */
export function checkFriend(userId) {
    if (!Bot.fl || !Bot.fl.has(Number(userId))) return false
    return true
}
/**
 * 从事件对象中提取文件信息（兼容私聊和群聊）
 * @param {object} e 事件对象
 * @returns {{ fileName: string, fileSize: number, fileId: string, busid?: number } | null}
 */
export function getFileInfo(e) {
    if (!e.file) return null;
    let fileName = '';
    let fileSize = 0;
    let fileId = '';
    let busid = null;
    // 私聊文件结构：e.file.data
    if (e.file.data) {
        fileName = e.file.data.file || e.file.data.filename || '';
        fileSize = parseInt(e.file.data.file_size || e.file.data.size || 0, 10);
        fileId = e.file.data.file_id || e.file.data.id || '';
        busid = e.file.data.busid;
    }
    // 群聊文件结构：e.file 直接包含 id, name, size, busid
    if (!fileName && e.file.name) {
        fileName = e.file.name;
        fileSize = parseInt(e.file.size || 0, 10);
        fileId = e.file.id || '';
        busid = e.file.busid;
    }
    // 兜底
    if (!fileName) {
        fileName = e.file.file || e.file.filename || '';
    }
    if (!fileSize) {
        fileSize = parseInt(e.file.file_size || e.file.size || 0, 10);
    }
    if (!fileId) {
        fileId = e.file.file_id || e.file.id || '';
    }
    if (!fileName || !fileSize || !fileId) {
        logger.warn("[mil-plugin] 无法提取完整的文件信息", { eFile: e.file });
        return null;
    }
    return { fileName, fileSize, fileId, busid };
}
/**
   * 辅助方法：从消息中获取文件文本内容（适配 TRSS 框架）
   * @returns {Promise<string|null>}
   */
export async function getFileContent(e, fileId, busid = null) {
    try {
        // ========== 1. 私聊：优先用 get_private_file_url 获取 http 地址 ==========
        if (!e.isGroup) {
            try {
                const userId = e.user_id;
                let fileUrl;
                const user = Bot.pickFriend(userId);
                if (typeof user.getFileUrl === 'function') {
                    fileUrl = await user.getFileUrl(fileId);
                } else {
                    const res = await Bot.sendApi('get_private_file_url', { user_id: userId, file_id: fileId });
                    fileUrl = res?.data?.url;
                }
                if (fileUrl && (fileUrl.startsWith('http://') || fileUrl.startsWith('https://'))) {
                    const response = await fetch(fileUrl);
                    if (response.ok) {
                        logger.mark(`[mil-plugin] 私聊文件HTTP下载成功`)
                        return Buffer.from(await response.arrayBuffer());
                    }
                    logger.warn(`[mil-plugin] 私聊文件下载失败，状态码: ${response.status}`);
                }
            } catch (apiErr) {
                logger.warn(`[mil-plugin] 调用 get_private_file_url 失败，回退通用方式: ${apiErr}`);
            }
        }
        // ========== 2. 群聊：尝试 get_group_file_url ==========
        if (e.isGroup) {
            let groupUrlInfo = null;
            const group = Bot.pickGroup(e.group_id);
            if (typeof group.fs.download === 'function') {
                groupUrlInfo = await group.fs.download(fileId, busid);
            } else {
                try {
                    groupUrlInfo = await Bot.sendApi('get_group_file_url', {
                        group_id: e.group_id,
                        file_id: fileId,
                        busid: busid
                    });
                } catch (apiErr) {
                    logger.warn(`[mil-plugin] 调用 get_group_file_url 失败: ${apiErr}`);
                }
            }
            if (groupUrlInfo?.data?.url) {
                const url = groupUrlInfo.data.url;
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    const response = await fetch(url);
                    if (response.ok) {
                        logger.mark(`[mil-plugin] 群文件HTTP下载成功`)
                        return Buffer.from(await response.arrayBuffer());
                    }
                    logger.warn(`[mil-plugin] 群文件HTTP下载失败，状态码: ${response.status}`);
                }
                if (url.startsWith('file://')) {
                    let filePath = url.replace('file://', '');
                    try { filePath = decodeURIComponent(filePath); } catch { }
                    if (fs.existsSync(filePath)) {
                        const content = fs.readFileSync(filePath);
                        logger.mark(`[mil-plugin] 群文件本地读取成功: ${filePath}`);
                        setTimeout(() => fs.promises.unlink(filePath).catch(() => { }), 2000);
                        return content;
                    }
                    logger.warn("[mil-plugin] file:// 路径不存在 (可能是容器隔离)，尝试其他方式...");
                }
            }
        }
        // ========== 3. 通用方式：base64 ==========
        let fileInfo = null;
        try {
            if (!e.isGroup) {
                fileInfo = await Bot.sendApi('get_file', { file_id: fileId });
            } else {
                if (groupUrlInfo?.data) {
                    fileInfo = groupUrlInfo;
                }
            }
        } catch (err) {
            logger.error("[mil-plugin] 获取 fileInfo 异常:", err);
        }

        if (fileInfo?.data) {
            const data = fileInfo.data;
            if (data.file && typeof data.file === 'string' && data.file.startsWith('base64://')) {
                const base64 = data.file.replace('base64://', '');
                return Buffer.from(base64, 'base64');
            }
            if (data.url && (data.url.startsWith('http://') || data.url.startsWith('https://'))) {
                const response = await fetch(data.url);
                if (response.ok) return Buffer.from(await response.arrayBuffer());
            }
            const localPath = data.file || data.path;
            if (localPath && typeof localPath === 'string' && fs.existsSync(localPath)) {
                const content = fs.readFileSync(localPath);
                logger.mark(`[mil-plugin] 本地读取成功: ${localPath}`);
                setTimeout(() => fs.promises.unlink(localPath).catch(() => { }), 2000);
                return content;
            }
        }
        logger.error("[mil-plugin] 无法获取文件内容（已尝试所有方式）");
        return null;
    } catch (err) {
        logger.error(`[mil-plugin] 获取文件内容失败: ${err}`);
        return null;
    }
}
/**
 * 获取群成员列表
 * @param {*} groupId 群号
 * @returns {List} 群成员列表
 */
export async function getGroupMembers(groupId) {
    try {
        const group = await Bot.pickGroup(groupId)
        const memberList = await group.getMemberMap()
        return Array.from(memberList.values())
    } catch (error) {
        logger.error(`获取群成员失败: ${error}`)
        return []
    }
}
/**
 * 获取用户头像URL
 */
export async function getAvatarUrl(userId) {
    // QQ头像地址
    return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`
}
