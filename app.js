const config = require('./config.js');

App({
  onLaunch() {
    if (!wx.cloud) {
      console.warn('[carpool] 基础库版本过低，无法使用云开发能力，将使用本地演示数据');
      return;
    }
    if (!config.cloudEnv) {
      console.info('[carpool] 未配置云环境 ID，当前使用本地演示数据。配置方式见 config.js');
      return;
    }
    wx.cloud.init({
      env: config.cloudEnv,
      traceUser: true
    });
    console.info('[carpool] 云开发已初始化，环境：' + config.cloudEnv);
  },

  globalData: {}
});
