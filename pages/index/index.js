const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

const PAGE_SIZE = data.PAGE_SIZE;

// 首页是高频往返页（进详情再返回、切 tab 回来都会触发 onShow）。
// 登录态和城市行程数没必要每次重问云端，给个短 TTL；
// 写操作会在 data.js 里主动失效，所以这两个值只决定「别人改动后多久能看到」。
const ME_TTL = 30 * 1000;
const COUNTS_TTL = 60 * 1000;

Page({
  data: {
    statusBarHeight: 20,
    bodyTop: 84,
    lines: data.LINES,
    activeLine: 'all',
    city: data.DEFAULT_CITY,
    cityDot: '',
    linesOn: false,
    loggedIn: false,
    trips: [],
    skip: 0,
    hasMore: false,
    loading: false,
    dataTip: ''
  },

  onLoad() {
    const win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    const statusBarHeight = win.statusBarHeight || 20;
    this.setData(Object.assign({
      statusBarHeight: statusBarHeight,
      bodyTop: statusBarHeight + 64,
      dataTip: data.isCloudMode() ? '数据来自云端' : '本地演示数据：换台手机就看不到彼此发布的行程'
    }, this.applyCity(data.getCity())));
    this.autoLocate();
  },

  /**
   * 切城市时要一起处理的事：城市本身、线路筛选是否可用、筛选条件是否复位。
   * 线路筛选的站点都是福州校区周边的，换到别的城市就没有对应线路，
   * 所以非福州一律收起筛选，并把条件复位成「全部」——
   * 否则会带着福州的线路条件去查别的城市，查出一片空。
   */
  applyCity(city) {
    const on = city === data.LINES_CITY;
    return {
      city: city,
      linesOn: on,
      activeLine: on ? this.data.activeLine : 'all'
    };
  },

  /**
   * 进入小程序先用缓存城市渲染，定位成功后若落在别的城市再切过去。
   * 未授权、云函数没配 MAP_KEY 时 locateCity 会返回当前城市，等于什么都没发生，
   * 用户仍可在城市页手动切。
   */
  autoLocate() {
    const that = this;
    data.locateCity()
      .then(function (city) {
        if (!city || city === that.data.city) return;
        haptic.tap();
        that.setData(Object.assign({ cityDot: '' }, that.applyCity(city)));
        that.reload();
        that.refreshCityDot();
      })
      .catch(function () {});
  },

  onOpenCity() {
    wx.navigateTo({ url: '/pages/city/city' });
  },

  /**
   * 从城市页返回时城市已经变了，这里重新读一次并刷新列表；
   * 其余情况（比如从详情页返回）只确认登录态，走 checkLogin 的既有链路。
   */
  onShow() {
    const city = data.getCity();
    if (city !== this.data.city) {
      this.setData(
        Object.assign({ trips: [], skip: 0, hasMore: false, cityDot: '' }, this.applyCity(city)),
        this.checkLogin.bind(this)
      );
      return;
    }
    this.checkLogin();
  },

  onPullDownRefresh() {
    // 下拉刷新是「我就要最新的」信号，缓存一律作废再取
    data.bustCaches();
    this.checkLogin(function () {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (!this.data.loggedIn || !this.data.hasMore || this.data.loading) return;
    this.loadMore();
  },

  /**
   * 拼车信息只对已登录用户开放。未登录时不请求列表，直接显示登录引导；
   * 登录 / 退出都会经过 onShow 回到这里，状态自然回流。
   */
  checkLogin(done) {
    const that = this;
    data.getMe({ ttl: ME_TTL })
      .then(function (me) {
        const loggedIn = !!me.loggedIn;
        that.setData({ loggedIn: loggedIn });
        if (!loggedIn) {
          that.setData({ trips: [], skip: 0, hasMore: false, loading: false, cityDot: '' });
          return;
        }
        that.refreshCityDot();
        return that.reload();
      })
      .catch(function (err) {
        console.error('[carpool] 读取登录状态失败', err);
        that.setData({ loggedIn: false, trips: [], skip: 0, hasMore: false, loading: false, cityDot: '' });
      })
      .then(function () {
        if (done) done();
      });
  },

  /**
   * 首页城市胶囊左侧那个点的颜色：当前城市有可拼行程就绿，没有就红。
   * 口径与列表页一致（未发车、还有座位、排除已拉黑的人），所以点绿了点进去一定有内容。
   * 取不到时不动颜色，宁可维持原样也不误报成「没车」。
   */
  refreshCityDot() {
    const that = this;
    const city = this.data.city;
    data.getCityCounts({ ttl: COUNTS_TTL })
      .then(function (counts) {
        if (that.data.city !== city) return;
        that.setData({ cityDot: (counts[city] || 0) > 0 ? 'city-dot-on' : 'city-dot-off' });
      })
      .catch(function (err) {
        console.error('[carpool] 城市行程数读取失败', err);
      });
  },

  reload(done) {
    if (!this.data.loggedIn) {
      if (done) done();
      return;
    }
    const that = this;
    this.setData({ loading: true });
    data.getTrips({ city: this.data.city, corridor: this.data.activeLine, skip: 0, limit: PAGE_SIZE })
      .then(function (list) {
        that.setData({
          trips: list,
          skip: list.length,
          hasMore: list.length === PAGE_SIZE,
          loading: false
        });
      })
      .catch(function () {
        that.setData({ trips: [], skip: 0, hasMore: false, loading: false });
      })
      .then(function () {
        if (done) done();
      });
  },

  loadMore() {
    const that = this;
    this.setData({ loading: true });
    data.getTrips({ city: this.data.city, corridor: this.data.activeLine, skip: this.data.skip, limit: PAGE_SIZE })
      .then(function (list) {
        that.setData({
          trips: that.data.trips.concat(list),
          skip: that.data.skip + list.length,
          hasMore: list.length === PAGE_SIZE,
          loading: false
        });
      })
      .catch(function () {
        that.setData({ loading: false });
      });
  },

  onSelectLine(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeLine) return;
    haptic.tap();
    this.setData({ activeLine: key }, this.reload.bind(this));
  },

  onOpenDetail(e) {
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id
    });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  }
});
