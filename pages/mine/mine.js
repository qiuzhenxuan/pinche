const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

Page({
  data: {
    me: {},
    loggedIn: false,
    avatarText: '',
    subText: '',
    verifyText: '未认证',
    myTrips: [],
    myJoins: [],
    tripCount: 0,
    joinCount: 0
  },

  onShow() {
    this.reload();
  },

  /**
   * 未登录时不请求「我的发布 / 我报名的」：省两次云调用，也避免它们失败时
   * 把整段 Promise.all 拖 reject，连资料区都刷新不了（退出登录会因此卡在旧头像）。
   * 登录状态下两个列表各自兜底为空，失败只影响对应区块，不阻塞整页刷新。
   */
  reload() {
    const that = this;
    data.getMe()
      .then(function (me) {
        if (!me || !me.loggedIn) return { me: me || {}, myTrips: [], myJoins: [] };
        return Promise.all([
          data.getMyTrips().catch(function (err) {
            console.error('[carpool] 我的发布加载失败', err);
            return [];
          }),
          data.getMyJoins().catch(function (err) {
            console.error('[carpool] 我报名的加载失败', err);
            return [];
          })
        ]).then(function (res) {
          return { me: me, myTrips: res[0] || [], myJoins: res[1] || [] };
        });
      })
      .then(function (r) {
        const me = r.me;
        const loggedIn = !!me.loggedIn;
        const myTrips = r.myTrips;
        const myJoins = r.myJoins;

        let subText = '';
        if (loggedIn) {
          const parts = [];
          if (me.gender) parts.push(data.genderLabel(me.gender));
          parts.push(me.verified ? '已认证' : '未认证');
          subText = parts.join(' · ');
        }

        let verifyText = '未认证';
        if (loggedIn) {
          if (me.verified) verifyText = '已认证';
          else if (me.verifyStatus === 'pending') verifyText = '审核中';
          else if (me.verifyStatus === 'rejected') verifyText = '已驳回';
        }

        that.setData({
          me: me,
          loggedIn: loggedIn,
          avatarText: loggedIn ? String(me.surname).slice(0, 1) : '',
          subText: subText,
          verifyText: verifyText,
          myTrips: myTrips,
          myJoins: myJoins,
          tripCount: myTrips.length,
          joinCount: myJoins.length
        });
      })
      .catch(function (err) {
        console.error('[carpool] 我的页面加载失败', err);
      });
  },

  onOpenDetail(e) {
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id
    });
  },

  onGoPublish() {
    wx.switchTab({ url: '/pages/publish/publish' });
  },

  onGoProfile() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onLogout() {
    const that = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新填写姓氏，才能发布行程和报名拼车。',
      confirmText: '退出',
      confirmColor: '#FF3B30',
      success: function (res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        data.logout()
          .then(function () {
            wx.hideLoading();
            haptic.tap();
            wx.showToast({ title: '已退出', icon: 'success' });
            that.reload();
          })
          .catch(function (err) {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '退出失败', icon: 'none' });
          });
      }
    });
  },

  onGoVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' });
  },

  onGoBlocks() {
    wx.navigateTo({ url: '/pages/blocks/blocks' });
  },

  onGoAgreement() {
    wx.navigateTo({ url: '/pages/legal/legal?type=agreement' });
  },

  onGoPrivacy() {
    wx.navigateTo({ url: '/pages/legal/legal?type=privacy' });
  },

  onTip() {
    wx.showToast({ title: 'Demo 暂未开放', icon: 'none' });
  }
});
