const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;
const TRIPS = 'trips';
const USERS = 'users';
const JOINS = 'joins';
const VERIFICATIONS = 'verifications';
const REPORTS = 'reports';
const BLOCKS = 'blocks';

// 老数据没有 city 字段时按这个城市算，口径与客户端 localQuery / normCounts 一致
const DEFAULT_CITY = '福州';

function pad(n) {
  return String(n).length < 2 ? '0' + n : String(n);
}

function dateFromOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * 出发日期上限：今天起 100 年。客户端 picker 也做了同样的限制，
 * 但服务端才是权威判定——直接调接口可以绕过客户端，塞一个离谱的年份进来。
 */
function maxDateStr() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 100);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function text(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function nowHM() {
  const d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function isExpired(date, time) {
  if (!date) return false;
  return String(date) + ' ' + text(time, 5) < dateFromOffset(0) + ' ' + nowHM();
}

/**
 * 自治区的全称在逆解析里带民族名（如「新疆维吾尔自治区」），只去后缀会剩下
 * 「新疆维吾尔」，显示出来不对，这里映射回简称。内蒙古、西藏去后缀即正确。
 */
const REGION_SHORT = {
  '广西壮族': '广西',
  '宁夏回族': '宁夏',
  '新疆维吾尔': '新疆'
};

/**
 * 城市名归一化：只剥掉行政区后缀，保留城市本身，全国通用。
 * 直辖市的 city 是「北京市」→ 北京；自治州、地区、盟保留全名，去掉后缀反而认不出来。
 */
function normCity(name) {
  const s = String(name || '')
    .trim()
    .replace(/特别行政区$/, '')
    .replace(/自治区$/, '')
    .replace(/[省市]$/, '');
  return REGION_SHORT[s] || s;
}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { raw += chunk; });
      res.on('end', function () {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('逆地址解析返回内容无法解析'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, function () { req.destroy(new Error('逆地址解析超时')); });
  });
}

/**
 * 逆地址解析放在服务端做：小程序端不用把 apis.map.qq.com 加进 request 合法域名，
 * key 也只留在云函数环境变量 MAP_KEY 里，不下发到客户端。
 * 没配 MAP_KEY、坐标非法、腾讯返回非 0 状态、网络异常，统一返回空城市，
 * 客户端据此降级为「手动选城市」，不会阻断启动。
 *
 * district 是给发布页用的：模糊定位只有千米级精度，具体上下车点定位不出来，
 * 但区县这一级能判准，客户端拿它粗判「人在不在学校所在区县」。
 */
async function locateCity(event) {
  const key = process.env.MAP_KEY;
  const lat = Number(event.latitude);
  const lng = Number(event.longitude);
  if (!key || !isFinite(lat) || !isFinite(lng)) return { city: '', district: '' };

  const url =
    'https://apis.map.qq.com/ws/geocoder/v1/?location=' + lat + ',' + lng +
    '&key=' + encodeURIComponent(key) + '&get_poi=0';

  try {
    const body = await httpsGetJson(url);
    if (!body || body.status !== 0) {
      // 腾讯返回非 0 时把原因打进日志，否则客户端只会安静降级，排查时看不到任何线索
      console.warn(
        '[trips] locateCity 腾讯返回异常 status=' +
        ((body && body.status) || '空响应') +
        ' message=' + ((body && body.message) || '')
      );
      return { city: '', district: '' };
    }
    const comp = (body.result && body.result.address_component) || {};
    return {
      city: normCity(comp.city || comp.province),
      district: String(comp.district || '')
    };
  } catch (e) {
    console.error('[trips] locateCity 逆地址解析失败', e);
    return { city: '', district: '' };
  }
}

/**
 * 下发给客户端的文档一律剥掉身份标识字段，openid 只在服务端流转。
 */
const PRIVATE_FIELDS = ['_openid', 'ownerOpenid'];

function publicDoc(doc) {
  if (!doc) return doc;
  const out = Object.assign({}, doc);
  PRIVATE_FIELDS.forEach(function (k) { delete out[k]; });
  return out;
}

function publicList(rows) {
  return (rows || []).map(publicDoc);
}

function genderOf(v) {
  return v === 'female' ? 'female' : (v === 'male' ? 'male' : '');
}

function genderLimitOf(v) {
  return v === 'male' || v === 'female' ? v : 'any';
}

function genderLimitError(limit) {
  return limit === 'male' ? '该行程仅限男生乘坐' : '该行程仅限女生乘坐';
}

/**
 * 对外展示名。用户只填一个姓，展示时统一拼成「林同学」，不暴露全名。
 */
function displayNameOf(surname) {
  const s = text(surname, 2);
  return s ? s + '同学' : '同学';
}

/**
 * 被拉黑者的对外短标识：openid 单向散列取 6 位。
 * 只用来在黑名单里区分同姓用户，无法反推 openid。
 */
function shortId(openid) {
  const s = String(openid || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ('000000' + h.toString(36).toUpperCase()).slice(-6);
}

/**
 * 拉黑记录下发 id、展示名、短标识、备注和拉黑时的行程快照，
 * 被拉黑者的 openid 留在服务端。
 */
function publicBlock(b) {
  return {
    id: b._id,
    name: b.name || '同学',
    uid: b.uid || shortId(b.blockedOpenid),
    remark: b.remark || '',
    from: b.from || '',
    to: b.to || '',
    tripDate: b.tripDate || '',
    tripTime: b.tripTime || '',
    createdAt: b.createdAt || 0
  };
}

/**
 * 我拉黑的人（openid 列表），用于列表过滤。
 */
async function blockedSet(openid) {
  await ensureCollection(BLOCKS);
  const res = await db.collection(BLOCKS).where({ _openid: openid }).limit(200).get();
  return res.data.map(function (b) { return b.blockedOpenid; }).filter(Boolean);
}

/**
 * 双方任一方向存在拉黑即视为不可见 / 不可申请。
 */
async function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  await ensureCollection(BLOCKS);
  const res = await db.collection(BLOCKS)
    .where(_.or([
      { _openid: a, blockedOpenid: b },
      { _openid: b, blockedOpenid: a }
    ]))
    .limit(1)
    .get();
  return res.data.length > 0;
}

/**
 * 演示数据：福州工商学院（永泰葛岭）常见出行方向。
 * 站点与线路参考闽运永泰 / 滴滴站点巴士公布的直通车停靠点。
 * offset 为相对今天的天数；seats 为可带人数。
 */
const SEED = [
  { from: '福州工商学院（南门）', to: '永泰站（动车站）', corridor: '永泰站', offset: 1, time: '08:00', seats: 3, totalPrice: 45, male: 1, female: 2, note: '赶 09:12 的动车，走 203 省道，十分钟到站。', owner: '林同学', verified: true },
  { from: '福州工商学院（北门）', to: '福州站', corridor: '福州站', offset: 1, time: '07:30', seats: 3, totalPrice: 75, male: 2, female: 1, note: '葛岭上福永高速，后备箱可放两个行李箱。', owner: '陈同学', verified: true },
  { from: '福州工商学院（南门）', to: '福州南站', corridor: '福州南站', offset: 1, time: '09:00', seats: 2, totalPrice: 60, male: 0, female: 2, note: '高速直达，赶 11 点前的高铁。', owner: '王同学', verified: true },
  { from: '福州工商学院（北门）', to: '福州长乐国际机场', corridor: '长乐机场', offset: 2, time: '05:30', seats: 3, totalPrice: 135, male: 3, female: 0, note: '赶早班机，走机场高速，准时出发不等人。', owner: '张同学', verified: false },
  { from: '福州工商学院（南门）', to: '东街口', corridor: '市区', offset: 2, time: '10:00', seats: 2, totalPrice: 50, male: 1, female: 1, note: '送到东街口地铁站，可顺路到三坊七巷。', owner: '刘同学', verified: true },
  { from: '葛岭九老公交站', to: '福州南站', corridor: '福州南站', offset: 2, time: '13:30', seats: 4, totalPrice: 120, male: 2, female: 2, note: '在九老上车，高速直达南站。', owner: '赵同学', verified: true },
  { from: '福州工商学院（北门）', to: '万象九宜城（苏万宝·宁化地铁站）', corridor: '市区', offset: 3, time: '15:00', seats: 2, totalPrice: 50, male: 0, female: 1, note: '送到万象九宜城，地铁 2 号线宁化站换乘方便。', owner: '孙同学', verified: true },
  { from: '福州工商学院（南门）', to: '仓山万达', corridor: '市区', offset: 3, time: '16:30', seats: 3, totalPrice: 90, male: 1, female: 2, note: '周末去万达，可等 15 分钟。', owner: '周同学', verified: true },
  { from: '福州工商学院（南门）', to: '永泰站（动车站）', corridor: '永泰站', offset: 6, time: '07:00', seats: 3, totalPrice: 45, male: 2, female: 1, note: '早班动车，十分钟到站。', owner: '吴同学', verified: true },
  { from: '福州南站', to: '福州工商学院（南门）', corridor: '福州南站', offset: 7, time: '18:00', seats: 3, totalPrice: 90, male: 1, female: 2, note: '周日晚返校，出站后 B 出口集合。', owner: '郑同学', verified: true },
  { from: '福州站', to: '福州工商学院（北门）', corridor: '福州站', offset: 7, time: '19:30', seats: 2, totalPrice: 50, male: 2, female: 0, note: '返校顺路，可等 20 分钟。', owner: '黄同学', verified: false },
  { from: '福州工商学院（北门）', to: '福州汽车北站', corridor: '汽车站', offset: 7, time: '06:30', seats: 3, totalPrice: 75, male: 1, female: 1, note: '到北站坐长途车，同路的可以拼。', owner: '何同学', verified: true },
  { from: '福州工商学院（南门）', to: '浦上爱琴海', corridor: '市区', offset: 10, time: '14:00', seats: 2, totalPrice: 60, male: 0, female: 1, note: '顺路，福永高速转三环。', owner: '徐同学', verified: true },
  { from: '福州工商学院（北门）', to: '福州长乐国际机场', corridor: '长乐机场', offset: 10, time: '06:00', seats: 3, totalPrice: 135, male: 2, female: 1, note: '早班机，行李多也没问题。', owner: '马同学', verified: true },
  { from: '福州工商学院（南门）', to: '台屿地铁站（台屿公交站）', corridor: '市区', offset: 4, time: '09:30', seats: 3, totalPrice: 75, male: 1, female: 1, note: '福永高速转三环，台屿地铁 A 口下车。', owner: '许同学', verified: true },
  { from: '福州汽车西站（闽侯上街）', to: '福州工商学院（北门）', corridor: '汽车站', offset: 5, time: '17:00', seats: 3, totalPrice: 90, male: 2, female: 1, note: '从汽车西站返校，南屿上福永高速，行李可放后备箱。', owner: '林同学', verified: false }
];

const COLLECTIONS = [TRIPS, USERS, JOINS, VERIFICATIONS, REPORTS, BLOCKS];
const ensured = {};

/**
 * 云数据库不会因为写入就自动建表，集合不存在时首次调用会报
 * -502005 database collection not exists，所以入口先兜底建表。
 * 同一容器内每个集合只创建一次，热启动直接命中缓存。
 */
async function ensureCollection(name) {
  if (ensured[name]) return;
  try {
    await db.createCollection(name);
  } catch (e) {
    // 集合已存在，忽略
  }
  ensured[name] = true;
}

async function ensureCollections() {
  await Promise.all(COLLECTIONS.map(function (name) { return ensureCollection(name); }));
}

/* ---------------- 用户 ---------------- */

async function findUser(openid) {
  const res = await db.collection(USERS).where({ _openid: openid }).limit(1).get();
  return res.data[0] || null;
}

async function login(openid) {
  const found = await findUser(openid);
  if (found) return found;

  const doc = {
    _openid: openid,
    surname: '',
    avatarUrl: '',
    gender: '',
    verified: false,
    verifyStatus: 'none',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const res = await db.collection(USERS).add({ data: doc });
  return Object.assign({ _id: res._id }, doc);
}

/**
 * 保存资料（姓 + 头像 + 性别）。姓只用于拼出「林同学」，不做实名展示。
 * 已认证用户的性别由认证后台标注，这里忽略传入值，避免用户改掉核验结果。
 */
async function saveProfile(event, openid) {
  const surname = text(event.surname, 2);
  if (!surname) throw new Error('请填写你的姓');

  const avatarUrl = text(event.avatarUrl, 300);
  const me = await login(openid);

  const patch = { surname: surname, avatarUrl: avatarUrl, updatedAt: Date.now() };
  if (!me.verified) {
    const gender = genderOf(event.gender);
    if (!gender) throw new Error('请选择性别');
    patch.gender = gender;
  }

  await db.collection(USERS).doc(me._id).update({ data: patch });

  return publicDoc(Object.assign({}, me, patch));
}

/**
 * 退出登录：只清掉登录资料（姓 + 头像），openid 与认证状态留在服务端。
 * openid 由微信侧决定，换了它，用户已发布的行程和报名就都成了孤儿。
 */
async function logout(event, openid) {
  const me = await findUser(openid);
  if (!me) return publicDoc({ _openid: openid, surname: '', avatarUrl: '' });

  await db.collection(USERS).doc(me._id).update({
    data: { surname: '', avatarUrl: '', updatedAt: Date.now() }
  });
  return publicDoc(Object.assign({}, me, { surname: '', avatarUrl: '' }));
}

/* ---------------- 行程 ---------------- */

/**
 * 列表只返回还没发车的行程：日期在今天之后，或今天但时间还没到。
 * 条件写在查询里，分页才不会因为过滤而错位。
 */
async function list(event, openid) {
  const skip = Number(event.skip) || 0;
  const limit = Math.min(Number(event.limit) || 20, 100);
  const corridor = event.corridor;
  const city = text(event.city, 10);

  const today = dateFromOffset(0);
  const conds = [
    { seatsLeft: _.gt(0) },
    _.or([
      { date: _.gt(today) },
      { date: today, time: _.gt(nowHM()) }
    ])
  ];
  if (corridor && corridor !== 'all') conds.push({ corridor: corridor });
  // 老数据没有 city 字段，它属于默认城市，所以只在查默认城市时放行。
  // 不能无条件放行——那样切到别的城市也会看到福州的行程。
  if (city) {
    conds.push(
      city === DEFAULT_CITY
        ? _.or([{ city: city }, { city: _.exists(false) }])
        : { city: city }
    );
  }

  const blocked = await blockedSet(openid);
  if (blocked.length) conds.push({ _openid: _.nin(blocked) });

  const res = await db.collection(TRIPS)
    .where(_.and(conds))
    .orderBy('date', 'asc')
    .orderBy('time', 'asc')
    .skip(skip)
    .limit(limit)
    .get();

  return publicList(res.data);
}

/**
 * 各城市当前「可报名」行程数，供「选择城市」页标出哪些城市有车。
 * 过滤口径与 list 完全一致（未发车、还有座位、排除被我拉黑的人），
 * 否则会出现「标着有车、点进去却是空列表」这种对不上的情况。
 * 老数据没有 city 字段，归到空串，由客户端折算成默认城市。
 */
async function cityCounts(openid) {
  const today = dateFromOffset(0);
  const conds = [
    { seatsLeft: _.gt(0) },
    _.or([
      { date: _.gt(today) },
      { date: today, time: _.gt(nowHM()) }
    ])
  ];
  const blocked = await blockedSet(openid);
  if (blocked.length) conds.push({ _openid: _.nin(blocked) });

  const res = await db.collection(TRIPS).aggregate()
    .match(_.and(conds))
    .group({ _id: '$city', n: $.sum(1) })
    .limit(200)
    .end();

  const counts = {};
  (res.list || []).forEach(function (row) {
    const key = row._id === undefined || row._id === null ? '' : String(row._id);
    counts[key] = (counts[key] || 0) + (Number(row.n) || 0);
  });
  return { counts: counts };
}

async function detail(event, openid) {
  const id = event.id;
  if (!id) throw new Error('缺少参数 id');

  let res;
  try {
    res = await db.collection(TRIPS).doc(id).get();
  } catch (e) {
    throw new Error('行程不存在');
  }
  const trip = res.data;
  if (!trip) throw new Error('行程不存在');

  const mine = trip._openid === openid;
  if (!mine && await isBlockedBetween(openid, trip._openid)) {
    throw new Error('该行程不可见');
  }

  let myJoin = null;
  if (!mine) {
    const jr = await db.collection(JOINS)
      .where({ tripId: id, _openid: openid, status: _.nin(['rejected', 'cancelled']) })
      .limit(1)
      .get();
    if (jr.data.length) {
      myJoin = { id: jr.data[0]._id, status: jr.data[0].status };
    }
  }

  return Object.assign(publicDoc(trip), { mine: mine, myJoin: myJoin });
}

async function mine(openid) {
  const res = await db.collection(TRIPS)
    .where({ _openid: openid })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return publicList(res.data);
}

async function add(event, openid) {
  const from = text(event.from, 40);
  const to = text(event.to, 40);
  if (!from || !to) throw new Error('出发地和目的地不能为空');
  if (from === to) throw new Error('出发地和目的地不能相同');

  const date = text(event.date, 10);
  const time = text(event.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('出发日期格式不正确');
  if (date > maxDateStr()) throw new Error('出发日期不能超过 100 年');
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('出发时间格式不正确');
  if (isExpired(date, time)) throw new Error('出发时间不能早于当前时间');

  const me = await login(openid);
  if (!me.surname) throw new Error('请先完善资料后再发布');
  const gender = genderOf(me.gender);

  // 限性别的车，车主自己得先符合这个性别，否则规则自相矛盾
  const genderLimit = genderLimitOf(event.genderLimit);
  if (genderLimit !== 'any' && gender !== genderLimit) {
    throw new Error(genderLimit === 'male' ? '「仅限男生」需要你的资料性别为男' : '「仅限女生」需要你的资料性别为女');
  }

  const seats = Math.min(Math.max(Number(event.seats) || 1, 1), 4);
  const doc = {
    from: from,
    to: to,
    city: text(event.city, 20) || DEFAULT_CITY,
    corridor: text(event.corridor, 10) || '其他',
    date: date,
    time: time,
    seats: seats,
    seatsLeft: seats,
    status: 'open',
    totalPrice: Math.max(Number(event.totalPrice) || 0, 0),
    male: gender === 'male' ? 1 : 0,
    female: gender === 'female' ? 1 : 0,
    ownerGender: gender,
    genderLimit: genderLimit,
    note: text(event.note, 100),
    owner: displayNameOf(me.surname),
    verified: !!me.verified,
    _openid: openid,
    createdAt: Date.now()
  };

  const res = await db.collection(TRIPS).add({ data: doc });
  return publicDoc(Object.assign({ _id: res._id }, doc));
}

async function remove(event, openid) {
  const id = event.id;
  if (!id) throw new Error('缺少参数 id');

  let cur;
  try {
    cur = await db.collection(TRIPS).doc(id).get();
  } catch (e) {
    throw new Error('行程不存在');
  }
  if (!cur.data) throw new Error('行程不存在');
  if (cur.data._openid !== openid) throw new Error('只能删除自己发布的行程');

  await db.collection(TRIPS).doc(id).remove();

  const joins = await db.collection(JOINS).where({ tripId: id }).limit(100).get();
  for (let i = 0; i < joins.data.length; i++) {
    await db.collection(JOINS).doc(joins.data[i]._id).remove();
  }

  return { id: id };
}

/* ---------------- 报名 ---------------- */

async function join(event, openid) {
  const tripId = event.tripId;
  if (!tripId) throw new Error('缺少参数 tripId');

  let tripRes;
  try {
    tripRes = await db.collection(TRIPS).doc(tripId).get();
  } catch (e) {
    throw new Error('行程不存在');
  }
  const trip = tripRes.data;
  if (!trip) throw new Error('行程不存在');
  if (trip._openid === openid) throw new Error('不能申请自己发布的行程');
  if (await isBlockedBetween(openid, trip._openid)) throw new Error('无法申请该行程');
  if (isExpired(trip.date, trip.time)) throw new Error('该行程已结束');
  if ((trip.seatsLeft || 0) <= 0) throw new Error('该行程已满员');

  const dup = await db.collection(JOINS)
    .where({ tripId: tripId, _openid: openid, status: _.nin(['rejected', 'cancelled']) })
    .limit(1)
    .get();
  if (dup.data.length) throw new Error('你已经申请过了，等待发布者同意');

  const me = await login(openid);
  if (!me.surname) throw new Error('请先完善资料后再申请');

  const limit = genderLimitOf(trip.genderLimit);
  if (limit !== 'any' && genderOf(me.gender) !== limit) throw new Error(genderLimitError(limit));

  const doc = {
    tripId: tripId,
    ownerOpenid: trip._openid,
    _openid: openid,
    gender: genderOf(me.gender),
    status: 'pending',
    name: displayNameOf(me.surname),
    createdAt: Date.now()
  };

  const res = await db.collection(JOINS).add({ data: doc });
  return publicDoc(Object.assign({ _id: res._id }, doc));
}

async function tripJoins(event, openid) {
  const tripId = event.tripId;
  if (!tripId) throw new Error('缺少参数 tripId');

  const tripRes = await db.collection(TRIPS).doc(tripId).get();
  if (!tripRes.data) throw new Error('行程不存在');
  if (tripRes.data._openid !== openid) throw new Error('只有发布者能查看申请列表');

  const res = await db.collection(JOINS)
    .where({ tripId: tripId })
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();
  return publicList(res.data);
}

/**
 * 发布者同意 / 拒绝上车申请。整段读写放进事务，
 * 避免两个同意请求同时读到同一个剩余座位、把座位扣成负数（超卖）。
 */
async function decideJoin(event, openid) {
  const joinId = event.joinId;
  const approve = !!event.approve;
  if (!joinId) throw new Error('缺少参数 joinId');

  const transaction = await db.startTransaction();
  try {
    let jr;
    try {
      jr = await transaction.collection(JOINS).doc(joinId).get();
    } catch (e) {
      throw new Error('申请不存在');
    }
    const join = jr.data;
    if (!join) throw new Error('申请不存在');
    if (join.status !== 'pending') throw new Error('该申请已处理过');

    const tr = await transaction.collection(TRIPS).doc(join.tripId).get();
    const trip = tr.data;
    if (!trip) throw new Error('行程不存在');
    if (trip._openid !== openid) throw new Error('只有发布者能处理申请');

    const seatsLeft = Math.max((trip.seatsLeft || 0) - 1, 0);
    if (approve && seatsLeft === (trip.seatsLeft || 0)) throw new Error('该行程已满员');

    await transaction.collection(JOINS).doc(joinId).update({
      data: { status: approve ? 'approved' : 'rejected', updatedAt: Date.now() }
    });

    if (approve) {
      const patch = {
        seatsLeft: seatsLeft,
        status: seatsLeft > 0 ? 'open' : 'full',
        updatedAt: Date.now()
      };
      if (join.gender === 'male') patch.male = (trip.male || 0) + 1;
      if (join.gender === 'female') patch.female = (trip.female || 0) + 1;
      await transaction.collection(TRIPS).doc(join.tripId).update({ data: patch });
    }

    await transaction.commit();
    return publicDoc(Object.assign({}, join, { status: approve ? 'approved' : 'rejected' }));
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

/**
 * 撤回自己还没被处理的申请。撤回后可重新申请同一条行程。
 */
async function cancelJoin(event, openid) {
  const joinId = event.joinId;
  if (!joinId) throw new Error('缺少参数 joinId');

  let jr;
  try {
    jr = await db.collection(JOINS).doc(joinId).get();
  } catch (e) {
    throw new Error('申请不存在');
  }
  const join = jr.data;
  if (!join) throw new Error('申请不存在');
  if (join._openid !== openid) throw new Error('只能撤回自己的申请');
  if (join.status !== 'pending') throw new Error('发布者已处理，无法撤回');

  await db.collection(JOINS).doc(joinId).update({
    data: { status: 'cancelled', updatedAt: Date.now() }
  });

  return publicDoc(Object.assign({}, join, { status: 'cancelled' }));
}

async function myJoins(openid) {
  const res = await db.collection(JOINS)
    .where({ _openid: openid, status: _.nin(['rejected', 'cancelled']) })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const rows = [];
  for (let i = 0; i < res.data.length; i++) {
    const j = res.data[i];
    let trip = null;
    try {
      const tr = await db.collection(TRIPS).doc(j.tripId).get();
      trip = tr.data || null;
    } catch (e) {
      trip = null;
    }
    if (trip) {
      rows.push({ joinId: j._id, status: j.status, trip: publicDoc(trip) });
    }
  }
  return rows;
}

/* ---------------- 举报 / 拉黑 ---------------- */

/**
 * 举报行程。目标用户从行程反查，客户端不需要（也不应该）拿到对方 openid。
 */
async function report(event, openid) {
  const tripId = event.tripId;
  if (!tripId) throw new Error('缺少参数 tripId');

  let tripRes;
  try {
    tripRes = await db.collection(TRIPS).doc(tripId).get();
  } catch (e) {
    throw new Error('行程不存在');
  }
  const trip = tripRes.data;
  if (!trip) throw new Error('行程不存在');
  if (trip._openid === openid) throw new Error('不能举报自己发布的行程');

  const me = await login(openid);
  if (!me.surname) throw new Error('请先完善资料后再举报');

  const reason = text(event.reason, 50);
  if (!reason) throw new Error('请选择举报原因');

  await ensureCollection(REPORTS);
  const dup = await db.collection(REPORTS)
    .where({ _openid: openid, tripId: tripId, status: 'pending' })
    .limit(1)
    .get();
  if (dup.data.length) throw new Error('你已举报过该行程，我们会尽快处理');

  const doc = {
    _openid: openid,
    tripId: tripId,
    targetOpenid: trip._openid,
    targetNickname: trip.owner || '同学',
    tripFrom: trip.from || '',
    tripTo: trip.to || '',
    reason: reason,
    detail: text(event.detail, 200),
    status: 'pending',
    remark: '',
    createdAt: Date.now()
  };

  const res = await db.collection(REPORTS).add({ data: doc });
  return publicDoc(Object.assign({ _id: res._id }, doc));
}

/**
 * 拉黑行程发布人。拉黑后双向不可见：列表里不再出现对方的行程，
 * 详情页打不开，也不能再申请。
 */
async function block(event, openid) {
  const tripId = event.tripId;
  if (!tripId) throw new Error('缺少参数 tripId');

  let tripRes;
  try {
    tripRes = await db.collection(TRIPS).doc(tripId).get();
  } catch (e) {
    throw new Error('行程不存在');
  }
  const trip = tripRes.data;
  if (!trip) throw new Error('行程不存在');

  const target = trip._openid;
  if (!target) throw new Error('无法拉黑该用户');
  if (target === openid) throw new Error('不能拉黑自己');

  const me = await login(openid);
  if (!me.surname) throw new Error('请先完善资料后再拉黑');

  await ensureCollection(BLOCKS);
  const dup = await db.collection(BLOCKS)
    .where({ _openid: openid, blockedOpenid: target })
    .limit(1)
    .get();
  if (dup.data.length) return publicBlock(dup.data[0]);

  const doc = {
    _openid: openid,
    blockedOpenid: target,
    name: trip.owner || '同学',
    uid: shortId(target),
    remark: text(event.remark, 20),
    from: trip.from || '',
    to: trip.to || '',
    tripDate: trip.date || '',
    tripTime: trip.time || '',
    createdAt: Date.now()
  };
  const res = await db.collection(BLOCKS).add({ data: doc });
  return publicBlock(Object.assign({ _id: res._id }, doc));
}

async function unblock(event, openid) {
  const blockId = event.blockId;
  if (!blockId) throw new Error('缺少参数 blockId');

  let br;
  try {
    br = await db.collection(BLOCKS).doc(blockId).get();
  } catch (e) {
    throw new Error('记录不存在');
  }
  const b = br.data;
  if (!b) throw new Error('记录不存在');
  if (b._openid !== openid) throw new Error('无权操作');

  await db.collection(BLOCKS).doc(blockId).remove();
  return { id: blockId };
}

async function myBlocks(openid) {
  await ensureCollection(BLOCKS);
  const res = await db.collection(BLOCKS)
    .where({ _openid: openid })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return res.data.map(publicBlock);
}

/* ---------------- 学生认证 ---------------- */

async function verify(event, openid) {
  const type = event.type === 'chsi' ? 'chsi' : 'studentcard';
  const imageFileID = text(event.imageFileID, 500);
  if (!imageFileID) throw new Error('请先上传认证材料');

  const me = await login(openid);
  if (!me.surname) throw new Error('请先完善资料后再提交认证');
  if (me.verified) throw new Error('你已经完成认证');
  if (me.verifyStatus === 'pending') throw new Error('已有待审核的申请，请等待审核');

  await ensureCollection(VERIFICATIONS);

  const dup = await db.collection(VERIFICATIONS)
    .where({ _openid: openid, status: 'pending' })
    .limit(1)
    .get();
  if (dup.data.length) throw new Error('已有待审核的申请，请等待审核');

  const doc = {
    _openid: openid,
    type: type,
    imageFileID: imageFileID,
    code: text(event.code, 40),
    note: text(event.note, 100),
    status: 'pending',
    reason: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const res = await db.collection(VERIFICATIONS).add({ data: doc });
  await db.collection(USERS).doc(me._id).update({
    data: { verifyStatus: 'pending', updatedAt: Date.now() }
  });

  return publicDoc(Object.assign({ _id: res._id }, doc));
}

async function myVerify(openid) {
  await ensureCollection(VERIFICATIONS);
  const res = await db.collection(VERIFICATIONS)
    .where({ _openid: openid })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  return publicDoc(res.data[0] || null);
}

/* ---------------- 演示数据（仅管理端） ---------------- */

/**
 * 演示行程的日期是相对当天算的，放几天就会全部过期。
 * 所以每次 seed 都先清掉上一批演示数据（demo: true）再重插，
 * 用户自己发布的行程没有 demo 标记，不受影响。
 */
async function seed(event) {
  checkAdmin(event);
  await ensureCollection(TRIPS);
  await ensureCollection(USERS);
  await ensureCollection(JOINS);
  await ensureCollection(VERIFICATIONS);
  await ensureCollection(REPORTS);
  await ensureCollection(BLOCKS);

  const old = await db.collection(TRIPS).where({ demo: true }).limit(100).get();
  for (let i = 0; i < old.data.length; i++) {
    await db.collection(TRIPS).doc(old.data[i]._id).remove();
  }

  let inserted = 0;
  for (let i = 0; i < SEED.length; i++) {
    const s = SEED[i];
    await db.collection(TRIPS).add({
      data: {
        from: s.from,
        to: s.to,
        city: '福州',
        corridor: s.corridor,
        date: dateFromOffset(s.offset),
        time: s.time,
        seats: s.seats,
        seatsLeft: s.seats,
        status: 'open',
        totalPrice: s.totalPrice,
        male: s.male,
        female: s.female,
        ownerGender: '',
        genderLimit: 'any',
        note: s.note,
        owner: s.owner,
        verified: s.verified,
        demo: true,
        createdAt: Date.now() + i
      }
    });
    inserted++;
  }

  return { inserted: inserted, removed: old.data.length };
}

/* ---------------- 管理端（审核后台专用，走 HTTP 访问服务） ---------------- */

function checkAdmin(event) {
  const token = process.env.ADMIN_TOKEN || '';
  if (!token) throw new Error('云函数未配置 ADMIN_TOKEN，管理端接口已禁用');
  if (String(event.token || '') !== token) throw new Error('无权访问');
}

async function adminListVerifications(event) {
  checkAdmin(event);
  await ensureCollection(VERIFICATIONS);

  const status = ['pending', 'approved', 'rejected'].indexOf(event.status) >= 0 ? event.status : 'pending';
  const limit = Math.min(Number(event.limit) || 50, 100);

  const res = await db.collection(VERIFICATIONS)
    .where({ status: status })
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  const rows = res.data;
  const fileList = rows
    .map(function (r) { return r.imageFileID; })
    .filter(function (f) { return !!f; });

  const urlMap = {};
  if (fileList.length) {
    const urls = await cloud.getTempFileURL({ fileList: fileList });
    (urls.fileList || []).forEach(function (f) {
      urlMap[f.fileID] = f.tempFileURL || '';
    });
  }

  return rows.map(function (r) {
    return Object.assign({}, r, { imageUrl: urlMap[r.imageFileID] || '' });
  });
}

async function adminReviewVerification(event) {
  checkAdmin(event);

  const id = event.id;
  const approve = !!event.approve;
  if (!id) throw new Error('缺少参数 id');

  let vr;
  try {
    vr = await db.collection(VERIFICATIONS).doc(id).get();
  } catch (e) {
    throw new Error('认证申请不存在');
  }
  const record = vr.data;
  if (!record) throw new Error('认证申请不存在');
  if (record.status !== 'pending') throw new Error('该申请已处理过');

  const gender = genderOf(event.gender);
  if (approve && !gender) throw new Error('通过时必须指定性别');

  const reason = text(event.reason, 100) || '材料不清晰或无法核实，请重新提交';
  const now = Date.now();

  await db.collection(VERIFICATIONS).doc(id).update({
    data: {
      status: approve ? 'approved' : 'rejected',
      gender: approve ? gender : '',
      reason: approve ? '' : reason,
      reviewedAt: now,
      updatedAt: now
    }
  });

  const user = await findUser(record._openid);
  if (user) {
    const patch = { verifyStatus: approve ? 'approved' : 'rejected', updatedAt: now };
    if (approve) {
      patch.verified = true;
      patch.gender = gender;
    } else {
      patch.verified = false;
    }
    await db.collection(USERS).doc(user._id).update({ data: patch });
  }

  // 核验完成即删除照片，不留存
  if (record.imageFileID) {
    try {
      await cloud.deleteFile({ fileList: [record.imageFileID] });
    } catch (e) {
      console.error('[trips] 删除认证照片失败', e);
    }
  }

  return Object.assign({}, record, {
    status: approve ? 'approved' : 'rejected',
    gender: approve ? gender : '',
    reason: approve ? '' : reason
  });
}

/* ---------------- 管理端：举报处理 ---------------- */

async function adminListReports(event) {
  checkAdmin(event);
  await ensureCollection(REPORTS);

  const status = ['pending', 'handled', 'dismissed'].indexOf(event.status) >= 0 ? event.status : 'pending';
  const limit = Math.min(Number(event.limit) || 50, 100);

  const res = await db.collection(REPORTS)
    .where({ status: status })
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  return res.data;
}

async function adminReviewReport(event) {
  checkAdmin(event);

  const id = event.id;
  if (!id) throw new Error('缺少参数 id');

  let rr;
  try {
    rr = await db.collection(REPORTS).doc(id).get();
  } catch (e) {
    throw new Error('举报记录不存在');
  }
  const record = rr.data;
  if (!record) throw new Error('举报记录不存在');
  if (record.status !== 'pending') throw new Error('该举报已处理过');

  const status = event.dismiss ? 'dismissed' : 'handled';
  await db.collection(REPORTS).doc(id).update({
    data: {
      status: status,
      remark: text(event.remark, 100),
      reviewedAt: Date.now()
    }
  });

  return Object.assign({}, record, { status: status, remark: text(event.remark, 100) });
}

/* ---------------- HTTP 访问服务入口 ---------------- */

function httpResponse(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

async function handleHttp(event) {
  let payload;
  try {
    payload = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch (e) {
    return httpResponse(400, { ok: false, error: '请求体不是合法 JSON' });
  }
  Object.assign(payload, event.queryStringParameters || {});

  try {
    await ensureCollections();
    if (payload.action === 'adminListVerifications') {
      return httpResponse(200, { ok: true, data: await adminListVerifications(payload) });
    }
    if (payload.action === 'adminReviewVerification') {
      return httpResponse(200, { ok: true, data: await adminReviewVerification(payload) });
    }
    if (payload.action === 'adminSeed') {
      return httpResponse(200, { ok: true, data: await seed(payload) });
    }
    if (payload.action === 'adminListReports') {
      return httpResponse(200, { ok: true, data: await adminListReports(payload) });
    }
    if (payload.action === 'adminReviewReport') {
      return httpResponse(200, { ok: true, data: await adminReviewReport(payload) });
    }
    return httpResponse(200, { ok: false, error: '未知 action：' + payload.action });
  } catch (e) {
    console.error('[trips] http action=' + payload.action + ' 失败', e);
    return httpResponse(200, { ok: false, error: e.message || '服务端异常' });
  }
}

exports.main = async (event) => {
  if (event && event.httpMethod) return handleHttp(event);

  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const action = event.action;

  try {
    await ensureCollections();
    if (action === 'login') return { ok: true, data: publicDoc(await login(openid)) };
    if (action === 'saveProfile') return { ok: true, data: await saveProfile(event, openid) };
    if (action === 'logout') return { ok: true, data: await logout(event, openid) };
    if (action === 'list') return { ok: true, data: await list(event, openid) };
    if (action === 'cityCounts') return { ok: true, data: await cityCounts(openid) };
    if (action === 'detail') return { ok: true, data: await detail(event, openid) };
    if (action === 'mine') return { ok: true, data: await mine(openid) };
    if (action === 'add') return { ok: true, data: await add(event, openid) };
    if (action === 'remove') return { ok: true, data: await remove(event, openid) };
    if (action === 'join') return { ok: true, data: await join(event, openid) };
    if (action === 'cancelJoin') return { ok: true, data: await cancelJoin(event, openid) };
    if (action === 'tripJoins') return { ok: true, data: await tripJoins(event, openid) };
    if (action === 'decideJoin') return { ok: true, data: await decideJoin(event, openid) };
    if (action === 'myJoins') return { ok: true, data: await myJoins(openid) };
    if (action === 'report') return { ok: true, data: await report(event, openid) };
    if (action === 'block') return { ok: true, data: await block(event, openid) };
    if (action === 'unblock') return { ok: true, data: await unblock(event, openid) };
    if (action === 'myBlocks') return { ok: true, data: await myBlocks(openid) };
    if (action === 'verify') return { ok: true, data: await verify(event, openid) };
    if (action === 'myVerify') return { ok: true, data: await myVerify(openid) };
    if (action === 'locateCity') return { ok: true, data: await locateCity(event) };
    if (action === 'seed') return { ok: true, data: await seed(event) };
    return { ok: false, error: '未知 action：' + action };
  } catch (e) {
    console.error('[trips] action=' + action + ' 失败', e);
    return { ok: false, error: e.message || '服务端异常' };
  }
};
