const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

// 弹窗退场动画时长，JS 里等这么久再卸载节点，保证「从哪进就从哪出」
const DIALOG_OUT_MS = 190;

Page({
  data: {
    trip: null,
    me: null,
    loggedIn: false,
    ready: false,
    joins: [],
    pendingCount: 0,
    myJoinId: '',
    myJoinStatus: '',
    genderBlocked: false,
    applying: false,
    reporting: false,
    reportingSubmit: false,
    reportClosing: false,
    reportReasons: ['虚假信息', '广告骚扰', '危险驾驶 / 违规载客', '言语骚扰或辱骂', '其他'],
    reportReason: '',
    reportDetail: '',
    blocking: false,
    blockingSubmit: false,
    blockClosing: false,
    blockRemark: ''
  },

  onLoad(options) {
    this.tripId = options.id;
    this.loadedOnce = false;
    this.checkLogin();
  },

  onShow() {
    if (this.loadedOnce) this.checkLogin();
    this.loadedOnce = true;
  },

  /**
   * 行程详情同样只对已登录用户开放。
   * 未登录时不请求行程数据，只显示登录引导，避免分享出去的链接被直接看到内容。
   */
  checkLogin() {
    const that = this;
    return data.getMe()
      .then(function (me) {
        that.setData({ me: me, loggedIn: !!me.loggedIn });
        if (!me.loggedIn) return null;
        return that.load();
      })
      .catch(function (err) {
        console.error('[carpool] 读取登录状态失败', err);
        that.setData({ loggedIn: false });
        return null;
      })
      .then(function () {
        that.setData({ ready: true });
      });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  load() {
    const that = this;
    return data.getTripById(this.tripId).then(function (trip) {
      if (!trip) {
        wx.showToast({ title: '行程不存在', icon: 'none' });
        setTimeout(function () { wx.navigateBack(); }, 800);
        return;
      }
      const me = that.data.me || {};
      // 限性别的行程，资料性别对不上就不给申请入口，按钮上直接说明原因
      const genderBlocked = trip.genderLimit !== 'any' && trip.genderLimit !== (me.gender || '');
      that.setData({
        trip: trip,
        genderBlocked: genderBlocked,
        myJoinId: (trip.myJoin && trip.myJoin.id) || '',
        myJoinStatus: (trip.myJoin && trip.myJoin.status) || ''
      });
      if (trip.mine) that.loadJoins();
    }).catch(function (err) {
      wx.showToast({ title: (err && err.message) || '行程加载失败', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 800);
    });
  },

  loadJoins() {
    const that = this;
    data.getTripJoins(this.tripId).then(function (list) {
      that.setData({
        joins: list,
        pendingCount: list.filter(function (j) { return j.status === 'pending'; }).length
      });
    });
  },

  /* -------- 申请加入 -------- */

  onApply() {
    const trip = this.data.trip;
    if (!trip || trip.mine || trip.full) return;
    if (trip.expired) {
      wx.showToast({ title: '该行程已结束', icon: 'none' });
      return;
    }
    if (this.data.applying) return;

    const that = this;
    this.setData({ applying: true });

    data.requireProfile()
      .then(function () {
        return data.joinTrip(that.tripId);
      })
      .then(function () {
        that.setData({ applying: false, myJoinStatus: 'pending' });
        haptic.tap();
        wx.showToast({ title: '已提交申请', icon: 'success' });
        that.load();
      })
      .catch(function (err) {
        that.setData({ applying: false });
        if (err && err.needLogin) return;
        wx.showToast({ title: (err && err.message) || '申请失败', icon: 'none' });
      });
  },

  /* -------- 撤回申请 -------- */

  onCancelJoin() {
    const that = this;
    if (!this.data.myJoinId) return;
    wx.showModal({
      title: '撤回申请',
      content: '撤回后这条申请不再出现在发布者的待处理列表里，你可以重新申请。',
      confirmText: '撤回',
      success: function (res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        data.cancelJoin(that.data.myJoinId)
          .then(function () {
            wx.hideLoading();
            wx.showToast({ title: '已撤回', icon: 'success' });
            that.load();
          })
          .catch(function (err) {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '撤回失败', icon: 'none' });
          });
      }
    });
  },

  /* -------- 发布者审批 -------- */

  onApprove(e) {
    this.decide(e.currentTarget.dataset.id, true);
  },

  onReject(e) {
    this.decide(e.currentTarget.dataset.id, false);
  },

  decide(joinId, approve) {
    const that = this;
    wx.showLoading({ title: '处理中', mask: true });
    data.decideJoin(joinId, approve)
      .then(function () {
        wx.hideLoading();
        haptic.tap();
        wx.showToast({ title: approve ? '已同意' : '已拒绝', icon: 'success' });
        that.load();
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /* -------- 举报 / 拉黑 -------- */

  onReport() {
    const trip = this.data.trip;
    if (!trip || trip.mine) return;

    const that = this;

    data.requireProfile()
      .then(function () {
        that.setData({
          reporting: true,
          reportingSubmit: false,
          reportClosing: false,
          reportReason: '',
          reportDetail: ''
        });
      })
      .catch(function () {});
  },

  /**
   * 先播退场动画再卸载节点，让关闭和打开走同一条路径。
   * 回调放在卸载之后，toast 才不会压在正在消失的弹窗上。
   */
  closeReport(done) {
    const that = this;
    if (this.data.reportClosing) return;
    this.setData({ reportClosing: true });
    setTimeout(function () {
      that.setData({ reporting: false, reportClosing: false });
      if (done) done();
    }, DIALOG_OUT_MS);
  },

  closeBlock(done) {
    const that = this;
    if (this.data.blockClosing) return;
    this.setData({ blockClosing: true });
    setTimeout(function () {
      that.setData({ blocking: false, blockClosing: false });
      if (done) done();
    }, DIALOG_OUT_MS);
  },

  onReportReason(e) {
    if (this.data.reportingSubmit) return;
    haptic.tap();
    this.setData({ reportReason: e.currentTarget.dataset.reason });
  },

  onReportDetailInput(e) {
    this.setData({ reportDetail: e.detail.value });
  },

  onReportCancel() {
    if (this.data.reportingSubmit) return;
    this.closeReport();
  },

  onReportConfirm() {
    if (this.data.reportingSubmit) return;

    const reason = this.data.reportReason;
    if (!reason) {
      wx.showToast({ title: '请选择举报原因', icon: 'none' });
      return;
    }

    const that = this;
    const detail = (this.data.reportDetail || '').trim().slice(0, 200);

    this.setData({ reportingSubmit: true });
    data.reportTrip(this.tripId, reason, detail)
      .then(function () {
        that.setData({ reportingSubmit: false });
        haptic.tap();
        that.closeReport(function () {
          wx.showToast({ title: '已收到举报', icon: 'success' });
        });
      })
      .catch(function (err) {
        that.setData({ reportingSubmit: false });
        wx.showToast({ title: (err && err.message) || '举报失败', icon: 'none' });
      });
  },

  onBlock() {
    const trip = this.data.trip;
    if (!trip || trip.mine) return;

    const that = this;

    data.requireProfile()
      .then(function () {
        that.setData({
          blocking: true,
          blockingSubmit: false,
          blockClosing: false,
          blockRemark: ''
        });
      })
      .catch(function () {});
  },

  onBlockRemarkInput(e) {
    this.setData({ blockRemark: e.detail.value });
  },

  onBlockCancel() {
    if (this.data.blockingSubmit) return;
    this.closeBlock();
  },

  onBlockConfirm() {
    if (this.data.blockingSubmit) return;

    const that = this;
    const remark = (this.data.blockRemark || '').trim().slice(0, 20);

    this.setData({ blockingSubmit: true });
    data.blockOwner(this.tripId, remark)
      .then(function () {
        that.setData({ blockingSubmit: false });
        haptic.tap();
        that.closeBlock(function () {
          wx.showToast({ title: '已拉黑', icon: 'success' });
          setTimeout(function () { wx.navigateBack(); }, 600);
        });
      })
      .catch(function (err) {
        that.setData({ blockingSubmit: false });
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  noop() {},

  /* -------- 删除行程 -------- */

  onDelete() {
    const that = this;
    wx.showModal({
      title: '删除行程',
      content: '删除后不可恢复，相关的上车申请也会一并删除。',
      confirmText: '删除',
      confirmColor: '#FF3B30',
      success: function (res) {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中', mask: true });
        data.removeTrip(that.tripId)
          .then(function () {
            wx.hideLoading();
            haptic.tap();
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(function () { wx.navigateBack(); }, 600);
          })
          .catch(function (err) {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      }
    });
  }
});
