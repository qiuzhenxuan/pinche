const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

// 索引条最上面一格是定位区，其余是 A-Z
const LOCATE_KEY = '◎';

Page({
  data: {
    statusBarHeight: 20,
    bodyTop: 64,
    current: '',
    located: '',
    locating: true,
    locateOn: true,
    groups: [],
    indexLetters: [],
    total: data.CITIES.length,
    toView: '',
    activeLetter: '',
    tipOn: false
  },

  onLoad() {
    const win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    const statusBarHeight = win.statusBarHeight || 20;
    const current = data.getCity();
    const locateOn = data.AUTO_LOCATE;
    // 定位关掉时当前城市必须留在 A-Z 里，不能再从列表里摘出去，否则它会整个消失
    const groups = data.cityGroups(locateOn ? current : '');
    this.setData({
      statusBarHeight: statusBarHeight,
      bodyTop: statusBarHeight + 44,
      current: current,
      locateOn: locateOn,
      // 定位结果没回来之前先拿当前城市顶上，页面不会出现空档
      located: current,
      groups: groups,
      indexLetters: (locateOn ? [LOCATE_KEY] : []).concat(
        groups.map(function (g) { return g.letter; })
      )
    });
    if (locateOn) this.relocate();
  },

  onReady() {
    const that = this;
    wx.createSelectorQuery()
      .select('.index')
      .boundingClientRect(function (rect) { that._barRect = rect; })
      .exec();
  },

  onUnload() {
    if (this._tipTimer) clearTimeout(this._tipTimer);
  },

  /**
   * 重新定位。定位失败时保留原值（locateCity 内部已兜底为当前城市），
   * 所以这里不会有「定位失败」这种吓人的提示，用户手动选也完全能用。
   */
  relocate() {
    const that = this;
    this.setData({ locating: true });
    data.locateCity()
      .then(function (city) {
        that.setLocated(city || that.data.current);
      })
      .catch(function () {
        that.setData({ locating: false });
      });
  },

  /**
   * 定位到的城市要从 A-Z 里摘掉，所以拿到新城市就得重算分组。
   */
  setLocated(located) {
    this.setData({
      located: located,
      groups: data.cityGroups(located),
      locating: false
    });
  },

  onRelocate() {
    if (this.data.locating) return;
    haptic.tap();
    this.relocate();
  },

  /**
   * 选中即落定：写入缓存、给一次轻震动、直接返回。
   * 不做「选中态 + 确认按钮」这种多余的一步，选城市是低风险操作；
   * 定位中也不拦输入——那一格显示的就是个真实城市，选它不会出错。
   */
  onPick(e) {
    const city = e.currentTarget.dataset.city;
    if (!city) return;
    data.setCity(city);
    haptic.tap();
    wx.navigateBack();
  },

  onBack() {
    wx.navigateBack();
  },

  /**
   * 右侧字母索引：按下、拖动都实时跟手跳转。
   * 每跨过一格才震动并刷新，避免同一格内连续触发。
   */
  onIndexTouch(e) {
    const bar = this._barRect;
    const letters = this.data.indexLetters;
    if (!bar || !bar.height || !letters.length) return;

    const y = e.touches[0].clientY - bar.top;
    let idx = Math.floor((y / bar.height) * letters.length);
    if (idx < 0) idx = 0;
    if (idx > letters.length - 1) idx = letters.length - 1;
    if (idx === this._idx) return;

    this._idx = idx;
    const letter = letters[idx];
    haptic.tap();
    this.setData({
      activeLetter: letter,
      tipOn: true,
      toView: idx === 0 ? 'sec-locate' : 'sec-' + letter
    });

    if (this._tipTimer) clearTimeout(this._tipTimer);
    const that = this;
    this._tipTimer = setTimeout(function () { that.setData({ tipOn: false }); }, 600);
  }
});
