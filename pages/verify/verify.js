const data = require('../../utils/data.js');
const haptic = require('../../utils/haptic.js');

const MAX_PICK_SIZE = 10 * 1024 * 1024; // 选择原图上限 10MB
const MAX_SIDE = 1600;                  // 压缩后长边上限
const TARGET_SIZE = 800 * 1024;         // 压缩目标 800KB

const STATUS_TEXT = {
  none: '未提交认证',
  pending: '审核中',
  rejected: '认证未通过',
  verified: '已认证'
};

const STATUS_TIP = {
  none: '完成学生认证后，拼车里会显示你的性别和「已认证」标识，发布的行程也会带上认证标识。',
  pending: '材料已提交，正在人工核验，通常 1 个工作日内完成，请耐心等待。',
  rejected: '认证未通过，请按下方原因修改后重新提交。',
  verified: '你已完成学生认证，拼车里会显示你的性别和「已认证」标识。'
};

function pickImage() {
  return new Promise(function (resolve, reject) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return reject(new Error('没有选择图片'));
        if (f.size > MAX_PICK_SIZE) {
          return reject(new Error('图片超过 10MB，请换一张'));
        }
        resolve(f.tempFilePath);
      },
      fail: function (err) {
        if (err && /cancel/i.test(err.errMsg || '')) return resolve('');
        reject(err);
      }
    });
  });
}

function getImageInfo(src) {
  return new Promise(function (resolve, reject) {
    wx.getImageInfo({ src: src, success: resolve, fail: reject });
  });
}

function compressOnce(src, width, height, quality) {
  return new Promise(function (resolve) {
    wx.compressImage({
      src: src,
      quality: quality,
      compressedWidth: width,
      compressedHeight: height,
      success: function (res) { resolve(res.tempFilePath); },
      fail: function () {
        // 低版本基础库不支持指定尺寸，退化为只压质量
        wx.compressImage({
          src: src,
          quality: quality,
          success: function (res) { resolve(res.tempFilePath); },
          fail: function () { resolve(src); }
        });
      }
    });
  });
}

function fileSize(path) {
  return new Promise(function (resolve) {
    wx.getFileSystemManager().getFileInfo({
      filePath: path,
      success: function (res) { resolve(res.size || 0); },
      fail: function () { resolve(0); }
    });
  });
}

/**
 * 先按长边 1600px + 质量 80 压一次；仍超过 800KB 就降到质量 60 再压一次。
 */
function prepareImage(src) {
  return getImageInfo(src).then(function (info) {
    const scale = Math.min(1, MAX_SIDE / Math.max(info.width, info.height));
    const w = Math.max(Math.round(info.width * scale), 1);
    const h = Math.max(Math.round(info.height * scale), 1);

    return compressOnce(src, w, h, 80).then(function (out) {
      return fileSize(out).then(function (size) {
        if (size > 0 && size <= TARGET_SIZE) return { path: out, size: size };
        return compressOnce(src, w, h, 60).then(function (out2) {
          return fileSize(out2).then(function (size2) {
            return { path: out2, size: size2 };
          });
        });
      });
    });
  });
}

function formatSize(size) {
  if (!size) return '';
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

Page({
  data: {
    type: 'chsi',
    imagePath: '',
    imageSizeText: '',
    code: '',
    note: '',
    agreed: false,
    submitting: false,
    verifyStatus: 'none',
    statusText: STATUS_TEXT.none,
    statusTip: STATUS_TIP.none,
    reason: '',
    needProfile: false,
    canSubmit: false
  },

  onShow() {
    this.load();
  },

  load() {
    const that = this;
    Promise.all([data.getMe(), data.getMyVerify()])
      .then(function (res) {
        const me = res[0] || {};
        const record = res[1];

        let status = 'none';
        if (me.verified) status = 'verified';
        else if (me.verifyStatus === 'pending') status = 'pending';
        else if (me.verifyStatus === 'rejected') status = 'rejected';

        that.update({
          needProfile: !me.loggedIn,
          verifyStatus: status,
          statusText: STATUS_TEXT[status],
          statusTip: STATUS_TIP[status],
          reason: (record && record.reason) || ''
        });
      })
      .catch(function (err) {
        console.error('[carpool] 读取认证状态失败', err);
      });
  },

  update(patch) {
    const next = Object.assign({}, this.data, patch);
    const locked = next.needProfile || next.verifyStatus === 'pending' || next.verifyStatus === 'verified';
    next.canSubmit = !locked && !!next.imagePath && next.agreed && !next.submitting;
    this.setData(next);
  },

  locked() {
    return this.data.needProfile || this.data.verifyStatus === 'pending' || this.data.verifyStatus === 'verified';
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onPickType(e) {
    if (this.locked()) return;
    const t = e.currentTarget.dataset.t;
    if (t === this.data.type) return;
    haptic.tap();
    this.update({ type: t });
  },

  onCodeInput(e) {
    this.update({ code: e.detail.value });
  },

  onNoteInput(e) {
    this.update({ note: e.detail.value });
  },

  onToggleAgree() {
    this.update({ agreed: !this.data.agreed });
  },

  onGoAgreement() {
    wx.navigateTo({ url: '/pages/legal/legal?type=agreement' });
  },

  onGoPrivacy() {
    wx.navigateTo({ url: '/pages/legal/legal?type=privacy' });
  },

  onPickImage() {
    if (this.locked()) return;

    const that = this;
    wx.showLoading({ title: '压缩中', mask: true });

    pickImage()
      .then(function (src) {
        if (!src) return null;
        return prepareImage(src);
      })
      .then(function (res) {
        wx.hideLoading();
        if (!res) return;
        that.update({ imagePath: res.path, imageSizeText: formatSize(res.size) });
      })
      .catch(function (err) {
        wx.hideLoading();
        console.error('[carpool] 选择图片失败', err);
        wx.showToast({ title: (err && err.message) || '选择图片失败', icon: 'none' });
      });
  },

  onSubmit() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.imagePath) {
      wx.showToast({ title: '请先上传认证材料', icon: 'none' });
      return;
    }
    if (!d.agreed) {
      wx.showToast({ title: '请先阅读并同意隐私说明', icon: 'none' });
      return;
    }

    const that = this;
    this.update({ submitting: true });

    data.uploadVerifyImage(d.imagePath)
      .then(function (fileID) {
        return data.submitVerify({
          type: d.type,
          imageFileID: fileID,
          code: d.code.trim(),
          note: d.note.trim()
        });
      })
      .then(function () {
        haptic.tap();
        wx.showToast({ title: '已提交', icon: 'success' });
        that.update({
          submitting: false,
          verifyStatus: 'pending',
          statusText: STATUS_TEXT.pending,
          statusTip: STATUS_TIP.pending
        });
        setTimeout(function () { wx.navigateBack(); }, 800);
      })
      .catch(function (err) {
        console.error('[carpool] 提交认证失败', err);
        that.update({ submitting: false });
        wx.showToast({ title: (err && err.message) || '提交失败，请重试', icon: 'none' });
      });
  }
});
