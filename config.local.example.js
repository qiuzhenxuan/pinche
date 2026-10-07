/**
 * 本地私有配置模板
 *
 * 用法：把本文件复制一份，重命名为同目录下的 config.local.js，填入自己的云环境 ID。
 * config.local.js 已写进 .gitignore，不会被提交——云环境 ID 属于账号标识，
 * 放进公开仓库等于把自己的云资源挂出去。
 *
 * 不创建 config.local.js 也能跑：config.cloudEnv 会是空串，
 * 小程序自动退回「本地演示模式」，数据只存在本机。
 *
 * 云环境 ID 查看位置：微信开发者工具 → 云开发控制台 → 设置 → 环境 ID，形如 cloud1-xxxxxxxx。
 */
module.exports = {
  cloudEnv: ''
};
