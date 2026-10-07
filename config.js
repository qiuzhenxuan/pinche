/**
 * 全局配置
 *
 * cloudEnv 是云环境 ID，决定小程序走云端还是本地演示模式：
 *   - 有值：走云开发，行程、报名、拉黑等数据存在云端，多个用户之间互通。
 *   - 空值：退回「本地演示模式」，数据全部存在本机 Storage，
 *           换一台手机、换一个微信号都看不到彼此发布的内容。
 *
 * 真实的环境 ID 不进仓库，写在同目录的 config.local.js 里（已 gitignore）。
 * 复制 config.local.example.js 为 config.local.js 并填入即可。
 * 没有该文件时 cloudEnv 为空串，小程序自动降级为本地演示模式，不影响启动。
 *
 * 换环境或首次部署时要做的事：
 *   1. 在 config.local.js 填好环境 ID。
 *   2. 右键 cloudfunctions/trips → 「上传并部署：云端安装依赖」。
 *      （trips、users、joins 等集合由云函数首次调用时自动创建，不用手动建表。）
 *   3. 重新编译小程序。
 *
 * 注意：本地模式下存下来的数据不会自动迁移到云端，是两套独立的存储。
 *
 * 逆地址解析（经纬度 → 城市）在云函数 trips 里做，客户端只调 action=locateCity。
 * 这样做的好处：小程序端不用把 apis.map.qq.com 加进 request 合法域名，
 * 腾讯位置服务的 key 也不下发到客户端，只留在云函数环境变量里。
 *
 * 设置 key 的方法（key 在 https://lbs.qq.com/dev/console/key/manage 免费申请，
 * 新建时勾选「WebServiceAPI」；IP 白名单留空、签名校验关闭，否则小程序调用会失败）：
 *   微信开发者工具 → 云开发 → 云函数 → trips → 配置 → 环境变量 → 新增
 *   变量名 MAP_KEY，值填你的 key → 保存（保存后云函数会自动重启）。
 * 没配 MAP_KEY 时自动定位会降级为「手动选城市」，其余功能不受影响。
 *
 * defaultCity 是定位失败或解析不出城市时的兜底城市。
 */

// 本地私有配置。没有这个文件时退回空对象，cloudEnv 留空 = 本地演示模式。
let local = {};
try {
  local = require('./config.local.js') || {};
} catch (e) {
  local = {};
}

module.exports = {
  // 云环境 ID 只从本地私有配置读，仓库里不存真实值
  cloudEnv: local.cloudEnv || '',
  cloudFunction: 'trips',
  pageSize: 20,
  defaultCity: '福州',

  /**
   * 自动定位开关，现在是开的。
   *
   * wx.getFuzzyLocation 已在小程序后台开通，进小程序会自动定位到所在城市。
   * 关掉它的效果：不再请求定位，「选择城市」页隐藏定位区，城市完全靠手动选择。
   * 注意关闭时必须连 utils/data.js 里的接口调用一起摘掉——源码里只要留着该调用，
   * 上传 / 提审就会被隐私接口检测拦下（错误码 61040），只改这个开关没用。
   *
   * 地图选点（wx.chooseLocation）后台申请不下来，所以 pages/publish 的出发地 /
   * 目的地仍然是「手打 + 常用站点一点即填」。以后它也能开通了，把 app.json 的
   * requiredPrivateInfos 补上 "chooseLocation"、permission 里补 scope.userLocation，
   * 再把发布页换回地图选点即可。
   */
  autoLocate: true
};
