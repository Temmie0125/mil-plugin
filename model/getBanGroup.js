/**
 * 简易群功能禁用管理
 * 当前版本默认不禁用任何功能，预留扩展接口
 */
export default class getBanGroup {

    /**
     * @param {any} e - 事件对象，需包含 group_id
     * @param {string} fnc - 功能名称 (如 'ltrgame', 'guessgame', 'tipgame')
     * @returns {Promise<boolean>} 是否被禁用
     */
    static async get(e, fnc) {
        // 当前默认不禁用，后续可扩展为读取本地JSON或Redis
        return false
    }
}
