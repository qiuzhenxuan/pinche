/**
 * 触感反馈。
 *
 * 只在真正有意义的时刻调用（成功、确认、切换这类「落定」的瞬间）。
 * Apple 的多模态反馈原则里有一条是 utility：滥用触感会让用户对全部反馈脱敏，
 * 所以失败提示之类已经有 toast 的地方就不再叠加震动。
 */
function tap() {
  wx.vibrateShort({ type: 'light', fail: function () {} });
}

module.exports = { tap: tap };
