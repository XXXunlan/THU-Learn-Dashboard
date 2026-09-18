/**
 * 网络学堂（learn.tsinghua.edu.cn，2018 版前端）的接口与页面地址表。
 *
 * 这些路径不是猜的：来自站点自身前端资源里的字面量
 * （课程列表页模板、courseList.js、作业/课件列表页内联脚本）。
 * 仍然把 URL 集中在这里，站点改版时只需要改这一个文件。
 *
 * 术语：
 *   wlkcid —— 课程 id（列表模板里叫 kcid）
 *   zyid / xszyid —— 作业 id / 该学生的作业 id
 *   ggid —— 公告 id ；wjid / kjxxid —— 文件 id / 课件 id
 *   xnxq —— 学期，形如 2026-2027-1
 */

export const ORIGIN = 'https://learn.tsinghua.edu.cn';

/** JSON 接口（/b/... 为主，注意作业列表在 /b/kc/ 下，前缀不统一） */
export const API = {
  /** 当前/下一学期 */
  currentSemester: '/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester',
  /** 学生学期列表（学期接口不可用时的兜底） */
  semesterList: '/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq',
  /** 按学期取学生课程（主修） */
  coursesBySemester: (xnxq) => `/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/${encodeURIComponent(xnxq)}/zh`,
  /** 辅修 / 双学位课程列表（与主修是两套数据） */
  asCoCourses: (xnxq) => `/b/kc/v_wlkc_kcb/queryAsorCoCourseList/${encodeURIComponent(xnxq)}/0`,

  /* ---- 以下端点全部来自「全面取证」观测到的站点真实请求，不是猜的 ---- */

  /** 课程公告（简单 GET）。响应：{result,msg,object:{aaData:[{ggid,bt,fbr,fbsj,fbsjStr,...}]}} */
  noticesBySize: '/b/wlxt/kcgg/wlkc_ggb/student/kcggListXs',
  /** 公告列表（DataTables 分页版 POST+aoData），备用 */
  notices: '/b/wlxt/kcgg/wlkc_ggb/student/pageListXsbyWgq',

  /**
   * 课程文件（简单 GET）—— **这就是一直没找到的那个接口**。
   * 响应：{result,msg,object:[{bt,wjlx,wjdx,fileSize,scsj,wjid,kjxxid,kjflid,...}]}
   * 注意 object 直接就是对象数组，字段名与 normalizeFile 完全对得上。
   */
  filesBySize: '/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent',
  /** 课件分类：{object:{rows:[{kjflid,bt,...}]}} */
  fileCategories: '/b/wlxt/kj/wlkc_kjflb/student/pageList',
  /** 某分类下的文件（响应是**二维数组**，只能按位置取字段） */
  filesInCategory: (wlkcid, kjflid) => `/b/wlxt/kj/wlkc_kjxxb/student/kjxxb/${encodeURIComponent(wlkcid)}/${encodeURIComponent(kjflid)}`,

  /**
   * 作业本身就按状态分成三个接口，正好对应“已完成的不列”：
   *   zyListWj 未交 / zyListYjwg 已交未改 / zyListYpg 已批改
   * 响应：{result,msg,object:{iTotalRecords,aaData:[...]}}
   */
  homeworkNotSubmitted: '/b/wlxt/kczy/zy/student/index/zyListWj',
  homeworkSubmitted: '/b/wlxt/kczy/zy/student/index/zyListYjwg',
  homeworkGraded: '/b/wlxt/kczy/zy/student/index/zyListYpg',
  /** 作业全量检索（DataTables 分页版），备用 */
  homework: '/b/kc/v_xszy_search/student/pageList',

  /** 文件下载前确认 */
  fileDownloadBefore: '/b/wlxt/kj/wlkc_kjxxb/student/downloadFileBefore',
};

/** 页面地址（点击跳转用） */
export const PAGE = {
  courseList: '/f/wlxt/index/course/student/',
  /** 课程主页（取证实测到的真实地址，不是我以为的 /f/wlxt/course/index） */
  courseHome: (wlkcid) => `/f/wlxt/index/course/student/course?wlkcid=${wlkcid}`,
  allCourse: '/f/wlxt/index/course/student/allcourse',
  login: '/f/login',
  logout: '/f/j_spring_security_logout',
  noticeList: (wlkcid) => `/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?wlkcid=${wlkcid}&sfgk=0`,
  noticeDetail: (wlkcid, ggid) => `/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=${wlkcid}&id=${ggid}`,
  fileList: (wlkcid) => `/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=${wlkcid}&sfgk=0`,
  homeworkList: (wlkcid) => `/f/wlxt/kczy/zy/student/beforePageList?wlkcid=${wlkcid}`,
  homeworkSubmit: (wlkcid, xszyid) => `/f/wlxt/kczy/zy/student/tijiao?wlkcid=${wlkcid}&xszyid=${xszyid}`,
  fileDownload: (wjid) => `/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=${wjid}`,
  fileDownloadBefore: (wjid) => `/b/wlxt/kj/wlkc_kjxxb/student/downloadFileBefore?wjid=${wjid}`,
};

/**
 * 作业详情页地址。
 *
 * 站点自己是按「已交未改 / 未交 / 已批改」挑三个不同地址的。这里**故意不逐字照搬**
 * 它那处 `zt=="已交" && pyzt!="已批改" || pyzt=="未批改" || pyzt=="未批阅"`：
 * 由于 && 优先级高于 ||，只要 pyzt 是「未批阅」，未交的作业也会被判进第一个分支，
 * 于是链接指向 viewTj（查看提交），而用户真正想看的是 viewZy（查看作业/去提交）。
 * 先判 `zt === '未交'`（这个字段是权威的“交没交”）在语义上一定更对，
 * 而且无论站点那处写法是不是有意为之，落到 viewZy 都是用户想要的结果。
 */
export function homeworkUrl({ wlkcid, zyid, xszyid, zt, pyzt, deadline, now = Date.now() }) {
  const expired = deadline && deadline - now <= 0 ? '1' : '0';
  const base = `${ORIGIN}/f/wlxt/kczy/zy/student`;
  const common = `wlkcid=${wlkcid}`;
  if (zt === '未交') {
    return `${base}/viewZy?${common}&sfgq=${expired}&zyid=${zyid}&xszyid=${xszyid}`;
  }
  if (pyzt === '已批改') {
    return `${base}/viewCj?${common}&zyid=${zyid}&xszyid=${xszyid}`;
  }
  if (zt === '已交') {
    return `${base}/viewTj?${common}&sfgq=${expired}&zyid=${zyid}&xszyid=${xszyid}`;
  }
  // 状态字段意外时给一个一定能打开的安全地址
  return `${base}/viewZy?${common}&sfgq=${expired}&zyid=${zyid}&xszyid=${xszyid}`;
}

/**
 * `/b/wlxt/kj/wlkc_kjxxb/student/kjxxb/<wlkcid>/<kjflid>` 的**位置化字段表**。
 *
 * 这个接口的响应是二维数组（`object: [[...]]`），没有字段名，只能按位置取。
 * 下面这份顺序来自「全面取证」抓到的真实响应样本，逐位对齐：
 *
 *   ["26ef84e8…5d", "1-数据科学介绍2026", 0, "INITWJ152230837",
 *    "2026-2027-1000000001", null, "2026-09-15 14:06:40",
 *    "2023310802_KJ_…", 0, 10831880, "2026-09-15 14:05:00", "否", "否", "pdf", null]
 *
 * 没有把握的位置一律留成 `_5` 这样的占位名，不硬安字段 —— 猜错字段名比留空更糟。
 */
export const FILE_CATEGORY_COLUMNS = [
  'kjxxid',   // 0
  'bt',       // 1  文件标题
  'sfqd',     // 2  是否置顶
  'kjflid',   // 3  所属分类
  'wlkcid',   // 4  课程 id
  '_5',       // 5  样本为 null
  'scsj',     // 6  上传时间
  'wjid',     // 7  下载用的文件 id
  'llcs',     // 8  浏览次数
  'wjdx',     // 9  文件大小（字节）
  '_10',      // 10 样本为时间字符串
  '_11',      // 11 样本为「否」
  '_12',      // 12 样本为「否」
  'wjlx',     // 13 文件类型（pdf 等）
  '_14',      // 14 样本为 null
];

export function abs(pathOrUrl) {  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return ORIGIN + (pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`);
}

/**
 * 从日期推算学期码，形如 2026-2027-1。
 * 秋季学期（1）通常在 8 月—次年 1 月，春季学期（2）在 2—7 月。
 */
export function guessSemester(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  if (m >= 8) return `${y}-${y + 1}-1`;
  if (m <= 1) return `${y - 1}-${y}-1`;
  return `${y - 1}-${y}-2`;
}

/** 学期码的样子：2026-2027-1 */
export const SEMESTER_RE = /\b(\d{4}-\d{4}-[12])\b/;

/**
 * 从**任意形状**的响应/文本里挖出学期码。
 *
 * 学期接口返回什么结构并不稳定（实测 `getCurrentAndNextSemester` 的 resultList 是空的），
 * 所以不按字段名去找，而是**直接在序列化结果里找形如 2026-2027-1 的字符串**。
 * 这样无论它包几层、字段叫什么，只要里面出现过学期码就一定能拿到。
 */
export function extractSemester(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const m = value.match(SEMESTER_RE);
    return m ? m[1] : '';
  }
  try {
    return extractSemester(JSON.stringify(value));
  } catch {
    return '';
  }
}

/** 一个学期码的前后邻居，用于“猜错就换一个再试” */
export function neighborSemesters(code) {
  const m = String(code || '').match(/^(\d{4})-(\d{4})-([12])$/);
  if (!m) return [];
  const y1 = Number(m[1]);
  const term = Number(m[3]);
  if (term === 1) return [`${y1 - 1}-${y1}-2`, `${y1}-${y1 + 1}-2`];
  return [`${y1}-${y1 + 1}-1`, `${y1 - 1}-${y1}-1`];
}
