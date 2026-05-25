# Mil-Plugin

<p align="center">
  <img alt="Yunzai Version" src="https://img.shields.io/badge/Yunzai--V3-Plugin-blue?style=flat-square"/>
  <img alt="GitHub issues" src="https://img.shields.io/github/issues/Temmie0125/mil-plugin?style=flat-square"/>
  <img alt="GitHub license" src="https://img.shields.io/github/license/Temmie0125/mil-plugin?style=flat-square"/>
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/Temmie0125/mil-plugin?style=social"/>
  <img alt="插件版本" src="https://img.shields.io/badge/插件版本-1.0.0-9cf?style=flat-square"/>
  <img alt="Milthm" src="https://img.shields.io/badge/Milthm-5.3.2-9cf?style=flat-square"/>
</p>

### 介绍

`mil-plugin` 为查询Milthm信息的插件，包括b20、score、song等Milthm相关功能，有相关的建议和问题可以在[Issues](../../issues)中提出，欢迎[PR](../../pulls)。

具体功能可在安装插件后 通过 `/mil help` 查看详细指令

---

### 安装

> 使用Github

```
#安装插件本体
git clone --depth=1 https://github.com/Temmie0125/mil-plugin.git ./plugins/mil-plugin/ 
#进入插件目录
cd ./plugins/mil-plugin/ 
#安装插件所需依赖
pnpm install
```

> [!WARNING]
> 请使用主人权限执行该指令以下载曲绘，否则相关曲绘将无法正常展示！（可以是标准输入或者其他平台）
> 
>```
> /mil downill
>```

> [!TIP]
> 如果安装依赖时速度过慢，运行：
> 
>```
> pnpm config set registry https://registry.npmmirror.com
>```

---

#### Todo

* [ ] 优化界面设计

* [ ] 定数表

* [ ] 接入云存档系统

* [ ] 指令修改部分设置

* [ ] 谱面标签

* [ ] 猜曲绘、开字母等娱乐功能

### 功能

以下#均可用/代替，命令头可自定义

| **功能名称** | **功能说明**
| :- | :-
| `#mil help` | 查看帮助
| `直接发送存档文件` | 导入存档
| `#mil b20` | 查询b20
| `#mil song <曲名或别名>` | 查询曲目图鉴
| `#mil alias <曲目>` | 查看现有别名
| `#mil score <曲目>` | 查看单曲成绩
| `#mil delete` | 删除bot端存档数据

#### **以下为管理功能**

| 功能名称 | 功能说明
| :- | :-
| `#mil (强制\|qz)?(更新\|gx)` | 更新插件
| `#mil downill` | 下载或更新曲绘

### 免责声明

1. 功能仅限内部交流与小范围使用，请勿将`Yunzai-Bot`及`mil-plugin`用于任何以盈利为目的的场景.
2. 图片与其他素材均来自于网络，仅供交流学习使用，如有侵权请联系，会立即删除.
3. 存档解析功能由[mkzi-nya/milthm-calculator-web](https://github.com/mkzi-nya/milthm-calculator-web)改写而来

### 友情链接

- [milthm-calculator-web](https://github.com/mkzi-nya/milthm-calculator-web)
- [phi-plugin](https://github.com/catrong/phi-plugin)
- [别名提案申请表](https://www.kdocs.cn/wo/sl/v12VZ1RD)
