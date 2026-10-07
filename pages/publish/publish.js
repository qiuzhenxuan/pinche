const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

// 与发布页 picker 的选项顺序一一对应
const GENDER_LIMITS = ['any', 'male', 'female'];

function fmtDate(d) {
  const m = String(d.getMonth() + 1).length < 2 ? '0' + (d.getMonth() + 1) : String(d.getMonth() + 1);
  const day = String(d.getDate()).length < 2 ? '0' + d.getDate() : String(d.getDate());
  return d.getFullYear() + '-' + m + '-' + day;
}

function todayStr() {
  return fmtDate(new Date());
}

// 出发日期上限：今天起 100 年。picker 的 end 会挡住正常操作，
// 这里再兜一道，防止异常输入把行程发到离谱的年份。
function maxDateStr() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 100);
  return fmtDate(d);
}

Page({
  data: {
    from: '',
    to: '',
    hotPlaces: data.HOT_PLACES,
    minDate: '',
    maxDate: '',
    date: '',
    time: '08:00',
    seatOptions: ['1 座', '2 座', '3 座', '4 座'],
    seatIndex: 1,
    genderLimitOptions: ['不限', '仅限男生', '仅限女生'],
    genderLimitIndex: 0,
    totalPrice: '',
    perText: '面议',
    note: '',
    city: data.DEFAULT_CITY,
    showHot: true,
    submitting: false,
    needProfile: false
  },

  onLoad() {
    const today = todayStr();
    this.setData({ minDate: today, maxDate: maxDateStr(), date: today });
    this.syncCity();
    this.prefillFrom();
  },

  onShow() {
    const that = this;
    // 城市可能刚在首页被定位/切换过，发布时跟着走
    this.syncCity();
    this.prefillFrom();
    data.getMe()
      .then(function (me) {
        that.setData({ needProfile: !me.loggedIn });
      })
      .catch(function () {
        that.setData({ needProfile: true });
      });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /**
   * 常用站点（HOT_PLACES）全是福州校区周边的，换到别的城市就没有参考价值，
   * 索性收起胶囊、改提示手填。showHot 同时控制胶囊显隐和那句提示。
   */
  syncCity() {
    const city = data.getCity();
    this.setData({ city: city, showHot: city === data.LINES_CITY });
  },

  /**
   * 出发地预填：人在学校所在区县（福州永泰）时填学校门口，省得每次手打。
   * 只填空字段——用户自己填过的一律不动，手填优先于猜测。
   * 定位没结果、人在外地都返回空串：宁可让用户自己填，也不瞎填一个假地点。
   */
  prefillFrom() {
    if (this.data.from) return;
    const place = data.schoolPlaceIfNearby();
    if (place) this.setData({ from: place });
  },

  /**
   * 人均 = 总价 ÷ 可带人数（车主不参与分摊），实时预览。
   */
  refreshPer(totalPrice, seatIndex) {
    const total = Number(totalPrice) || 0;
    const seats = Number(seatIndex) + 1;
    const per = data.perPersonOf(total, seats);
    this.setData({ perText: per > 0 ? '¥' + data.money(per) : '面议' });
  },

  /**
   * 出发地 / 目的地：手打 + 常用站点一点即填。
   * 地图选点（wx.chooseLocation）属于需后台准入开通的隐私接口，当前没开通，
   * 源码里保留该调用会让上传 / 提审被隐私接口检测拦下，所以整条地图链路已摘掉。
   * 回写的是用户刚输入的同一个值，不会打断中文输入法组词。
   */
  onPlaceInput(e) {
    const patch = {};
    patch[e.currentTarget.dataset.field] = e.detail.value;
    this.setData(patch);
  },

  onPickPlace(e) {
    const ds = e.currentTarget.dataset;
    haptic.tap();
    const patch = {};
    patch[ds.field] = ds.name;
    this.setData(patch);
  },

  onDateChange(e) {
    const picked = e.detail.value;
    if (picked < todayStr()) {
      wx.showToast({ title: '不能选择过去的日期', icon: 'none' });
      this.setData({ date: todayStr() });
      return;
    }
    if (picked > maxDateStr()) {
      wx.showToast({ title: '出发日期不能超过 100 年', icon: 'none' });
      this.setData({ date: maxDateStr() });
      return;
    }
    this.setData({ date: picked });
  },

  onTimeChange(e) {
    const picked = e.detail.value;
    if (this.data.date === todayStr() && data.isExpired(this.data.date, picked)) {
      wx.showToast({ title: '该时间已过，请选择稍后的时间', icon: 'none' });
      return;
    }
    this.setData({ time: picked });
  },

  onSeatChange(e) {
    const seatIndex = Number(e.detail.value);
    this.setData({ seatIndex: seatIndex });
    this.refreshPer(this.data.totalPrice, seatIndex);
  },

  onGenderLimitChange(e) {
    this.setData({ genderLimitIndex: Number(e.detail.value) });
  },

  onPriceInput(e) {
    const value = e.detail.value;
    this.setData({ totalPrice: value });
    this.refreshPer(value, this.data.seatIndex);
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onSubmit() {
    const d = this.data;
    if (d.submitting) return;

    if (!d.from || !d.to) {
      wx.showToast({ title: '请填写出发地和目的地', icon: 'none' });
      return;
    }

    if (d.from === d.to) {
      wx.showToast({ title: '出发地和目的地不能相同', icon: 'none' });
      return;
    }

    if (!d.date || d.date < todayStr()) {
      wx.showToast({ title: '出发日期不能早于今天', icon: 'none' });
      return;
    }

    if (data.isExpired(d.date, d.time)) {
      wx.showToast({ title: '出发时间已过，请重新选择', icon: 'none' });
      return;
    }

    const that = this;
    this.setData({ submitting: true });

    data.requireProfile()
      .then(function (me) {
        const genderLimit = GENDER_LIMITS[d.genderLimitIndex] || 'any';
        // 限性别的车，车主自己得先符合这个性别，否则规则自相矛盾（比如男生发「仅限女生」）
        if (genderLimit !== 'any' && me.gender !== genderLimit) {
          throw new Error(
            genderLimit === 'male'
              ? '「仅限男生」需要你的资料性别为男，请先到个人资料确认'
              : '「仅限女生」需要你的资料性别为女，请先到个人资料确认'
          );
        }
        const from = d.from;
        const to = d.to;
        return data.addTrip({
          from: from,
          to: to,
          city: d.city,
          corridor: data.resolveCorridor(from, to),
          date: d.date,
          time: d.time,
          seats: d.seatIndex + 1,
          totalPrice: Number(d.totalPrice) || 0,
          note: d.note.trim(),
          ownerGender: me.gender || '',
          genderLimit: genderLimit
        });
      })
      .then(function (res) {
        if (!res) return;
        haptic.tap();
        wx.showToast({ title: '已发布', icon: 'success' });
        that.setData({ note: '', totalPrice: '', perText: '面议', submitting: false });
        setTimeout(function () {
          wx.switchTab({ url: '/pages/index/index' });
        }, 800);
      })
      .catch(function (err) {
        that.setData({ submitting: false });
        if (err && err.needLogin) return;
        console.error('[carpool] 发布失败', err);
        wx.showToast({ title: (err && err.message) || '发布失败，请重试', icon: 'none' });
      });
  }
});
