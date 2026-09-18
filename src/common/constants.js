/**
 * 全局常量与消息协议。
 *
 * 消息约定：所有 chrome.runtime.sendMessage 都带一个 `target` 字段，
 * 只允许目标上下文（'sw' | 'offscreen' | 'ui'）响应该消息，
 * 避免 popup / dashboard / offscreen / service worker 互相抢答。
 */

export const TARGET = {
  SW: 'sw',
  OFFSCREEN: 'offscreen',
  UI: 'ui',
};

/** 后台 -> UI 的单向广播 */
export const EVENT = {
  PROGRESS: 'progress',
  STATE_CHANGED: 'stateChanged',
};

/** UI -> 后台 的请求 */
export const MSG = {
  GET_STATE: 'getState',
  LOGIN: 'login',
  LOGOUT: 'logout',
  REFRESH: 'refresh',
  CANCEL_REFRESH: 'cancelRefresh',
  OPEN_URL: 'openUrl',
  UPDATE_SETTINGS: 'updateSettings',
  CHECK_SESSION: 'checkSession',
  DIAGNOSE_SESSION: 'diagnoseSession',
  RUN_FORENSICS: 'runForensics',
  START_SNIFF: 'startSniff',
  STOP_SNIFF: 'stopSniff',
  YKT_SELFCHECK: 'yuketangSelfCheck',
  SNIFF_RECORD: 'sniffRecord',
  EXPORT_DIAGNOSTICS: 'exportDiagnostics',
  MANUAL_SNAPSHOT: 'manualSnapshot',
  AUTOFILL_LOGIN: 'autofillLogin',
};

/** 后台 -> offscreen 的解析请求 */
export const PARSE = {
  PING: 'ping',
  COURSE_LIST: 'courseList',
  ITEM_LIST: 'itemList',
  LOGIN_FORM: 'loginForm',
  PAGE_KIND: 'pageKind',
  HOMEWORK_DETAIL: 'homeworkDetail',
};

export const SITE = {
  ORIGIN: 'https://learn.tsinghua.edu.cn',  /** 学生课程列表页（会话是否有效的判定入口） */
  COURSE_LIST_URL: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/',
  LOGIN_URL: 'https://learn.tsinghua.edu.cn/f/login',
  LOGOUT_URL: 'https://learn.tsinghua.edu.cn/f/j_spring_security_logout',
  /** 统一身份认证入口（自动填充账号密码用） */
  IAAA_URL: 'https://id.tsinghua.edu.cn/',
  SSO_PERMISSION: { origins: ['https://*.tsinghua.edu.cn/*'] },
};

/**
 * 雨课堂（另一个平台，**独立账号体系**）。
 *
 * 现在已经真的接进来了：刷新时顺带抓它的作业，按课程名并到网络学堂的同名课程里。
 * 接口全部来自实机取证（见 parsers/yuketang.js 顶部的清单），没有一处是猜的。
 * 权限是可选的，必须由用户在点击手势里授予。
 */
export const SITE_YUKETANG = {
  label: '雨课堂',
  domain: 'yuketang.cn',
  origin: 'https://pro.yuketang.cn',
  indexUrl: 'https://pro.yuketang.cn/v2/web/index',
  matches: ['https://*.yuketang.cn/*'],
  permission: { origins: ['https://*.yuketang.cn/*'] },
};

export const STORE_KEY = {
  SETTINGS: 'settings',
  CREDENTIALS: 'credentials',
  CACHE: 'cache',
  DIAGNOSTICS: 'diagnostics',
};

export const DEFAULT_SETTINGS = {
  /** 自动刷新间隔（分钟），0 表示关闭 */
  autoRefreshMinutes: 60,
  /** 是否展示已完成的作业（默认隐藏，符合需求） */
  showCompletedHomework: false,
  /** 是否隐藏没有内容的课程 */
  hideEmptyCourses: false,
  /** 进入作业详情页逐个复核提交状态（慢，但更准） */
  deepScanHomework: false,
  /**
   * 接口拿不到数据时，允许扩展开一个不可见的后台标签页，
   * 让站点自己把列表渲染出来后再从 DOM 读取（慢但几乎不会失效）
   */
  tabFallback: true,
  /** 兜底渲染时，等站点 AJAX 出数据的额外等待时间 */
  tabSettleMs: 3500,
  /** 记住账号密码（本地明文，默认关闭） */
  rememberCredentials: false,
  /** 自动登录（需要站点存在本地账号密码表单） */
  autoLogin: true,
  /** 单次抓取的并发课程数 */
  concurrency: 4,
  /** 每门课最多保留的条目数 */
  maxItemsPerCourse: 60,
  /**
   * 抓取结束后补全「作业说明」与「作业附件」。
   * 这两样只存在于作业详情页，要额外抓 HTML，所以单独一步、且限量。
   */
  enrichHomework: true,
  /** 单次补全的作业条数上限 */
  enrichMaxItems: 20,
  /**
   * 刷新时同时抓雨课堂（yuketang.cn）的作业，并按课程名并到网络学堂对应课程里。
   * 需要单独授予 *.yuketang.cn 的权限（面板上有「授权雨课堂」按钮）。
   */
  yuketangHomework: true,
  /** 页面悬浮入口 */
  floatingButton: true,
  theme: 'auto',
  /**
   * 手动指定学期（形如 2026-2027-1）。留空则自动判断。
   * 自动判断会先用接口、再用课程数据反证；万一都不行，用户在这里填一下即可。
   */
  semesterOverride: '',
  /**
   * 显示调试与取证功能（全面取证 / 雨课堂接口取证 / 自检 / 诊断导出）。
   * 默认关闭：这些是排障用的，日常使用只会让界面变乱。
   */
  debugMode: false,
};

export const HOMEWORK_STATUS = {
  DONE: 'done',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
};

/** 判定“已完成”的文本（已批阅/待批阅都意味着已经交过了） */
export const DONE_PATTERNS = [
  '已完成', '已提交', '已交', '已批阅', '待批阅', '已批改', '已评分',
  '已评分', '已通过', '已发布成绩', 'submit', 'submitted', 'graded',
  '已完成提交', '已上传',
];

/** 判定“未完成”的文本 */
export const PENDING_PATTERNS = [
  '未提交', '未完成', '未交', '待提交', '待完成', '进行中', '未开始',
  '逾期未交', '缺交', 'not submitted', 'pending', 'in progress',
];

export const URGENCY = {
  OVERDUE: 'overdue',
  CRITICAL: 'critical', // < 24h
  SOON: 'soon',         // < 72h
  NORMAL: 'normal',     // < 7d
  FAR: 'far',
};

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
