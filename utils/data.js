const config = require('../config.js');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TRIP_KEY = 'carpool_user_trips';
const JOIN_KEY = 'carpool_joins';
const ME_KEY = 'carpool_me';
const VERIFY_KEY = 'carpool_verify';
const REPORT_KEY = 'carpool_reports';
const BLOCK_KEY = 'carpool_blocks';
const CITY_KEY = 'carpool_city';
// 定位解析出的区县，只在发布页用来粗判「人在不在学校所在区县」
const DISTRICT_KEY = 'carpool_district';
const PAGE_SIZE = config.pageSize || 20;

/**
 * 短时缓存。只有显式传 ttl 的调用方才走缓存（目前只有首页），
 * 其余页面照旧每次拿最新的——比如认证页需要看到后台刚改的状态。
 *
 * 首页每次显示都要读「登录态」和「各城市行程数」，这两项都是云调用，
 * 而「点进详情再返回」这种高频往返没必要每次重问一遍。
 * 写操作会主动失效，所以不会出现「刚发布却还显示没车」这种脏数据。
 */
let meCache = null;      // { at, value }
let countsCache = null;  // { at, value }

function cached(cache, ttl) {
  if (!cache || !ttl) return null;
  return Date.now() - cache.at < ttl ? cache.value : null;
}

// 登录态只在登录 / 退出时变，失效点少且确定
function bustMe() { meCache = null; }

// 行程数受发布、删除、报名、同意、撤回、拉黑影响，写操作一律失效
function bustCounts() { countsCache = null; }

// 下拉刷新用：用户明确要最新数据，两个缓存一起作废
function bustCaches() { meCache = null; countsCache = null; }

/**
 * 城市分区：行程按城市归类，首页只展示当前城市的行程。
 * 定位本身覆盖全国，这份列表只是「手动切换」时的候选项；
 * 定位到列表外的城市时会自动插到最前面，不会找不到。
 */
const CITIES = [
  '北京', '上海', '天津', '重庆',
  '石家庄', '太原', '呼和浩特', '沈阳', '长春', '哈尔滨',
  '南京', '杭州', '合肥', '福州', '厦门', '南昌', '济南', '郑州',
  '武汉', '长沙', '广州', '深圳', '南宁', '海口',
  '成都', '贵阳', '昆明', '拉萨', '西安', '兰州', '西宁', '银川', '乌鲁木齐',
  '大连', '青岛', '宁波', '苏州', '无锡', '东莞', '佛山', '珠海', '泉州', '三亚',
  '香港', '澳门'
];
const DEFAULT_CITY = config.defaultCity || '福州';
// 自动定位总开关，默认开；config.autoLocate 显式设为 false 时关闭（原因见 config.js）
const AUTO_LOCATE = config.autoLocate !== false;

/**
 * 城市名的拼音全拼（小写），只服务于「选择城市」页的 A-Z 分组和组内排序。
 * 不引拼音库：候选城市就这些，写死比多一个依赖划算，排序结果也稳定可控。
 */
const CITY_PINYIN = {
  '北京': 'beijing',
  '上海': 'shanghai',
  '天津': 'tianjin',
  '重庆': 'chongqing',
  '石家庄': 'shijiazhuang',
  '太原': 'taiyuan',
  '呼和浩特': 'huhehaote',
  '沈阳': 'shenyang',
  '长春': 'changchun',
  '哈尔滨': 'haerbin',
  '南京': 'nanjing',
  '杭州': 'hangzhou',
  '合肥': 'hefei',
  '福州': 'fuzhou',
  '厦门': 'xiamen',
  '南昌': 'nanchang',
  '济南': 'jinan',
  '郑州': 'zhengzhou',
  '武汉': 'wuhan',
  '长沙': 'changsha',
  '广州': 'guangzhou',
  '深圳': 'shenzhen',
  '南宁': 'nanning',
  '海口': 'haikou',
  '成都': 'chengdu',
  '贵阳': 'guiyang',
  '昆明': 'kunming',
  '拉萨': 'lasa',
  '西安': 'xian',
  '兰州': 'lanzhou',
  '西宁': 'xining',
  '银川': 'yinchuan',
  '乌鲁木齐': 'wulumuqi',
  '大连': 'dalian',
  '青岛': 'qingdao',
  '宁波': 'ningbo',
  '苏州': 'suzhou',
  '无锡': 'wuxi',
  '东莞': 'dongguan',
  '佛山': 'foshan',
  '珠海': 'zhuhai',
  '泉州': 'quanzhou',
  '三亚': 'sanya',
  '香港': 'xianggang',
  '澳门': 'aomen'
};

/**
 * 线路筛选（按 corridor 精确匹配）
 * 学校位于永泰县葛岭镇（福永高速沿线），距福州市区约 40 公里。
 * 官方直通车（闽运永泰 + 滴滴站点巴士）到万象九宜城 / 福州南站约 60 分钟、福州站约 80 分钟。
 * 这些线路都是围绕福州校区的，换个城市就没有对应的站点，所以筛选只在福州下提供。
 */
const LINES_CITY = '福州';

const LINES = [
  { id: 'all', label: '全部' },
  { id: '永泰站', label: '永泰站' },
  { id: '福州站', label: '福州站' },
  { id: '福州南站', label: '福州南站' },
  { id: '长乐机场', label: '长乐机场' },
  { id: '市区', label: '市区' },
  { id: '汽车站', label: '汽车站' }
];

/**
 * 上下车点，按分类分组。
 * corridor 用于把行程归到某条线路，方便筛选。
 */
const PLACE_GROUPS = [
  {
    name: '学校周边',
    items: [
      { name: '福州工商学院（南门）', corridor: '校内' },
      { name: '福州工商学院（北门）', corridor: '校内' },
      { name: '葛岭九老公交站', corridor: '校内' },
      { name: '葛岭大名城', corridor: '校内' }
    ]
  },
  {
    name: '火车站 / 机场',
    items: [
      { name: '永泰站（动车站）', corridor: '永泰站' },
      { name: '福州站', corridor: '福州站' },
      { name: '福州南站', corridor: '福州南站' },
      { name: '福州长乐国际机场', corridor: '长乐机场' }
    ]
  },
  {
    name: '市区落脚点',
    items: [
      { name: '东街口', corridor: '市区' },
      { name: '三坊七巷', corridor: '市区' },
      { name: '五一广场', corridor: '市区' },
      { name: '苏宁广场', corridor: '市区' },
      { name: '万象九宜城（苏万宝·宁化地铁站）', corridor: '市区' },
      { name: '仓山万达', corridor: '市区' },
      { name: '台屿地铁站（台屿公交站）', corridor: '市区' },
      { name: '浦上爱琴海', corridor: '市区' },
      { name: '金山公交总站', corridor: '市区' }
    ]
  },
  {
    name: '汽车站',
    items: [
      { name: '福州汽车北站', corridor: '汽车站' },
      { name: '福州汽车西站（闽侯上街）', corridor: '汽车站' }
    ]
  }
];

const CORRIDOR_LABEL = {};
PLACE_GROUPS.forEach(function (g) {
  g.items.forEach(function (item) {
    CORRIDOR_LABEL[item.name] = item.corridor;
  });
});

/**
 * 发布页「常用站点」快捷胶囊：从上面的站点表里挑出最常当起终点的几个。
 * 只做一点即填的快捷方式，用户照样可以手打任意地点——地图选点接口没开通，
 * 手打是唯一的兜底路径。名字必须和站点表完全一致，否则 resolveCorridor
 * 匹配不上，行程归不进线路，首页的线路筛选就会漏掉它。
 */
const HOT_PLACES = [
  '福州工商学院（南门）',
  '福州工商学院（北门）',
  '葛岭九老公交站',
  '永泰站（动车站）',
  '福州站',
  '福州南站',
  '福州长乐国际机场'
];

// offset 为相对今天的天数，保证本地演示数据的日期始终是"最近几天"
// male / female 为车上现有人数（含发布者）；seats 为可带人数
const SEED = [
  {
    id: 's1',
    from: '福州工商学院（南门）',
    to: '永泰站（动车站）',
    corridor: '永泰站',
    offset: 1,
    time: '08:00',
    seats: 3,
    totalPrice: 45,
    male: 1,
    female: 2,
    note: '赶 09:12 的动车，走 203 省道，十分钟到站。',
    owner: '林同学',
    verified: true
  },
  {
    id: 's2',
    from: '福州工商学院（北门）',
    to: '福州站',
    corridor: '福州站',
    offset: 1,
    time: '07:30',
    seats: 3,
    totalPrice: 75,
    male: 2,
    female: 1,
    note: '葛岭上福永高速，后备箱可放两个行李箱。',
    owner: '陈同学',
    verified: true
  },
  {
    id: 's3',
    from: '福州工商学院（南门）',
    to: '福州南站',
    corridor: '福州南站',
    offset: 1,
    time: '09:00',
    seats: 2,
    totalPrice: 60,
    male: 0,
    female: 2,
    note: '高速直达，赶 11 点前的高铁。',
    owner: '王同学',
    verified: true
  },
  {
    id: 's4',
    from: '福州工商学院（北门）',
    to: '福州长乐机场',
    corridor: '长乐机场',
    offset: 2,
    time: '05:30',
    seats: 3,
    totalPrice: 135,
    male: 3,
    female: 0,
    note: '赶早班机，走机场高速，准时出发不等人。',
    owner: '张同学',
    verified: false
  },
  {
    id: 's5',
    from: '福州工商学院（南门）',
    to: '东街口',
    corridor: '市区',
    offset: 2,
    time: '10:00',
    seats: 2,
    totalPrice: 50,
    male: 1,
    female: 1,
    note: '送到东街口地铁站，可顺路到三坊七巷。',
    owner: '刘同学',
    verified: true
  },
  {
    id: 's6',
    from: '葛岭九老公交站',
    to: '福州南站',
    corridor: '福州南站',
    offset: 2,
    time: '13:30',
    seats: 4,
    totalPrice: 120,
    male: 2,
    female: 2,
    note: '在九老上车，高速直达南站。',
    owner: '赵同学',
    verified: true
  },
  {
    id: 's7',
    from: '福州工商学院（北门）',
    to: '万象九宜城（苏万宝·宁化地铁站）',
    corridor: '市区',
    offset: 3,
    time: '15:00',
    seats: 2,
    totalPrice: 50,
    male: 0,
    female: 1,
    note: '送到万象九宜城，地铁 2 号线宁化站换乘方便。',
    owner: '孙同学',
    verified: true
  },
  {
    id: 's8',
    from: '福州工商学院（南门）',
    to: '仓山万达',
    corridor: '市区',
    offset: 3,
    time: '16:30',
    seats: 3,
    totalPrice: 90,
    male: 1,
    female: 2,
    note: '周末去万达，可等 15 分钟。',
    owner: '周同学',
    verified: true
  },
  {
    id: 's9',
    from: '福州工商学院（南门）',
    to: '永泰站（动车站）',
    corridor: '永泰站',
    offset: 6,
    time: '07:00',
    seats: 3,
    totalPrice: 45,
    male: 2,
    female: 1,
    note: '早班动车，十分钟到站。',
    owner: '吴同学',
    verified: true
  },
  {
    id: 's10',
    from: '福州南站',
    to: '福州工商学院（南门）',
    corridor: '福州南站',
    offset: 7,
    time: '18:00',
    seats: 3,
    totalPrice: 90,
    male: 1,
    female: 2,
    note: '周日晚返校，出站后 B 出口集合。',
    owner: '郑同学',
    verified: true
  },
  {
    id: 's11',
    from: '福州站',
    to: '福州工商学院（北门）',
    corridor: '福州站',
    offset: 7,
    time: '19:30',
    seats: 2,
    totalPrice: 50,
    male: 2,
    female: 0,
    note: '返校顺路，可等 20 分钟。',
    owner: '黄同学',
    verified: false
  },
  {
    id: 's12',
    from: '福州工商学院（北门）',
    to: '福州汽车北站',
    corridor: '汽车站',
    offset: 7,
    time: '06:30',
    seats: 3,
    totalPrice: 75,
    male: 1,
    female: 1,
    note: '到北站坐长途车，同路的可以拼。',
    owner: '何同学',
    verified: true
  },
  {
    id: 's13',
    from: '福州工商学院（南门）',
    to: '浦上爱琴海',
    corridor: '市区',
    offset: 10,
    time: '14:00',
    seats: 2,
    totalPrice: 60,
    male: 0,
    female: 1,
    note: '顺路，福永高速转三环。',
    owner: '徐同学',
    verified: true
  },
  {
    id: 's14',
    from: '福州工商学院（北门）',
    to: '福州长乐机场',
    corridor: '长乐机场',
    offset: 10,
    time: '06:00',
    seats: 3,
    totalPrice: 135,
    male: 2,
    female: 1,
    note: '早班机，行李多也没问题。',
    owner: '马同学',
    verified: true
  },
  {
    id: 's15',
    from: '福州工商学院（南门）',
    to: '台屿地铁站（台屿公交站）',
    corridor: '市区',
    offset: 4,
    time: '09:30',
    seats: 3,
    totalPrice: 75,
    male: 1,
    female: 1,
    note: '福永高速转三环，台屿地铁 A 口下车。',
    owner: '许同学',
    verified: true
  },
  {
    id: 's16',
    from: '福州汽车西站（闽侯上街）',
    to: '福州工商学院（北门）',
    corridor: '汽车站',
    offset: 5,
    time: '17:00',
    seats: 3,
    totalPrice: 90,
    male: 2,
    female: 1,
    note: '从汽车西站返校，南屿上福永高速，行李可放后备箱。',
    owner: '林同学',
    verified: false
  }
];

function pad(n) {
  return String(n).length < 2 ? '0' + n : String(n);
}

function dateFromOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function dateLabel(dateStr) {
  const d = new Date(String(dateStr).replace(/-/g, '/') + ' 00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  const base = d.getMonth() + 1 + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
  if (diff === 0) return '今天 · ' + base;
  if (diff === 1) return '明天 · ' + base;
  if (diff === 2) return '后天 · ' + base;
  return base;
}

function daysUntil(dateStr) {
  const d = new Date(String(dateStr).replace(/-/g, '/') + ' 00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

const FAR_DAYS = 7;

/**
 * 出发日还很远时给一句醒目提示。
 * 日期默认只写「X月X日」，跨月之后很容易被误读成近期，所以额外标出还有多久。
 * 7 天内属于常态（今天 / 明天 / 后天 / 本周），不打扰。
 * 两个月以内一律按天写，精确且不会因为取整把 45 天说成「2 个月」。
 */
function farLabel(dateStr) {
  const days = daysUntil(dateStr);
  if (days < FAR_DAYS) return '';
  if (days < 60) return days + ' 天后';
  return Math.round(days / 30) + ' 个月后';
}

function normTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return '23:59';
  return pad(Number(m[1])) + ':' + m[2];
}

function nowStamp() {
  const d = new Date();
  return dateFromOffset(0) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * 出发时间已过即视为结束，按「YYYY-MM-DD HH:mm」字符串比较（补零后可直接比大小）。
 */
function isExpired(date, time) {
  if (!date) return false;
  return String(date) + ' ' + normTime(time) < nowStamp();
}

/**
 * 根据起终点推断这条行程属于哪条线路。
 * 一端是校内时，取另一端；两端都不是校内时，取出发地。
 */
function resolveCorridor(from, to) {
  const a = CORRIDOR_LABEL[from] || '其他';
  const b = CORRIDOR_LABEL[to] || '其他';
  if (a === '校内' && b !== '校内') return b;
  if (b === '校内' && a !== '校内') return a;
  return a;
}

/**
 * 金额保留一位小数，整数不补 .0（45 → "45"，50/3 → "16.7"）。
 */
function money(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * 人均 = 总价 ÷ 可带人数（车主不参与分摊）。
 */
function perPersonOf(totalPrice, seats) {
  const total = Number(totalPrice) || 0;
  const n = Number(seats) || 0;
  if (total <= 0 || n <= 0) return 0;
  return total / n;
}

function countOf(v) {
  return Math.max(Math.floor(Number(v) || 0), 0);
}

/**
 * 车上男女构成文案，如 "2男1女"；都为 0 时返回空串（卡片上不显示）。
 */
function genderTextOf(male, female) {
  const m = countOf(male);
  const f = countOf(female);
  if (m + f === 0) return '';
  const parts = [];
  if (m > 0) parts.push(m + '男');
  if (f > 0) parts.push(f + '女');
  return parts.join('');
}

function genderLabel(g) {
  if (g === 'male') return '男';
  if (g === 'female') return '女';
  return '未填写';
}

const GENDER_LIMIT_TEXT = { male: '仅限男生', female: '仅限女生' };

/**
 * 性别要求的展示文案；不限时返回空串，卡片上就不显示角标。
 */
function genderLimitTextOf(limit) {
  return GENDER_LIMIT_TEXT[limit] || '';
}

/**
 * 申请人是否被这条行程的性别要求挡住。
 * 限性别时未填性别的用户同样不放行——宁可拦住，也不放进不确定的人。
 */
function genderLimitBlocks(limit, gender) {
  if (limit !== 'male' && limit !== 'female') return false;
  return gender !== limit;
}

function genderLimitError(limit) {
  return limit === 'male' ? '该行程仅限男生乘坐' : '该行程仅限女生乘坐';
}

/* ---------------- 城市与定位 ---------------- */

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

/**
 * 当前城市：用户手动选过的优先，否则用默认城市。
 * 首页每次进入都先读它渲染，定位成功后再异步纠正。
 */
function getCity() {
  const saved = String(wx.getStorageSync(CITY_KEY) || '').trim();
  return saved || DEFAULT_CITY;
}

function setCity(name) {
  const c = normCity(name);
  if (!c) return getCity();
  wx.setStorageSync(CITY_KEY, c);
  return c;
}

// 上次定位解析出的区县；没定位过、解析失败、用户拒绝授权都是空串
function getDistrict() {
  return String(wx.getStorageSync(DISTRICT_KEY) || '').trim();
}

/**
 * 学校所在的城市与区县。模糊定位只有千米级精度（实测误差可达 6 公里），
 * 具体上下车点根本定位不出来，但区县这一级是准的，所以拿它当「人在不在学校这边」
 * 的近似判据。学校在福州市永泰县葛岭镇。
 */
const SCHOOL_CITY = '福州';
const SCHOOL_DISTRICT = '永泰县';
const SCHOOL_PLACE = '福州工商学院（南门）';

/**
 * 发布页的出发地预填：人在学校所在区县就填学校门口，否则返回空串。
 * 宁可空着让用户自己填，也不要瞎填一个假地点——填错了用户未必会注意到。
 */
function schoolPlaceIfNearby() {
  if (getCity() !== SCHOOL_CITY) return '';
  return getDistrict() === SCHOOL_DISTRICT ? SCHOOL_PLACE : '';
}

/**
 * 「选择城市」页的数据：按拼音首字母分组，组内按拼音升序。
 * located 是当前定位到的城市，单独放在页面最上面，不重复出现在 A-Z 里。
 * 定位到列表外的城市（比如某个地级市）时它只会出现在顶部，列表保持完整。
 */
function cityGroups(located) {
  const loc = normCity(located);
  const order = [];
  const bucket = {};
  CITIES.forEach(function (name) {
    const py = CITY_PINYIN[name] || '';
    const letter = (py.charAt(0) || '#').toUpperCase();
    if (!bucket[letter]) {
      bucket[letter] = [];
      order.push(letter);
    }
    bucket[letter].push({ name: name, py: py });
  });
  order.sort();
  return order
    .map(function (letter) {
      return {
        letter: letter,
        cities: bucket[letter]
          .filter(function (c) { return c.name !== loc; })
          .sort(function (a, b) { return a.py < b.py ? -1 : (a.py > b.py ? 1 : 0); })
          .map(function (c) {
            return { name: c.name };
          })
      };
    })
    .filter(function (g) { return g.cities.length > 0; });
}

/**
 * 逆地址解析：经纬度 → { city, district }。
 * 请求转交云函数（action=locateCity）代发，所以小程序端不需要把
 * apis.map.qq.com 加进 request 合法域名，腾讯的 key 也只存在云函数环境变量里。
 * 云函数没配 key、解析不出、调用失败，一律返回空值，由调用方降级为「手动选城市」。
 */
function reverseCity(lat, lng) {
  if (!cloudReady()) return Promise.resolve({ city: '', district: '' });
  return call('locateCity', { latitude: lat, longitude: lng })
    .then(function (res) {
      const d = (res && res.data) || {};
      return { city: normCity(d.city), district: String(d.district || '') };
    })
    .catch(function () { return { city: '', district: '' }; });
}

/**
 * 取当前位置。用模糊定位（约城市级），判断城市足够了，权限也比精确位置轻。
 * 该接口不支持 Promise 风格调用，所以这里手工包一层。
 * 和 getLocation（精确位置）互斥，两者只能声明一个，所以不回退到 getLocation。
 * 用户拒绝过授权后微信会记住结果，后续调用直接失败，不会反复弹窗。
 */
function getPosition() {
  return new Promise(function (resolve, reject) {
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: function (res) {
        resolve({ latitude: res.latitude, longitude: res.longitude });
      },
      fail: reject
    });
  });
}

/**
 * 自动定位到所在城市。任何一步失败（没授权、没 key、解析不出）都返回当前城市，
 * 保证首页永远有内容可展示。解析出的区县顺手缓存下来，给发布页预填用。
 *
 * config.autoLocate 为 false 时整个跳过，连接口都不调：源码里只要留着该接口的
 * 调用，上传 / 提审就会被隐私接口检测拦下（错误码 61040），那种情况下必须连调用
 * 一起摘掉，只加开关没用。
 */
function locateCity() {
  if (!AUTO_LOCATE) return Promise.resolve(getCity());
  return getPosition()
    .then(function (pos) { return reverseCity(pos.latitude, pos.longitude); })
    .then(function (geo) {
      if (geo.district) wx.setStorageSync(DISTRICT_KEY, geo.district);
      if (!geo.city) return getCity();
      wx.setStorageSync(CITY_KEY, geo.city);
      return geo.city;
    })
    .catch(function () { return getCity(); });
}

/**
 * 把「城市 → 条数」的原始表归一化：城市名统一口径后合并，
 * 老数据没有 city 字段（云端返回空键）折算成默认城市，与列表的兜底保持一致。
 */
function normCounts(raw) {
  const out = {};
  Object.keys(raw || {}).forEach(function (key) {
    const city = normCity(key) || DEFAULT_CITY;
    out[city] = (out[city] || 0) + (Number(raw[key]) || 0);
  });
  return out;
}

/**
 * 各城市「当前可报名行程数」。只用于城市页标出有车 / 没车，
 * 取不到时调用方按「未知」处理，不猜成 0，避免误报成整片没车。
 */
function getCityCounts(options) {
  const ttl = (options && options.ttl) || 0;
  const hit = cached(countsCache, ttl);
  if (hit) return Promise.resolve(hit);

  const p = !cloudReady()
    ? Promise.resolve(localCityCounts())
    : call('cityCounts', {}).then(function (res) {
        return normCounts((res.data && res.data.counts) || {});
      });
  if (!ttl) return p;
  return p.then(function (counts) {
    countsCache = { at: Date.now(), value: counts };
    return counts;
  });
}

function idOf(t) {
  return t._id || t.id;
}

/**
 * 剩余座位：老数据没有 seatsLeft 字段时按可带人数处理。
 */
function seatsLeftOf(t) {
  const seats = countOf(t.seats);
  return t.seatsLeft === undefined || t.seatsLeft === null ? seats : countOf(t.seatsLeft);
}

function decorate(t) {
  const date = t.date || dateFromOffset(t.offset || 0);
  const totalPrice = Number(t.totalPrice) || 0;
  const seats = countOf(t.seats);
  const seatsLeft = seatsLeftOf(t);
  const perPerson = perPersonOf(totalPrice, seats);
  const male = countOf(t.male);
  const female = countOf(t.female);
  const expired = isExpired(date, t.time);
  const far = expired ? '' : farLabel(date);
  return {
    id: idOf(t),
    from: t.from,
    to: t.to,
    city: t.city || DEFAULT_CITY,
    corridor: t.corridor || resolveCorridor(t.from, t.to),
    date: date,
    dateLabel: dateLabel(date),
    farText: far,
    far: !!far,
    time: t.time,
    seats: seats,
    seatsLeft: seatsLeft,
    status: seatsLeft > 0 ? 'open' : 'full',
    full: seatsLeft <= 0,
    expired: expired,
    stateText: expired ? '已结束' : (seatsLeft > 0 ? '剩 ' + seatsLeft + ' 座' : '已满员'),
    totalPrice: totalPrice,
    perPerson: perPerson,
    totalText: totalPrice > 0 ? '¥' + money(totalPrice) : '面议',
    perText: perPerson > 0 ? '¥' + money(perPerson) : '面议',
    male: male,
    female: female,
    genderText: genderTextOf(male, female),
    note: t.note || '',
    owner: t.owner || '同学',
    ownerKey: t.ownerKey || '',
    ownerGender: t.ownerGender || '',
    genderLimit: t.genderLimit === 'male' || t.genderLimit === 'female' ? t.genderLimit : 'any',
    genderLimitText: genderLimitTextOf(t.genderLimit),
    verified: !!t.verified,
    mine: !!t.mine,
    myJoin: t.myJoin || null
  };
}

const JOIN_STATUS_TEXT = { approved: '已同意', rejected: '已拒绝', cancelled: '已撤回' };

function decorateJoin(j) {
  return {
    id: idOf(j),
    tripId: j.tripId,
    openid: j._openid || j.openid,
    gender: j.gender || '',
    genderText: genderLabel(j.gender),
    status: j.status || 'pending',
    statusText: JOIN_STATUS_TEXT[j.status] || '待同意',
    name: j.name || '同学',
    createdAt: j.createdAt || 0
  };
}

/**
 * 已作废的申请（被拒绝 / 主动撤回）不计入「已申请」。
 */
function joinActive(j) {
  return j.status !== 'rejected' && j.status !== 'cancelled';
}

/**
 * 对外展示名。用户只填一个姓，展示时统一拼成「林同学」，不暴露全名。
 */
function displayNameOf(surname) {
  const s = String(surname === undefined || surname === null ? '' : surname).trim();
  return s ? s + '同学' : '';
}

function normSurname(value) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, 2);
}

/* ---------------- 本地模式 ---------------- */

/**
 * 本地登录态存在 ME_KEY 里。填过姓即视为已登录，openid 生成后固定不变，
 * 这样重启小程序后仍然是同一个用户，能看到自己发布 / 报名的行程。
 */
function localMe() {
  let me = wx.getStorageSync(ME_KEY);
  if (!me || !me.openid) {
    me = { openid: 'local-' + Date.now(), surname: '', avatarUrl: '', gender: '', verified: false, verifyStatus: 'none' };
    wx.setStorageSync(ME_KEY, me);
  }
  return decorateMe(me);
}

function decorateMe(me) {
  const next = Object.assign({}, me);
  next.displayName = displayNameOf(next.surname);
  next.loggedIn = !!String(next.surname || '').trim();
  next.gender = next.gender === 'male' || next.gender === 'female' ? next.gender : '';
  next.genderText = genderLabel(next.gender);
  // 学生认证通过后，性别以后台标注为准，个人资料里锁死不可改
  next.genderLocked = !!next.verified;
  return next;
}

function localSaveProfile(payload) {
  localMe();
  const stored = wx.getStorageSync(ME_KEY);
  stored.surname = normSurname(payload.surname);
  stored.avatarUrl = payload.avatarUrl || '';
  if (!stored.verified) {
    stored.gender = payload.gender === 'male' || payload.gender === 'female' ? payload.gender : '';
  }
  stored.updatedAt = Date.now();
  wx.setStorageSync(ME_KEY, stored);
  return decorateMe(stored);
}

/**
 * 退出登录：只清掉「姓 + 头像」这两项登录资料，openid 保持不变。
 * 行程、报名、拉黑记录都是按 openid 挂的，换个 openid 会让它们变成无主的孤儿。
 */
function localLogout() {
  localMe();
  const stored = wx.getStorageSync(ME_KEY);
  stored.surname = '';
  stored.avatarUrl = '';
  stored.updatedAt = Date.now();
  wx.setStorageSync(ME_KEY, stored);
  return decorateMe(stored);
}

/**
 * 本地模式下发布者的稳定标识。拉黑的去重与过滤都按它走，
 * 不再按展示名（同姓会串）。
 */
function ownerKeyOf(t) {
  if (!t) return '';
  if (t.ownerKey) return t.ownerKey;
  return t.mine ? 'me' : 'seed:' + (t.owner || '');
}

/**
 * 被拉黑者的对外短标识：标识串单向散列取 6 位，仅用于区分同姓用户。
 */
function shortId(key) {
  const s = String(key || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ('000000' + h.toString(36).toUpperCase()).slice(-6);
}

function localAll() {
  const mine = wx.getStorageSync(TRIP_KEY) || [];
  const all = SEED.map(function (t) {
    return Object.assign({}, t, { date: dateFromOffset(t.offset), city: t.city || DEFAULT_CITY });
  }).concat(mine);
  all.forEach(function (t) { t.ownerKey = ownerKeyOf(t); });
  all.sort(function (a, b) {
    return (a.date + a.time).localeCompare(b.date + b.time);
  });
  return all;
}

function localQuery(corridor, skip, limit, city) {
  const blocked = localBlockedKeys();
  const want = city || getCity();
  let list = localAll().filter(function (t) {
    if (!t.mine && blocked.indexOf(t.ownerKey) >= 0) return false;
    if ((t.city || DEFAULT_CITY) !== want) return false;
    return seatsLeftOf(t) > 0 && !isExpired(t.date || dateFromOffset(t.offset || 0), t.time);
  });
  if (corridor && corridor !== 'all') {
    list = list.filter(function (t) {
      return (t.corridor || resolveCorridor(t.from, t.to)) === corridor;
    });
  }
  return list.slice(skip, skip + limit).map(decorate);
}

/**
 * 各城市可报名行程数（本地演示模式）。口径与 localQuery 一致：
 * 未发车、还有座位、排除我拉黑的人。
 */
function localCityCounts() {
  const blocked = localBlockedKeys();
  const counts = {};
  localAll().forEach(function (t) {
    if (!t.mine && blocked.indexOf(t.ownerKey) >= 0) return;
    const date = t.date || dateFromOffset(t.offset || 0);
    if (seatsLeftOf(t) <= 0 || isExpired(date, t.time)) return;
    const city = t.city || DEFAULT_CITY;
    counts[city] = (counts[city] || 0) + 1;
  });
  return counts;
}

function localGetById(id) {
  const found = localAll().filter(function (t) { return idOf(t) === id; })[0];
  if (!found) return null;
  if (!found.mine && localBlockedKeys().indexOf(found.ownerKey) >= 0) return null;

  const d = decorate(found);
  if (d.mine) {
    d.myJoin = null;
  } else {
    const me = localMe();
    const j = localJoins().filter(function (x) {
      return x.tripId === id && x.openid === me.openid && joinActive(x);
    })[0];
    d.myJoin = j ? { id: j.id, status: j.status } : null;
  }
  return d;
}

function localMine() {
  return localAll().filter(function (t) { return t.mine === true; }).map(decorate);
}

function localAdd(trip) {
  const me = localMe();
  if (!me.surname) throw new Error('请先完善资料后再发布');
  const list = wx.getStorageSync(TRIP_KEY) || [];
  const seats = countOf(trip.seats);
  const gender = trip.ownerGender === 'female' ? 'female' : (trip.ownerGender === 'male' ? 'male' : '');
  const item = Object.assign({}, trip, {
    id: 'u' + Date.now(),
    mine: true,
    city: normCity(trip.city) || getCity(),
    ownerKey: 'me:' + me.openid,
    genderLimit: trip.genderLimit === 'male' || trip.genderLimit === 'female' ? trip.genderLimit : 'any',
    seats: seats,
    seatsLeft: seats,
    status: 'open',
    male: gender === 'male' ? 1 : 0,
    female: gender === 'female' ? 1 : 0,
    owner: displayNameOf(me.surname),
    verified: !!me.verified
  });
  list.push(item);
  wx.setStorageSync(TRIP_KEY, list);
  return decorate(item);
}

function localRemove(id) {
  const list = wx.getStorageSync(TRIP_KEY) || [];
  const next = list.filter(function (t) { return t.id !== id; });
  if (next.length === list.length) throw new Error('只能删除自己发布的行程');
  wx.setStorageSync(TRIP_KEY, next);
  const joins = (wx.getStorageSync(JOIN_KEY) || []).filter(function (j) { return j.tripId !== id; });
  wx.setStorageSync(JOIN_KEY, joins);
}

function localJoins() {
  return wx.getStorageSync(JOIN_KEY) || [];
}

function localJoin(tripId) {
  const me = localMe();
  if (!me.surname) throw new Error('请先完善资料后再申请');
  const trip = localGetById(tripId);
  if (!trip) throw new Error('行程不存在');
  if (trip.mine) throw new Error('不能申请自己发布的行程');
  if (localBlockedKeys().indexOf(trip.ownerKey) >= 0) throw new Error('无法申请该行程');
  if (genderLimitBlocks(trip.genderLimit, me.gender)) throw new Error(genderLimitError(trip.genderLimit));
  if (trip.expired) throw new Error('该行程已结束');
  if (trip.seatsLeft <= 0) throw new Error('该行程已满员');

  const joins = localJoins();
  const dup = joins.filter(function (j) {
    return j.tripId === tripId && j.openid === me.openid && joinActive(j);
  })[0];
  if (dup) throw new Error('你已经申请过了，等待发布者同意');

  const join = {
    id: 'j' + Date.now(),
    tripId: tripId,
    openid: me.openid,
    gender: me.gender || '',
    status: 'pending',
    name: displayNameOf(me.surname),
    createdAt: Date.now()
  };
  joins.push(join);
  wx.setStorageSync(JOIN_KEY, joins);
  return decorateJoin(join);
}

function localApplyApproved(tripId, gender) {
  const list = wx.getStorageSync(TRIP_KEY) || [];
  const t = list.filter(function (x) { return x.id === tripId; })[0];
  if (!t) return;
  t.seatsLeft = Math.max(seatsLeftOf(t) - 1, 0);
  if (gender === 'male') t.male = countOf(t.male) + 1;
  if (gender === 'female') t.female = countOf(t.female) + 1;
  t.status = t.seatsLeft > 0 ? 'open' : 'full';
  wx.setStorageSync(TRIP_KEY, list);
}

function localDecideJoin(joinId, approve) {
  const joins = localJoins();
  const j = joins.filter(function (x) { return x.id === joinId; })[0];
  if (!j) throw new Error('申请不存在');
  if (j.status !== 'pending') throw new Error('该申请已处理过');
  j.status = approve ? 'approved' : 'rejected';
  j.updatedAt = Date.now();
  wx.setStorageSync(JOIN_KEY, joins);
  if (approve) localApplyApproved(j.tripId, j.gender);
  return decorateJoin(j);
}

function localTripJoins(tripId) {
  return localJoins()
    .filter(function (j) { return j.tripId === tripId; })
    .map(decorateJoin);
}

function localMyJoins() {
  const me = localMe();
  const all = localAll();
  return localJoins()
    .filter(function (j) { return j.openid === me.openid && joinActive(j); })
    .map(function (j) {
      const t = all.filter(function (x) { return idOf(x) === j.tripId; })[0];
      if (!t) return null;
      return Object.assign(decorate(t), {
        joinId: j.id,
        myJoinStatus: j.status,
        myJoinStatusText: j.status === 'approved' ? '已同意' : '待同意'
      });
    })
    .filter(Boolean);
}

/**
 * 撤回自己还未被处理的申请；撤回后可重新申请。
 */
function localCancelJoin(joinId) {
  const me = localMe();
  const joins = localJoins();
  const j = joins.filter(function (x) { return x.id === joinId; })[0];
  if (!j) throw new Error('申请不存在');
  if (j.openid !== me.openid) throw new Error('只能撤回自己的申请');
  if (j.status !== 'pending') throw new Error('发布者已处理，无法撤回');
  j.status = 'cancelled';
  j.updatedAt = Date.now();
  wx.setStorageSync(JOIN_KEY, joins);
  return decorateJoin(j);
}

/* ---------------- 举报 / 拉黑 ---------------- */

/**
 * 拉黑记录展示：主行是「林同学」+ 短标识，副行是备注和拉黑时的行程快照，
 * 用来区分同姓用户。
 */
function decorateBlock(b) {
  const date = b.tripDate ? String(b.tripDate).slice(5) : '';
  const tripText = date && b.from && b.to
    ? date + ' ' + (b.tripTime || '') + ' · ' + b.from + ' → ' + b.to
    : '';

  const subs = [];
  if (b.remark) subs.push('备注 · ' + b.remark);
  if (tripText) subs.push(tripText);

  return {
    id: idOf(b),
    name: b.name || '同学',
    uid: b.uid || shortId(b.ownerKey || b.blockedOpenid || b.name),
    subs: subs,
    createdAt: b.createdAt || 0
  };
}

function localBlocks() {
  return wx.getStorageSync(BLOCK_KEY) || [];
}

function localBlockedKeys() {
  return localBlocks().map(function (b) { return b.ownerKey || b.name; });
}

function localReport(tripId, reason, detail) {
  const trip = localGetById(tripId);
  if (!trip) throw new Error('行程不存在');
  if (trip.mine) throw new Error('不能举报自己发布的行程');
  if (!reason) throw new Error('请选择举报原因');

  const list = wx.getStorageSync(REPORT_KEY) || [];
  const dup = list.filter(function (r) {
    return r.tripId === tripId && r.status === 'pending';
  })[0];
  if (dup) throw new Error('你已举报过该行程，我们会尽快处理');

  const item = {
    id: 'r' + Date.now(),
    tripId: tripId,
    owner: trip.owner,
    reason: reason,
    detail: detail || '',
    status: 'pending',
    createdAt: Date.now()
  };
  list.push(item);
  wx.setStorageSync(REPORT_KEY, list);
  return item;
}

function localBlock(tripId, remark) {
  const found = localAll().filter(function (t) { return idOf(t) === tripId; })[0];
  if (!found || found.mine) throw new Error('行程不存在');

  const ownerKey = found.ownerKey || ownerKeyOf(found);
  const list = localBlocks();
  const dup = list.filter(function (b) { return (b.ownerKey || b.name) === ownerKey; })[0];
  if (dup) return decorateBlock(dup);

  const item = {
    id: 'b' + Date.now(),
    ownerKey: ownerKey,
    name: found.owner || '同学',
    uid: shortId(ownerKey),
    remark: (remark || '').slice(0, 20),
    from: found.from || '',
    to: found.to || '',
    tripDate: found.date || '',
    tripTime: found.time || '',
    createdAt: Date.now()
  };
  list.push(item);
  wx.setStorageSync(BLOCK_KEY, list);
  return decorateBlock(item);
}

function localUnblock(blockId) {
  const list = localBlocks();
  const next = list.filter(function (b) { return idOf(b) !== blockId; });
  if (next.length === list.length) throw new Error('记录不存在');
  wx.setStorageSync(BLOCK_KEY, next);
}

function localMyBlocks() {
  return localBlocks()
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
    .map(decorateBlock);
}

/* ---------------- 学生认证 ---------------- */

const VERIFY_TYPE_TEXT = { chsi: '学信网截图', studentcard: '学生证照片' };
const VERIFY_STATUS_TEXT = { pending: '审核中', approved: '已认证', rejected: '已驳回' };

function decorateVerify(v) {
  return {
    id: idOf(v),
    type: v.type === 'chsi' ? 'chsi' : 'studentcard',
    typeText: VERIFY_TYPE_TEXT[v.type] || VERIFY_TYPE_TEXT.studentcard,
    imageFileID: v.imageFileID || '',
    code: v.code || '',
    note: v.note || '',
    status: v.status || 'pending',
    statusText: VERIFY_STATUS_TEXT[v.status] || '审核中',
    reason: v.reason || '',
    createdAt: v.createdAt || 0
  };
}

function localVerifications() {
  return wx.getStorageSync(VERIFY_KEY) || [];
}

function localSubmitVerify(payload) {
  const me = localMe();
  if (me.verified) throw new Error('你已经完成认证');

  const list = localVerifications();
  const pending = list.filter(function (v) {
    return v.openid === me.openid && v.status === 'pending';
  })[0];
  if (pending) throw new Error('已有待审核的申请，请等待审核');

  const item = {
    id: 'v' + Date.now(),
    openid: me.openid,
    type: payload.type === 'chsi' ? 'chsi' : 'studentcard',
    imageFileID: payload.imageFileID || '',
    code: payload.code || '',
    note: payload.note || '',
    status: 'pending',
    reason: '',
    createdAt: Date.now()
  };
  list.push(item);
  wx.setStorageSync(VERIFY_KEY, list);

  const stored = wx.getStorageSync(ME_KEY) || {};
  stored.verifyStatus = 'pending';
  wx.setStorageSync(ME_KEY, stored);
  return decorateVerify(item);
}

function localMyVerify() {
  const me = localMe();
  const list = localVerifications()
    .filter(function (v) { return v.openid === me.openid; })
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return list.length ? decorateVerify(list[0]) : null;
}

/**
 * 上传头像。头像只在个人主页展示，不会随行程下发给其他用户。
 * chooseAvatar 给到的是临时路径，重启后就会失效，所以必须转存：
 * 云开发模式存到云存储拿 fileID，本地模式存到用户目录拿持久路径。
 */
function uploadAvatar(filePath) {
  if (!filePath) return Promise.resolve('');

  if (cloudReady()) {
    if (/^cloud:\/\//.test(String(filePath))) return Promise.resolve(filePath);
    const ext = (String(filePath).split('.').pop() || 'png').split('?')[0];
    const cloudPath = 'avatar/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext;
    return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath })
      .then(function (res) { return res.fileID; });
  }

  const path = String(filePath);
  if (/^https?:\/\//.test(path) || path.indexOf(wx.env.USER_DATA_PATH) === 0) {
    return Promise.resolve(path);
  }

  return new Promise(function (resolve) {
    const ext = (path.split('.').pop() || 'png').split('?')[0];
    wx.getFileSystemManager().saveFile({
      tempFilePath: path,
      filePath: wx.env.USER_DATA_PATH + '/avatar-' + Date.now() + '.' + ext,
      success: function (res) { resolve(res.savedFilePath); },
      fail: function () { resolve(path); }
    });
  });
}

/**
 * 保存资料（姓 + 头像 + 性别）。已认证用户的性别由认证后台标注，服务端会忽略传入值。
 */
function saveProfile(payload) {
  bustMe();
  const body = {
    surname: normSurname(payload.surname),
    avatarUrl: payload.avatarUrl || '',
    gender: payload.gender === 'male' || payload.gender === 'female' ? payload.gender : ''
  };
  if (!body.surname) return Promise.reject(new Error('请填写你的姓'));

  if (!cloudReady()) {
    try {
      return Promise.resolve(localSaveProfile(body));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('saveProfile', body).then(function (res) {
    return decorateMe(res.data || {});
  });
}

/**
 * 退出登录。云端模式同样只清资料，openid 由微信侧决定、无法也不应该更换。
 */
function logout() {
  bustMe();
  if (!cloudReady()) {
    try {
      return Promise.resolve(localLogout());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('logout', {}).then(function (res) {
    return decorateMe(res.data || {});
  });
}

/**
 * 需要身份的操作统一走这里：资料未完善则跳登录页，并以 needLogin 中断调用链。
 * 调用方 catch 到 err.needLogin 时不要再弹错误提示，登录页已经在跳了。
 */
function requireProfile() {
  return getMe().then(function (me) {
    if (me && me.loggedIn) return me;
    wx.navigateTo({ url: '/pages/login/login' });
    const err = new Error('请先登录');
    err.needLogin = true;
    throw err;
  });
}

/**
 * 上传认证材料。本地演示模式不做真实上传，直接返回临时路径。
 */
function uploadVerifyImage(filePath) {
  if (!cloudReady()) return Promise.resolve(filePath);

  const ext = (String(filePath).split('.').pop() || 'jpg').split('?')[0];
  const cloudPath = 'verify/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext;
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath })
    .then(function (res) { return res.fileID; });
}

function submitVerify(payload) {
  if (!cloudReady()) {
    try {
      return Promise.resolve(localSubmitVerify(payload));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('verify', payload).then(function (res) { return decorateVerify(res.data); });
}

function getMyVerify() {
  if (!cloudReady()) return Promise.resolve(localMyVerify());
  return call('myVerify', {}).then(function (res) {
    return res.data ? decorateVerify(res.data) : null;
  });
}

/* ---------------- 云端模式 ---------------- */

function cloudReady() {
  return !!(wx.cloud && config.cloudEnv);
}

function isCloudMode() {
  return cloudReady();
}

function call(action, payload) {
  const data = Object.assign({ action: action }, payload || {});
  return wx.cloud.callFunction({ name: config.cloudFunction, data: data })
    .then(function (res) {
      const r = res.result || {};
      if (!r.ok) {
        // 业务错误（如行程不可见）不能被本地回退吞掉，标记后由调用方原样抛出
        const err = new Error(r.error || '云函数执行失败');
        err.business = true;
        throw err;
      }
      return r;
    });
}

/* ---------------- 对外接口（统一返回 Promise） ---------------- */

function getMe(options) {
  const ttl = (options && options.ttl) || 0;
  const hit = cached(meCache, ttl);
  if (hit) return Promise.resolve(hit);

  const p = !cloudReady()
    ? Promise.resolve(localMe())
    : call('login', {}).then(function (res) {
        return decorateMe(res.data || {});
      });
  if (!ttl) return p;
  return p.then(function (me) {
    meCache = { at: Date.now(), value: me };
    return me;
  });
}

function getTrips(options) {
  const opt = options || {};
  const corridor = opt.corridor || 'all';
  const city = opt.city || getCity();
  const skip = opt.skip || 0;
  const limit = opt.limit || PAGE_SIZE;

  if (!cloudReady()) {
    return Promise.resolve(localQuery(corridor, skip, limit, city));
  }

  return call('list', { corridor: corridor, city: city, skip: skip, limit: limit })
    .then(function (res) { return (res.data || []).map(decorate); });
}

function getTripById(id) {
  if (!cloudReady()) {
    return Promise.resolve(localGetById(id));
  }
  return call('detail', { id: id })
    .then(function (res) { return res.data ? decorate(res.data) : null; });
}

function getMyTrips() {
  if (!cloudReady()) {
    return Promise.resolve(localMine());
  }
  return call('mine', {})
    .then(function (res) { return (res.data || []).map(decorate); });
}

function addTrip(trip) {
  bustCounts();
  if (!cloudReady()) {
    return Promise.resolve(localAdd(trip));
  }
  return call('add', trip).then(function (res) { return decorate(res.data); });
}

function removeTrip(id) {
  bustCounts();
  if (!cloudReady()) {
    try {
      localRemove(id);
      return Promise.resolve({ id: id });
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('remove', { id: id });
}

/**
 * 申请加入某条行程。申请人性别取自用户资料（由学生认证后台标注）。
 */
function joinTrip(tripId) {
  bustCounts();
  if (!cloudReady()) {
    try {
      return Promise.resolve(localJoin(tripId));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('join', { tripId: tripId }).then(function (res) {
    return decorateJoin(res.data);
  });
}

/**
 * 我报名的行程（含待同意 / 已同意）。
 */
function getMyJoins() {
  if (!cloudReady()) {
    return Promise.resolve(localMyJoins());
  }
  return call('myJoins', {}).then(function (res) {
    return (res.data || []).map(function (row) {
      return Object.assign(decorate(row.trip), {
        joinId: row.joinId,
        myJoinStatus: row.status,
        myJoinStatusText: row.status === 'approved' ? '已同意' : '待同意'
      });
    });
  });
}

/**
 * 发布者查看某条行程的申请人列表。
 */
function getTripJoins(tripId) {
  if (!cloudReady()) {
    return Promise.resolve(localTripJoins(tripId));
  }
  return call('tripJoins', { tripId: tripId }).then(function (res) {
    return (res.data || []).map(decorateJoin);
  });
}

/**
 * 发布者同意 / 拒绝上车申请。同意后座位 −1，车上男女人数自动 +1。
 */
function decideJoin(joinId, approve) {
  bustCounts();
  if (!cloudReady()) {
    try {
      return Promise.resolve(localDecideJoin(joinId, approve));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('decideJoin', { joinId: joinId, approve: !!approve }).then(function (res) {
    return decorateJoin(res.data);
  });
}

/**
 * 撤回自己还没被处理的申请。
 */
function cancelJoin(joinId) {
  bustCounts();
  if (!cloudReady()) {
    try {
      return Promise.resolve(localCancelJoin(joinId));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('cancelJoin', { joinId: joinId }).then(function (res) {
    return decorateJoin(res.data);
  });
}

/**
 * 举报某条行程。
 */
function reportTrip(tripId, reason, detail) {
  if (!cloudReady()) {
    try {
      return Promise.resolve(localReport(tripId, reason, detail));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('report', { tripId: tripId, reason: reason, detail: detail || '' })
    .then(function (res) { return res.data; });
}

/**
 * 拉黑行程发布人，之后双方行程互不可见。remark 为用户自填的备注。
 */
function blockOwner(tripId, remark) {
  bustCounts();
  if (!cloudReady()) {
    try {
      return Promise.resolve(localBlock(tripId, remark));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('block', { tripId: tripId, remark: remark || '' })
    .then(function (res) { return decorateBlock(res.data); });
}

function unblockUser(blockId) {
  bustCounts();
  if (!cloudReady()) {
    try {
      localUnblock(blockId);
      return Promise.resolve({ id: blockId });
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return call('unblock', { blockId: blockId }).then(function (res) { return res.data; });
}

function getMyBlocks() {
  if (!cloudReady()) {
    return Promise.resolve(localMyBlocks());
  }
  return call('myBlocks', {}).then(function (res) {
    return (res.data || []).map(decorateBlock);
  });
}

module.exports = {
  LINES: LINES,
  LINES_CITY: LINES_CITY,
  PLACE_GROUPS: PLACE_GROUPS,
  HOT_PLACES: HOT_PLACES,
  DEFAULT_CITY: DEFAULT_CITY,
  AUTO_LOCATE: AUTO_LOCATE,
  getDistrict: getDistrict,
  schoolPlaceIfNearby: schoolPlaceIfNearby,
  PAGE_SIZE: PAGE_SIZE,
  resolveCorridor: resolveCorridor,
  perPersonOf: perPersonOf,
  money: money,
  genderTextOf: genderTextOf,
  genderLabel: genderLabel,
  genderLimitTextOf: genderLimitTextOf,
  genderLimitBlocks: genderLimitBlocks,
  isExpired: isExpired,
  isCloudMode: isCloudMode,
  getCity: getCity,
  setCity: setCity,
  CITIES: CITIES,
  cityGroups: cityGroups,
  locateCity: locateCity,
  getCityCounts: getCityCounts,
  bustCaches: bustCaches,
  displayNameOf: displayNameOf,
  getMe: getMe,
  saveProfile: saveProfile,
  logout: logout,
  uploadAvatar: uploadAvatar,
  requireProfile: requireProfile,
  getTrips: getTrips,
  getTripById: getTripById,
  getMyTrips: getMyTrips,
  addTrip: addTrip,
  removeTrip: removeTrip,
  joinTrip: joinTrip,
  getMyJoins: getMyJoins,
  getTripJoins: getTripJoins,
  decideJoin: decideJoin,
  cancelJoin: cancelJoin,
  reportTrip: reportTrip,
  blockOwner: blockOwner,
  unblockUser: unblockUser,
  getMyBlocks: getMyBlocks,
  uploadVerifyImage: uploadVerifyImage,
  submitVerify: submitVerify,
  getMyVerify: getMyVerify
};
