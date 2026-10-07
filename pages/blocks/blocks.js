const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

Page({
  data: {
    blocks: [],
    loaded: false
  },

  onShow() {
    this.load();
  },

  load() {
    const that = this;
    data.getMyBlocks()
      .then(function (list) {
        that.setData({ blocks: list || [], loaded: true });
      })
      .catch(function (err) {
        console.error('[carpool] 黑名单加载失败', err);
        that.setData({ loaded: true });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onUnblock(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该用户';
    const that = this;

    wx.showModal({
      title: '解除拉黑',
      content: '解除后你们可以重新看到对方的行程。',
      confirmText: '解除',
      success: function (res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        data.unblockUser(id)
          .then(function () {
            wx.hideLoading();
            haptic.tap();
            wx.showToast({ title: '已解除', icon: 'success' });
            that.load();
          })
          .catch(function (err) {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      }
    });
  }
});
