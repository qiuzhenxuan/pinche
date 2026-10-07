const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

function btnLabel(isEdit, saving) {
  if (saving) return isEdit ? '保存中…' : '登录中…';
  return isEdit ? '保存' : '登录';
}

const PREVIEW_PLACEHOLDER = '某某同学';

// 汉字基本区 + 扩展 A 区，覆盖常见与生僻姓氏
const CHINESE_ONLY = /[\u3400-\u4DBF\u4E00-\u9FFF]/g;

/**
 * 姓只允许中文，最多 2 个字（欧阳、司马这类复姓）。
 *
 * 注意：不能在 bindinput 里实时过滤。中文输入法组词过程中 bindinput 拿到的
 * 是拼音字母（如 "lin"），实时清洗会把字母删掉，输入法直接没法用。
 * 所以输入时只预览、不失焦不回写，真正清洗放在失焦和提交两处。
 */
function cleanSurname(raw) {
  const hits = String(raw || '').match(CHINESE_ONLY);
  return hits ? hits.join('').slice(0, 2) : '';
}

function previewOf(name) {
  return name ? data.displayNameOf(name) : PREVIEW_PLACEHOLDER;
}

Page({
  data: {
    avatarUrl: '',
    surname: '',
    nameText: '',
    preview: PREVIEW_PLACEHOLDER,
    hasSurname: false,
    gender: '',
    genderText: '',
    genderLocked: false,
    isEdit: false,
    saving: false,
    btnText: '登录'
  },

  onLoad() {
    const that = this;
    this._surname = '';
    this._touched = false;

    data.getMe().then(function (me) {
      const isEdit = !!me.loggedIn;
      wx.setNavigationBarTitle({ title: isEdit ? '编辑资料' : '登录' });

      const patch = {
        isEdit: isEdit,
        btnText: btnLabel(isEdit, false),
        // 性别随时回填：它不来自输入框，不存在打断输入法的问题
        gender: me.gender || '',
        genderText: data.genderLabel(me.gender),
        genderLocked: !!me.verified
      };
      // 已登录进来是改资料，回填存下来的姓和头像；用户已经开始输入就不覆盖
      if (isEdit && !that._touched) {
        const initial = String(me.surname || '');
        that._surname = initial;
        patch.avatarUrl = me.avatarUrl || '';
        patch.surname = initial;
        patch.nameText = initial;
        patch.preview = previewOf(initial);
        patch.hasSurname = !!initial;
      }
      that.setData(patch);
    }).catch(function (err) {
      console.error('[carpool] 读取登录状态失败', err);
      that.setData({ btnText: btnLabel(false, false) });
    });
  },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: (e.detail && e.detail.avatarUrl) || '' });
  },

  /**
   * 已认证用户的性别由认证后台标注，页面上锁死，点了也不响应。
   */
  onPickGender(e) {
    if (this.data.genderLocked) return;
    const g = e.currentTarget.dataset.g === 'female' ? 'female' : 'male';
    if (g === this.data.gender) return;
    haptic.tap();
    this.setData({ gender: g, genderText: data.genderLabel(g) });
  },

  /**
   * 输入中不回写 data.surname：中文输入法组词时改绑定的 value 会打断输入，
   * 之前「填了姓却读不到」就是这里。当前值单独存在 _surname 上。
   * 预览用清洗后的结果，避免预览里出现字母和符号。
   */
  onSurnameInput(e) {
    const raw = String((e.detail && e.detail.value) || '');
    const name = cleanSurname(raw);
    this._surname = raw;
    this._touched = true;
    this.setData({
      nameText: name,
      preview: previewOf(name),
      hasSurname: !!name
    });
  },

  /**
   * 失焦时清洗并回写：此时输入法已结束组词，改 value 不会打断输入。
   */
  onSurnameBlur(e) {
    const raw = String((e.detail && e.detail.value) || '');
    const name = cleanSurname(raw);
    this._surname = name;
    this._touched = true;
    this.setData({
      surname: name,
      nameText: name,
      preview: previewOf(name),
      hasSurname: !!name
    });
    if (name !== raw.trim()) {
      wx.showToast({ title: '姓只能填中文', icon: 'none' });
    }
  },

  onSave() {
    const d = this.data;
    if (d.saving) return;

    const surname = cleanSurname(this._surname);
    if (!surname) {
      wx.showToast({
        title: /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(String(this._surname || ''))
          ? '请填写你的姓'
          : '姓只能填中文，如：林',
        icon: 'none'
      });
      return;
    }
    this._surname = surname;

    // 已认证用户的性别由认证后台标注，不参与这里的必填校验
    if (!d.genderLocked && !d.gender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }

    const that = this;
    this.setData({ saving: true, btnText: btnLabel(d.isEdit, true) });

    data.uploadAvatar(d.avatarUrl)
      .then(function (url) {
        return data.saveProfile({ surname: surname, avatarUrl: url, gender: d.gender });
      })
      .then(function () {
        that.setData({ saving: false, btnText: btnLabel(d.isEdit, false) });
        haptic.tap();
        wx.showToast({ title: d.isEdit ? '已保存' : '登录成功', icon: 'success' });
        setTimeout(function () {
          if (getCurrentPages().length > 1) wx.navigateBack();
          else wx.switchTab({ url: '/pages/index/index' });
        }, 700);
      })
      .catch(function (err) {
        that.setData({ saving: false, btnText: btnLabel(d.isEdit, false) });
        wx.showToast({ title: (err && err.message) || '登录失败', icon: 'none' });
      });
  }
});
