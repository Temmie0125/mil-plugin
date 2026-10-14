/**
 * 无 JS 渲染器的静态样式计算
 * shotium 等渲染器不执行模板脚本，原本由浏览器 JS 完成的布局计算改在服务端完成
 */
import fs from 'node:fs'

/**
 * 读取 PNG/JPEG 图片尺寸，解析失败返回 null
 * @param {string} file 图片路径
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(file) {
    try {
        const buf = fs.readFileSync(file)
        if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
        }
        if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
            let offset = 2
            while (offset + 9 < buf.length) {
                if (buf[offset] !== 0xff) { offset++; continue }
                const marker = buf[offset + 1]
                // SOF0~SOF3、SOF5~SOF7、SOF9~SOF11、SOF13~SOF15 段含尺寸
                if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
                }
                offset += 2 + buf.readUInt16BE(offset + 2)
            }
        }
    } catch { }
    return null
}

/** 尺寸未知时的保守兜底样式，避免水印塌陷成一团 */
function fallbackStyles() {
    return {
        watermarkStyle: 'height:40px;padding:8px 12px;bottom:8px;left:8px;border-radius:8px;',
        sepStyle: 'font-size:30px;',
        illustratorStyle: 'font-size:16px;line-height:1.25;gap:0.1em;',
        nameStyle: 'max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        labelStyle: 'max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    }
}

/**
 * 按 ill.art 内嵌脚本的同一公式，为曲绘水印生成内联样式
 * @param {string} illustration 曲绘文件路径
 * @returns {{ watermarkStyle: string, sepStyle: string, illustratorStyle: string, nameStyle: string, labelStyle: string }}
 */
export function buildIllWatermarkStyle(illustration) {
    const size = illustration ? readImageSize(illustration) : null
    if (!size || !(size.width > 0) || !(size.height > 0)) return fallbackStyles()
    const { width: imgWidth, height: imgHeight } = size

    const baseWatermarkHeight = Math.max(imgHeight * 0.065, 18)
    const brandFontSizeRaw = baseWatermarkHeight * 0.75
    const rightFontSizeRaw = brandFontSizeRaw * 0.52
    const estimatedRightBlockHeight = (rightFontSizeRaw * 1.25) * 2
    const padYEst = brandFontSizeRaw * 0.25
    const requiredInnerHeight = estimatedRightBlockHeight + padYEst * 2

    let finalWatermarkHeight = baseWatermarkHeight
    if (requiredInnerHeight > baseWatermarkHeight) {
        const extraHeight = Math.min(requiredInnerHeight - baseWatermarkHeight, baseWatermarkHeight * 0.35)
        finalWatermarkHeight = baseWatermarkHeight + extraHeight
        const maxAllowed = imgHeight * 0.12
        if (finalWatermarkHeight > maxAllowed) finalWatermarkHeight = maxAllowed
        if (finalWatermarkHeight < requiredInnerHeight) finalWatermarkHeight = requiredInnerHeight
    }

    const wmHeight = Math.ceil(finalWatermarkHeight)
    const brandFontSize = Math.max(wmHeight * 0.75, 12)
    const rightContainerFontSize = Math.max(brandFontSize * 0.52, 9)
    const padX = Math.max(brandFontSize * 0.7, 6)
    const padY = Math.max(brandFontSize * 0.25, 3)
    const margin = Math.max(imgHeight * 0.015, 4)
    const borderRadius = Math.max(brandFontSize * 0.25, 4)

    return {
        watermarkStyle: `height:${wmHeight}px;padding:${padY}px ${padX}px;bottom:${margin}px;left:${margin}px;border-radius:${borderRadius}px;`,
        sepStyle: `font-size:${brandFontSize}px;`,
        illustratorStyle: `font-size:${rightContainerFontSize}px;line-height:1.25;gap:0.1em;`,
        nameStyle: `max-width:${Math.max(imgWidth * 0.2, 100)}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
        labelStyle: `max-width:${Math.max(imgWidth * 0.18, 80)}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
    }
}
