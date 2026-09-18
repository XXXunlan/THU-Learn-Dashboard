/**
 * 雨课堂（yuketang.cn）数据解析 —— 全部是纯函数，方便单测。
 *
 * 这里出现的**每一个**接口路径与字段名都来自实际抓包（yuketang-forensics 报告），
 * 没有一处是猜的。这一条在这个项目里是硬规矩 —— 之前靠猜接口吃过的亏太多了。
 *
 * 观测到的链路（cid = 课程/教室 id）：
 *
 *   ① 课程列表     首页 /v2/web/index 自己发出的某个请求（路径事先不知道，
 *                  所以由 pickClassroomList 从**真实响应**里认出来，而不是写死）
 *   ② 单课信息     GET /v2/api/web/classrooms/{cid}?role=5
 *                  → { id, name:"2026秋-示例课程A(1)-5", course_name:"示例课程A(1)",
 *                      teacher_name, students_count, course_sign, class_start, class_end }
 *   ③ 章节树       GET /mooc-api/v1/lms/learn/course/chapter
 *                      ?cid={cid}&sign={course_sign}&classroom_id={cid}&show_unpublished=0
 *                  → data.course_chapter[].section_leaf_list[]
 *                     leaf_type === 6 就是作业（实测名字为「第0次作业」「第一周作业」）
 *   ④ 完成度       GET /mooc-api/v1/lms/learn/course/schedule
 *                      ?cid={cid}&sign={course_sign}&classroom_id={cid}&is_h5=true
 *                  → data.leaf_schedules: { "作业id": {total, done}, … }
 *   ⑤ 作业详情     GET /mooc-api/v1/lms/learn/leaf_info/{cid}/{leaf_id}/?classroom_id={cid}
 *   ⑥ 作业页地址   /ai-workspace/lms-graph/{cid}/exercise/{leaf_id}?is_chapter=1&node_id={chapter_id}
 *                  （node_id 就是 chapter_id —— 已用两条独立抓包互校过）
 */

import { squash } from '../common/utils.js';

export const YKT_ORIGIN = 'https://pro.yuketang.cn';
export const YKT_INDEX_URL = `${YKT_ORIGIN}/v2/web/index`;

/** leaf_type === 6 是作业。**实测确证**，不是推测。 */
export const LEAF_TYPE_HOMEWORK = 6;

/**
 * 课程列表接口 —— **来自实机抓包**（用户机器上首页自己发的请求）。
 *
 * 但主路径仍然是**运行时识别**（pickClassroomList），这个常量只当兜底：
 * 万一某次首页没渲染出来、或者改版换了接口，只要后台直连还能用，就还能把课拿到。
 * 之所以敢写死这一条，是因为它确实被观测到过；不是猜的。
 */
export const YKT_COURSES_LIST_URL = `${YKT_ORIGIN}/v2/api/web/courses/list`;

/** 课程列表「像不像一门课」的判定特征字段 —— 都是 /v2/api/web/classrooms 上真实存在的 */
const CLASSROOM_SIGNS = [
  'course_sign', 'course_name', 'university_id', 'uv_id',
  'class_start', 'class_end', 'students_count', 'teacher_name',
  'user_role', 'platform', 'course_id', 'university_domain',
];

/* ------------------------------- 小工具 ------------------------------- */

function pick(row, names, fallback = '') {
  if (!row || typeof row !== 'object') return fallback;
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

/**
 * 雨课堂的时间是 **epoch 毫秒的数值**（如 1790524799000），
 * 但个别响应里是浮点（1789539607000.0），也见过秒级值，所以两种都兜住。
 */
export function yktTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  // 秒级（约 1.79e9）补成毫秒；毫秒级（约 1.79e12）原样
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

/* --------------------------- 接口地址构造 --------------------------- */

export const yktUrl = {
  /** 单课程信息（含 course_sign） */
  classroom: (cid) => `${YKT_ORIGIN}/v2/api/web/classrooms/${encodeURIComponent(cid)}?role=5`,
  /** 章节树（作业就在这里） */
  chapter: (cid, sign) => `${YKT_ORIGIN}/mooc-api/v1/lms/learn/course/chapter`
    + `?cid=${encodeURIComponent(cid)}&sign=${encodeURIComponent(sign)}&classroom_id=${encodeURIComponent(cid)}&show_unpublished=0`,
  /** 每片叶子的完成度 */
  schedule: (cid, sign) => `${YKT_ORIGIN}/mooc-api/v1/lms/learn/course/schedule`
    + `?cid=${encodeURIComponent(cid)}&sign=${encodeURIComponent(sign)}&classroom_id=${encodeURIComponent(cid)}&is_h5=true`,
  /** 作业详情（当前只用于诊断，主流程不依赖它） */
  leafInfo: (cid, leafId) => `${YKT_ORIGIN}/mooc-api/v1/lms/learn/leaf_info/${encodeURIComponent(cid)}/${encodeURIComponent(leafId)}/?classroom_id=${encodeURIComponent(cid)}`,
  /** 课程主页（点「课程名」跳这里） */
  courseHome: (cid) => `${YKT_ORIGIN}/v2/web/studentLog/${encodeURIComponent(cid)}`,
  /** 作业详情页 —— node_id 就是 chapter_id */
  homework: (cid, leafId, chapterId) => `${YKT_ORIGIN}/ai-workspace/lms-graph/${encodeURIComponent(cid)}/exercise/${encodeURIComponent(leafId)}`
    + `?is_chapter=1&node_id=${encodeURIComponent(chapterId || '')}`,
};

/** 只要同一主域即可 —— 雨课堂是跨子域架构（教室信息里的 university_domain 指向别的子域） */
export function isYuketangUrl(url) {
  try { return /(^|\.)yuketang\.cn$/i.test(new URL(url, YKT_ORIGIN).hostname); } catch { return false; }
}

/**
 * 雨课堂的接口习惯用 **HTTP 200 + `success:false` / `errcode!=0`** 表示失败
 * （实机抓包里就见过 `{"msg":"数据错误","error_code":20002,"data":{},"success":false}`）。
 *
 * ⚠️ 这一点必须显式检查：这种响应是**合法 JSON**，只看"能不能解析"会把它当成成功，
 * 于是「接口报错」就被误读成「这门课没有作业」—— 一个会安静骗过所有人的 bug。
 *
 * @returns {string} 出错说明；没错返回空串
 */
export function apiError(json) {
  if (!json || typeof json !== 'object') return '响应不是对象';
  if (json.success === false) {
    return `接口返回 success=false：${json.msg || json.message || `error_code=${json.error_code ?? '?'}`}`;
  }
  if (json.errcode !== undefined && json.errcode !== null && Number(json.errcode) !== 0) {
    return `接口返回 errcode=${json.errcode}：${json.errmsg || json.msg || ''}`.trim();
  }
  if (json.code !== undefined && Number(json.code) !== 0 && json.success === undefined) {
    return `接口返回 code=${json.code}：${json.msg || ''}`.trim();
  }
  return '';
}

/* ----------------------- ① 课程列表：从真实流量里认 ----------------------- */

/** 深度收集「对象数组」，并给每个候选算一个「像不像课程列表」的分 */
function collectObjectArrays(node, out, depth = 0, seen = new WeakSet(), key = '') {
  if (!node || typeof node !== 'object' || depth > 5) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length) {
      const keys = new Set();
      for (const o of objs.slice(0, 3)) for (const k of Object.keys(o)) keys.add(k);
      let strong = 0;
      for (const s of CLASSROOM_SIGNS) if (keys.has(s)) strong++;
      out.push({ rows: objs, length: node.length, strong, keys: Array.from(keys), key });
    }
    for (const x of node) collectObjectArrays(x, out, depth + 1, seen, key);
    return;
  }
  for (const k of Object.keys(node)) collectObjectArrays(node[k], out, depth + 1, seen, k);
}

/** 章节/叶子的形状标记 —— 带这些的对象**绝不是**课程 */
const LEAF_MARKERS = ['leaf_type', 'leafinfo_id', 'section_leaf_list', 'chapter_id'];
/** 这些键下面挂的数组是章节/题目之类，直接排除 */
const NON_LIST_KEYS = ['course_chapter', 'section_leaf_list', 'leaf_schedules', 'problems', 'options', 'choices'];

/** 数组里每个对象都像个「有 id 有名字」的实体 */
function allHaveIdAndName(rows) {
  return rows.every((o) => {
    const id = pick(o, ['id', 'classroom_id', 'classroomId', 'cid', 'course_id'], '');
    const name = pick(o, ['name', 'classroom_name', 'course_name', 'short_name'], '');
    return String(id) !== '' && String(name) !== '';
  });
}

/** 每个对象都带「教室 id」这种字段（比泛泛的 id 强得多） */
function allHaveClassroomId(rows) {
  return rows.every((o) => String(pick(o, ['classroom_id', 'classroomId', 'cid'], '')) !== '');
}

/**
 * 从「站点自己刚刚发出的请求」里认出课程列表。
 *
 * 为什么是"认"而不是"写死路径"：首页那次列表请求在上一轮取证里**根本没被触发到**，
 * 所以它的路径我并不知道。与其猜一个 `/v2/api/web/classrooms?role=5` 蒙上去，
 * 不如让扩展打开首页、把站点自己的请求读下来，再从响应形状里认出哪一个是课程列表。
 *
 * 判定分三级（前两级要求对象带雨课堂课程专有字段，第三级才看结构）：
 *   强：≥2 个课程专有字段（course_sign / course_name / uv_id …）→ 几乎不会认错；
 *   中：1 个课程专有字段 + 每个对象都有 id 与名称；
 *   弱：路径像课程列表 + 每个对象都带教室 id + 至少 2 个对象。
 *
 * @param {Array<{url:string, responseSnippet:string}>} records
 * @returns {{rows:Array, url:string, path:string, score:number, reason:string}}
 */
export function pickClassroomList(records) {
  const c = classroomListCandidates(records);
  return c[0] || { rows: [], url: '', path: '', score: 0, reason: '没有在请求里认到课程列表' };
}

/**
 * 同上的"带过程"版本：把**每一个**被考虑过的对象数组连同判定结果都返回。
 *
 * 存在的理由很实际：雨课堂改版、或者首页那次请求没被采集到时，
 * 光说一句"没认到"根本没法修。把候选、字段、被拒原因全摆出来，
 * 一次就能看出是"请求没采到"还是"形状变了"。
 */
export function classroomListCandidates(records, debug = null) {
  const candidates = [];
  for (const r of records || []) {
    const text = r && r.responseSnippet;
    const path = pathOf(r && r.url);
    if (!text || typeof text !== 'string') {
      if (debug) debug.push({ path, accepted: false, why: '没有响应体（只记到了请求）' });
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch {
      if (debug) debug.push({ path, accepted: false, why: '响应不是 JSON' });
      continue;
    }

    const arrays = [];
    collectObjectArrays(json, arrays);
    if (!arrays.length && debug) debug.push({ path, accepted: false, why: '响应里没有对象数组' });

    for (const a of arrays) {
      // 硬闸门：章节树与题目结构**一律**不是课程列表。
      // （这条是被测试逼出来的：章节树的对象也有 id 和 name，只看这两样就会认错，
      //  然后拿章节 id 去当教室 id 查，越查越离谱。）
      if (NON_LIST_KEYS.includes(a.key)) {
        if (debug) debug.push({ path, key: a.key, length: a.length, accepted: false, why: `挂在 ${a.key} 下（章节/题目结构）` });
        continue;
      }
      const leafish = a.rows.slice(0, 3).some((o) => LEAF_MARKERS.some((k) => k in o));
      if (leafish) {
        if (debug) debug.push({ path, key: a.key, length: a.length, accepted: false, why: '对象带 leaf_type / chapter_id 等叶子标记' });
        continue;
      }

      const pathHints = /classroom|course|index|home|learn/i.test(path);
      const idName = allHaveIdAndName(a.rows);
      let score = a.strong;
      let reason = '';

      if (a.strong >= 2) {
        reason = `响应里有 ${a.strong} 个课程专有字段`;
      } else if (a.strong === 1 && idName && a.rows.length >= 2) {
        score = 1;
        reason = '响应里有 1 个课程专有字段，且每个条目都有 id 与名称';
      } else if (a.strong === 0 && pathHints && allHaveClassroomId(a.rows) && a.rows.length >= 2) {
        score = 0.5;
        reason = '路径像课程列表，且每个条目都带教室 id';
      } else {
        if (debug) {
          debug.push({
            path, key: a.key, length: a.length, accepted: false,
            why: `只有 ${a.strong} 个课程专有字段${idName ? '' : '，且有条目缺 id 或名称'}`,
            keys: a.keys.slice(0, 14),
          });
        }
        continue;
      }
      candidates.push({ rows: a.rows, url: r.url, path, score, reason, length: a.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.rows.length - a.rows.length);
  return candidates;
}

/** 原始课程对象 -> 统一形状 */
export function normalizeYktClassroom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(pick(raw, ['id', 'classroom_id', 'classroomId', 'cid'], ''));
  if (!id) return null;
  const name = squash(pick(raw, ['name', 'classroom_name', 'short_name'], ''));
  const courseName = squash(pick(raw, ['course_name', 'courseName'], '')) || name;
  if (!name && !courseName) return null;
  return {
    id,
    name: name || courseName,
    courseName,
    // course_id 与「教室 id」是两个不同的东西（实测 3000001 是教室、4000001 是课程）。
    // 一起留着，是因为**课程列表接口给的不一定哪一个** —— 缺 course_sign 时两个都要试。
    courseId: String(pick(raw, ['course_id', 'courseId'], '')),
    sign: squash(pick(raw, ['course_sign', 'sign'], '')),
    teacher: squash(pick(raw, ['teacher_name', 'teacherName'], '')),
    studentsCount: Number(pick(raw, ['students_count', 'studentsCount'], 0)) || 0,
    startAt: yktTime(pick(raw, ['class_start', 'start'], null)),
    endAt: yktTime(pick(raw, ['class_end', 'end'], null)),
    url: yktUrl.courseHome(id),
  };
}

/**
 * 首页没认到列表接口时的兜底：从渲染后的 HTML 里抠出教室 id。
 *
 * ⚠️ 这里**只取 id**，名称一律用 ② 号接口回填 —— 也就是说，抠错了也不会
 * 污染数据（认不出来的 id 会被接口直接否掉），最多是白跑几次。
 */
export function classroomIdsFromHtml(html) {
  const out = [];
  const text = String(html || '');
  const patterns = [
    /\/lms-graph\/(\d{5,9})\//g,
    /\/studentLog\/(\d{5,9})/g,
    /classroom_id=(\d{5,9})/g,
    /"classroomId"\s*:\s*"?(\d{5,9})"?/g,
    /"classroom_id"\s*:\s*"?(\d{5,9})"?/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 比 HTML 更可靠的一层兜底：**站点自己请求过的 URL 里就带着教室 id**。
 *
 * 首页要给每张课程卡片取进度/教师信息，必然逐个请求带 cid 的接口；
 * 就算 pickClassroomList 认不出那个「课程列表」响应（字段和预期不同），
 * 这些 URL 也已经把 id 交出来了。拿到 id 之后一律用 ② 号接口回填权威名称。
 */
export function classroomIdsFromRecords(records) {
  const out = [];
  const patterns = [
    /\/classrooms\/(\d{5,9})\b/,
    /\/course\/classroom\/(\d{5,9})\b/,
    /\/leaf_info\/(\d{5,9})\//,
    /\/logs\/learn\/(\d{5,9})\b/,
    /\/lms-graph\/(\d{5,9})\//,
    /[?&]classroom_id=(\d{5,9})\b/,
    /[?&]cid=(\d{5,9})\b/,
  ];
  for (const r of records || []) {
    const url = String((r && r.url) || '');
    if (!url) continue;
    for (const re of patterns) {
      const m = url.match(re);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/* ------------------------- ③ 章节树 -> 作业 ------------------------- */

/**
 * 递归收集章节树里所有 `section_leaf_list` 下的叶子。
 *
 * ⚠️ 为什么是递归而不是直接读 `data.course_chapter[].section_leaf_list[]`：
 * 实测样本里章节是**平的**（每个章节直接挂叶子），但这只是两门课的观测结果。
 * 雨课堂本身支持「章 → 节 → 叶子」的嵌套，一旦某门课用了子节，
 * 叶子就落在更深一层 —— 扁平读法会得到"一个叶子都没有"，
 * 而那看起来跟"这门课确实没内容"一模一样，极难分辨。递归能同时覆盖两种结构。
 *
 * @returns {Array<{leaf:object, chapterName:string, chapterId:string}>}
 */
function collectLeaves(node, out, ctx = { name: '', id: '' }, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const x of node) collectLeaves(x, out, ctx, depth + 1);
    return;
  }
  // 同时有 name 与 id 的层级当作"章节"上下文，供叶子回填 chapterName / chapterId
  const next = (node.name && node.id !== undefined)
    ? { name: squash(node.name), id: String(node.id) }
    : ctx;

  if (Array.isArray(node.section_leaf_list)) {
    for (const lf of node.section_leaf_list) {
      if (lf && typeof lf === 'object' && lf.leaf_type !== undefined) out.push({ leaf: lf, chapterName: next.name, chapterId: next.id });
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'section_leaf_list') continue;
    collectLeaves(node[k], out, next, depth + 1);
  }
}

/** 章节树里所有叶子（含嵌套子节），按 leaf id 去重 */
function allLeaves(json) {
  const found = [];
  collectLeaves(json, found);
  const seen = new Set();
  const out = [];
  for (const f of found) {
    const id = String(f.leaf && f.leaf.id !== undefined ? f.leaf.id : '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(f);
  }
  return out;
}

/**
 * 章节树里 leaf_type === 6 的叶子就是作业。
 * @returns {Array<{leafId,title,chapterId,chapterName,deadline,publishTime,isScore,locked}>}
 */
export function homeworkFromChapter(json) {
  const out = [];
  for (const { leaf, chapterName, chapterId } of allLeaves(json)) {
    if (Number(leaf.leaf_type) !== LEAF_TYPE_HOMEWORK) continue;
    const leafId = String(leaf.id || '');
    if (!leafId) continue;
    out.push({
      leafId,
      title: squash(leaf.name) || `作业 ${leafId}`,
      chapterId: String(leaf.chapter_id || chapterId || ''),
      chapterName: squash(chapterName),
      deadline: yktTime(leaf.score_deadline),
      publishTime: yktTime(leaf.start_time),
      isScore: !!leaf.is_score,
      locked: !!leaf.is_locked,
    });
  }
  return out;
}

/**
 * 诊断用：章节树里 `leaf_type` 的分布。
 *
 * 有了它才能区分「这门课确实没放内容」和「接口换了形状」——
 * 两者在没有这个分布的时候长得一模一样。
 */
export function leafTypeHistogram(json) {
  const dist = {};
  const leaves = allLeaves(json);
  const chapters = (json && json.data && Array.isArray(json.data.course_chapter))
    ? json.data.course_chapter.length : 0;
  for (const { leaf } of leaves) {
    const k = `leaf_type=${leaf.leaf_type}`;
    dist[k] = (dist[k] || 0) + 1;
  }
  return { dist, chapters, leaves: leaves.length };
}

/**
 * 从嗅探记录里捡出**站点自己已经取到过**的章节树 / 完成度响应（按教室 id 归档）。
 *
 * 为什么要这一步：`mooc-api` 要求一个自定义请求头（XTBZ），而那个头不一定能被我们完整复现。
 * 但只要我们在辅助标签页里打开过一个会自己调这些接口的页面，
 * **站点已经带着正确的头把数据取回来了** —— 那就直接用它的结果，
 * 连头都不用管。这比复现请求更可靠，也正是"让站点自己告诉我们"的一贯做法。
 *
 * @returns {{[cid:string]: {chapter?:object, schedule?:object, url?:string}}}
 */
export function harvestedCourseData(records) {
  const out = {};
  for (const r of records || []) {
    const url = String((r && r.url) || '');
    if (!url.includes('/mooc-api/')) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    const cid = u.searchParams.get('cid') || u.searchParams.get('classroom_id') || '';
    if (!cid) continue;
    let json = null;
    try { json = JSON.parse(String(r.responseSnippet || '')); } catch { continue; }
    if (!json || apiError(json)) continue;   // 站点自己拿到的是报错的话，别当数据用
    const bucket = out[cid] || (out[cid] = {});
    if (u.pathname.includes('/course/chapter')) { bucket.chapter = json; bucket.url = url; }
    else if (u.pathname.includes('/course/schedule')) bucket.schedule = json;
  }
  return out;
}

/* ------------------------- ④ 完成度 ------------------------- */

/**
 * leaf_schedules 有两种形状：
 *   对象 {total, done}  —— 作业这类「多道题」，done === total 视为做完
 *   标量 1             —— 视频/课件这类整片叶子，1 视为已完成
 *
 * ⚠️ 诚实标注：对作业而言 `done >= total` 是否**等价于「已提交」**，
 * 我只观测到「第0次作业 total=2 done=2」（推测已做完）这一条正向样本，
 * 没有观测到「已提交但 done < total」的反例，所以这里是**推断而非确证**。
 * 因此面板上把它显示成「已完成（雨课堂）／未完成（雨课堂）」并附带题数进度，
 * 让结果一眼可核对，而不是伪装成网络学堂那种权威的「已交/未交」。
 */
export function completionFromSchedule(json) {
  const out = {};
  const sched = (json && json.data && json.data.leaf_schedules) || null;
  if (!sched || typeof sched !== 'object') return out;
  for (const [leafId, v] of Object.entries(sched)) {
    if (v && typeof v === 'object') {
      const total = Number(v.total) || 0;
      const done = Number(v.done) || 0;
      out[leafId] = { total, done, complete: total > 0 && done >= total };
    } else {
      const done = Number(v) || 0;
      out[leafId] = { total: 0, done, complete: done > 0 };
    }
  }
  return out;
}

/* --------------------------- 课程名匹配 --------------------------- */

/** 课程名归一化：全角转半角、去空白、去学期前缀与班号后缀、去括号 */
export function courseKey(name) {
  return String(name || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\s]+/g, '')
    .toLowerCase()
    // "2026秋-示例课程A(1)-5" -> "示例课程A(1)-5"
    .replace(/^20\d{2}\s*[-–—]?\s*(春|秋|夏|冬)?\s*[-–—]?/, '')
    // 去掉结尾的班号 "-5"
    .replace(/[-–—_]\d{1,2}$/, '')
    .replace(/[()（）\[\]【】]/g, '')
    .trim();
}

/**
 * 把一门雨课堂课程对到网络学堂的同名课程上。依次尝试：
 *   ① course_name 归一化后完全相等（最可靠：「示例课程A(1)」对「示例课程A(1)」）
 *   ② 完整班级名（含学期前缀）归一化后完全相等
 *   ③ 互相包含（两边归一化后长度都 ≥ 4，避免「英语」这类短名乱匹配）
 * @returns {object|null}
 */
export function matchLearnCourse(ykt, learnCourses) {
  if (!ykt || !Array.isArray(learnCourses) || !learnCourses.length) return null;
  const targets = learnCourses.map((c) => ({
    course: c,
    byName: courseKey(c.name),
    byCode: courseKey(c.code || ''),
  }));

  const keys = [courseKey(ykt.courseName), courseKey(ykt.name)].filter(Boolean);

  for (const k of keys) {
    const hit = targets.find((t) => t.byName && t.byName === k);
    if (hit) return hit.course;
  }
  for (const k of keys) {
    if (k.length < 4) continue;
    const hit = targets.find((t) => t.byName && t.byName.length >= 4
      && (t.byName.includes(k) || k.includes(t.byName)));
    if (hit) return hit.course;
  }
  return null;
}

/* ------------------------ 作业 -> 面板数据模型 ------------------------ */

/**
 * 转成和网络学堂作业**完全同形**的条目，这样面板、排序、筛选、隐藏已完成
 * 全都不用改逻辑。独有的信息挂在 platform / progressText 上。
 *
 * 说明字段：雨课堂作业**没有作业说明**（已向用户确认），所以留空、
 * 也不会触发"去详情页补全"那一步。
 */
export function toYktHomework(hw, { classroomId, wlkcid = '', sign = '', completion = null, now = Date.now() } = {}) {
  const prog = completion && completion[hw.leafId] ? completion[hw.leafId] : null;
  const completed = !!(prog && prog.complete);
  const progressText = prog && prog.total ? `${prog.done}/${prog.total}` : '';
  const statusText = !prog
    ? '状态未知（雨课堂）'
    : (completed ? `已完成（雨课堂${progressText ? ` ${progressText}` : ''}）` : `未完成（雨课堂${progressText ? ` ${progressText}` : ''}）`);

  return {
    id: `zy:${wlkcid}:ykt:${classroomId}:${hw.leafId}`,
    title: hw.title,
    url: yktUrl.homework(classroomId, hw.leafId, hw.chapterId),
    submitUrl: '',
    listUrl: yktUrl.courseHome(classroomId),
    deadline: hw.deadline,
    deadlineText: '',
    submitDate: null,
    gradeDate: null,
    grade: '',
    teacher: '',
    mode: '个人',
    zt: '',
    pyzt: '',
    status: completed ? 'done' : (prog ? 'pending' : 'unknown'),
    statusText,
    completed,
    description: '',
    attachments: [],
    // 雨课堂作业没有说明字段，也不存在「再去详情页补全」这回事，
    // 标记成已完成补全，免得补全流程和界面把它当成"抓取失败"。
    detailEnriched: true,
    // —— 雨课堂专有 ——
    platform: 'yuketang',
    classroomId: String(classroomId),
    leafId: String(hw.leafId),
    chapterName: hw.chapterName || '',
    progressText,
    sign: sign || '',
    section: 'homework',
    source: 'yuketang',
    fetchedAt: now,
  };
}

/**
 * 把雨课堂作业并进网络学堂的对应课程。
 * 按课程名匹配（matchLearnCourse），匹配不上的**如实返回**，绝不硬塞。
 *
 * @param {Array} learnCourses 网络学堂课程（会被就地追加 homework）
 * @param {{classrooms?:Array, byClassroom?:Object, now?:number}} opts
 *   byClassroom: { [教室id]: { homework: [...], completion: {...}, sign, error } }
 * @returns {{matched:Array, unmatched:Array, added:number}}
 */
export function mergeYuketang(learnCourses, { classrooms = [], byClassroom = {}, now = Date.now() } = {}) {
  const matched = [];
  const unmatched = [];
  let added = 0;

  for (const room of classrooms || []) {
    const learn = matchLearnCourse(room, learnCourses);
    if (!learn) {
      unmatched.push({ classroom: room, reason: '网络学堂的课程清单里没有同名课程' });
      continue;
    }
    const bundle = byClassroom[room.id] || {};
    const list = bundle.homework || [];
    const completion = bundle.completion || null;
    const sign = bundle.sign || room.sign || '';
    const existing = new Set((learn.homework || []).map((h) => h.id));
    const fresh = [];
    for (const hw of list) {
      const item = toYktHomework(hw, { classroomId: room.id, wlkcid: learn.id, sign, completion, now });
      if (existing.has(item.id)) continue;
      existing.add(item.id);
      fresh.push(item);
    }
    learn.homework = [...(learn.homework || []), ...fresh];
    added += fresh.length;
    matched.push({ classroom: room, course: learn.name, courseId: learn.id, count: fresh.length });
  }

  return { matched, unmatched, added };
}
