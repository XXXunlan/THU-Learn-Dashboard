/**
 * 原始行 -> 面板统一的数据模型。
 *
 * 字段名来自站点自己的列映射（courseList.js 与列表页内联脚本）：
 *   课程：kcid / kcurl / name / teacherName / adress / ggundo / kjundo / zyundo
 *   公告：bt 标题 / fbr 发布者 / fbsj 发布时间 / ggid / sfqd 置顶 / ydsj 阅读时间(空=未读)
 *   文件：bt / wjlx 类型 / wjdx 大小 / scsj 上传时间 / wjid / kjxxid
 *   作业：bt / zt(已交|未交) / pyzt(已批改|未批改|未批阅) / jzsj 截止(epoch ms) /
 *        jzsjStr 截止(显示) / scsjStr 提交时间 / cj 成绩 / zyid / xszyid / zywcfs 完成方式
 *
 * 所有取值都做了多字段兜底：站点不同版本字段名有出入，宁可多试几个也不要整条丢掉。
 */

import { PAGE, homeworkUrl, abs } from './endpoints.js';
import { parseDate, extractDeadline } from '../parsers/date.js';
import { squash, parseSize, fileKind, truncate, hashString } from '../common/utils.js';

function pick(row, names, fallback = '') {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

/** 各种形态的时间值 -> epoch ms */
export function toTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // 站点作业接口给的是毫秒；万一给了秒级时间戳也能兜住
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const s = String(value).trim();
  if (/^\d{10,13}$/.test(s)) return toTime(Number(s));
  return parseDate(s);
}

export function normalizeCourse(row, { origin = '' } = {}) {
  const id = String(pick(row, ['kcid', 'wlkcid', 'kc_id', 'id']));
  if (!id) return null;
  const kcurl = pick(row, ['kcurl', 'kcUrl', 'url']);
  const teacher = squash(pick(row, ['teacherName', 'jsm', 'teacher', 'teachername']));
  return {
    id,
    name: squash(pick(row, ['name', 'kcmc', 'courseName'])) || `课程 ${id}`,
    url: kcurl ? abs(kcurl) : `${origin || ''}${PAGE.homeworkList(id)}`,
    teacher,
    term: squash(pick(row, ['xnxq', 'semester', 'xqmc'])),
    location: squash(pick(row, ['adress', 'address', 'skdd', 'classroom'])),
    code: squash(pick(row, ['kch', 'kcbh', 'code'])),
    counts: {
      notice: Number(pick(row, ['ggundo'], 0)) || 0,
      file: Number(pick(row, ['kjundo'], 0)) || 0,
      homework: Number(pick(row, ['zyundo'], 0)) || 0,
      discuss: Number(pick(row, ['cytls'], 0)) || 0,
    },
    sectionLinks: {
      notice: abs(PAGE.noticeList(id)),
      file: abs(PAGE.fileList(id)),
      homework: abs(PAGE.homeworkList(id)),
    },
    announcements: [],
    files: [],
    homework: [],
    errors: [],
    stats: {},
    fetchedAt: 0,
  };
}

export function normalizeNotice(row, wlkcid, now = Date.now()) {
  const ggid = String(pick(row, ['ggid', 'id']));
  const title = squash(pick(row, ['bt', 'title', 'ggbt']));
  if (!title) return null;

  // 是否已读：站点给了权威字段 `sfyd`（"是"/"否"），其次是阅读时间 `ydsj`
  // （实测已读时是一个日期字符串，未读时为空）。**不能用发布日期去猜**。
  const sfyd = squash(pick(row, ['sfyd', 'readFlag'], ''));
  const ydsj = pick(row, ['ydsj', 'readTime'], null);
  let unread;
  if (sfyd) unread = sfyd === '否';
  else if (ydsj === '' || ydsj === null || ydsj === undefined) unread = true;
  else unread = false;

  return {
    id: `gg:${wlkcid}:${ggid || hashString(title)}`,
    title,
    url: abs(PAGE.noticeDetail(wlkcid, ggid)),
    date: toTime(pick(row, ['fbsj', 'fbsjStr', 'publishTime', 'time'])),
    author: squash(pick(row, ['fbrxm', 'fbr', 'publisher', 'fbrname'])),
    pinned: String(pick(row, ['sfqd', 'top'], '')) === '1',
    unread,
    readFlag: sfyd,
    attachment: squash(pick(row, ['fjmc', 'fjmcStr'])),
    // ggnr 是 base64 编码的正文，不能直接用；ggnrStr 才是可读文本
    text: squash(pick(row, ['ggnrStr', 'ggnrMini', 'nr', 'content', 'summary'])),
    section: 'notice',
    source: 'api',
    fetchedAt: now,
  };
}

export function normalizeFile(row, wlkcid, now = Date.now()) {
  const wjid = String(pick(row, ['wjid', 'id']));
  const title = squash(pick(row, ['bt', 'title', 'wjmc']));
  if (!title) return null;
  const rawSize = pick(row, ['wjdx', 'size', 'wjdxStr'], '');
  const size = typeof rawSize === 'number' ? rawSize : parseSize(String(rawSize));
  const typeHint = squash(pick(row, ['wjlx', 'type']));
  // 站点自己给了类型（wjlx，实测值形如 "pdf"）就用它 —— 标题里未必带扩展名
  // （实测标题长这样：「1-数据科学介绍2026」）。
  const fromHint = /^[a-z0-9]{1,6}$/i.test(typeHint) ? typeHint.toLowerCase() : '';
  const fk = fileKind(fromHint ? `x.${fromHint}` : title, typeHint);
  return {
    id: `wj:${wlkcid}:${wjid || hashString(title)}`,
    title,
    url: abs(PAGE.fileList(wlkcid)),
    downloadUrl: wjid ? abs(PAGE.fileDownload(wjid)) : '',
    downloadBeforeUrl: wjid ? abs(PAGE.fileDownloadBefore(wjid)) : '',
    date: toTime(pick(row, ['scsj', 'scsjStr', 'uploadTime', 'time'])),
    size,
    typeHint,
    ext: fromHint || fk.ext,
    fileKind: fk.kind,
    pinned: String(pick(row, ['sfqd'], '')) === '1',
    text: squash(pick(row, ['ms', 'description', 'bz'])),
    section: 'file',
    source: 'api',
    fetchedAt: now,
  };
}

export function normalizeHomework(row, wlkcid, now = Date.now()) {
  const zyid = String(pick(row, ['zyid']));
  const xszyid = String(pick(row, ['xszyid']));
  const title = squash(pick(row, ['bt', 'title', 'zymc']));
  if (!title) return null;

  const zt = squash(pick(row, ['zt', 'status']));
  const pyzt = squash(pick(row, ['pyzt', 'gradeStatus']));
  const deadline = toTime(pick(row, ['jzsj', 'jzsjStr', 'deadline', 'deadlineStr']));
  const submitted = zt === '已交';
  const graded = pyzt === '已批改';

  let statusText = '状态未知';
  if (submitted && graded) statusText = '已提交 · 已批改';
  else if (submitted) statusText = '已提交 · 待批阅';
  else if (zt === '未交') statusText = '未提交';

  return {
    id: `zy:${wlkcid}:${xszyid || zyid || hashString(title)}`,
    title,
    url: abs(homeworkUrl({ wlkcid, zyid, xszyid, zt, pyzt, deadline, now })),
    submitUrl: xszyid ? abs(PAGE.homeworkSubmit(wlkcid, xszyid)) : '',
    listUrl: abs(PAGE.homeworkList(wlkcid)),
    deadline,
    deadlineText: squash(pick(row, ['jzsjStr', 'deadlineStr'])),
    submitDate: toTime(pick(row, ['scsjStr', 'scsj', 'submitTime'])),
    gradeDate: toTime(pick(row, ['pysjStr', 'pysj'])),
    grade: squash(pick(row, ['cj', 'score'])),
    teacher: squash(pick(row, ['jsm', 'teacher'])),
    mode: String(pick(row, ['zywcfs'], '')) === '2' ? '小组' : '个人',
    zt,
    pyzt,
    status: submitted ? 'done' : zt === '未交' ? 'pending' : 'unknown',
    statusText,
    completed: submitted,
    // 作业说明：列表行里有时会带（不同接口版本不一致），没有就等详情页补全
    description: squash(pick(row, ['nr', 'yq', 'ms', 'content', 'sm', 'zyyq', 'zyshuoming', 'yaoqiu', 'wtms'])),
    // 附件：列表行里可能给文件名（fjmc 之类的字段）
    attachments: pick(row, ['fjmc', 'fjmcStr', 'fjs', 'fjsStr'])
      ? [{ name: squash(pick(row, ['fjmc', 'fjmcStr', 'fjs', 'fjsStr'])), url: '', ext: '', kind: 'file' }]
      : [],
    detailEnriched: false,
    section: 'homework',
    source: 'api',
    fetchedAt: now,
  };
}

/** 把接口给的学期对象列表收敛成一个学期码 */
export function pickSemester(json, fallback = '') {
  const list = Array.isArray(json) ? json : (json && (json.resultList || json.data || json.list)) || [];
  if (!Array.isArray(list) || !list.length) return fallback;
  const codeOf = (o) => squash(o && (o.xnxq || o.xnxqbh || o.code || o.value || o.id));
  const current = list.find((o) => o && (o.sfdq === '1' || o.sfdq === 1 || o.current === true || o.isCurrent === true || o.dqxnxq === '1'));
  return codeOf(current) || codeOf(list[0]) || fallback;
}

/** 从作业链接里把 id 抠出来（兜底路径拿到的只有 href） */
export function idsFromHomeworkUrl(url) {
  const out = { wlkcid: '', zyid: '', xszyid: '', view: '' };
  const m = String(url || '').match(/\/student\/(viewZy|viewTj|viewCj|tijiao)/);
  if (m) out.view = m[1];
  const get = (k) => {
    const r = new RegExp(`[?&]${k}=([^&#]+)`, 'i').exec(String(url || ''));
    return r ? decodeURIComponent(r[1]) : '';
  };
  out.wlkcid = get('wlkcid');
  out.zyid = get('zyid');
  out.xszyid = get('xszyid');
  return out;
}

/**
 * 兜底路径（后台标签页读渲染后的表格）拿到的行 -> 统一模型。
 *
 * 这里有一处很关键的取巧：作业状态不用去猜文字，而是看站点自己生成的链接——
 * viewZy=未交、viewTj=已交未批改、viewCj=已批改，比任何文本匹配都准。
 */
export function fromScrapedItem(raw, kind, wlkcid, now = Date.now()) {
  const cells = raw.cells || {};
  const rowText = `${raw.rowText || ''} ${Object.values(cells).join(' ')}`;
  const title = squash(raw.title) || squash(rowText).slice(0, 80);
  if (!title) return null;

  if (kind === 'homework') {
    const ids = idsFromHomeworkUrl(raw.url);
    const deadline = toTime(cells.deadline) ?? extractDeadline(cells.deadline || rowText, now).deadline;
    const zt = ids.view === 'viewZy' || (!ids.view && /未交|未提交/.test(cells.status || '')) ? '未交' : '已交';
    const pyzt = ids.view === 'viewCj' ? '已批改' : ids.view === 'viewTj' ? '未批阅' : '';
    const submitted = zt === '已交';
    return {
      id: `zy:${wlkcid}:${ids.xszyid || ids.zyid || hashString(title)}`,
      title,
      url: raw.url || abs(homeworkUrl({ wlkcid, zyid: ids.zyid, xszyid: ids.xszyid, zt, pyzt, deadline, now })),
      submitUrl: ids.xszyid ? abs(PAGE.homeworkSubmit(wlkcid, ids.xszyid)) : '',
      listUrl: abs(PAGE.homeworkList(wlkcid)),
      deadline,
      deadlineText: squash(cells.deadline),
      deadlineInferred: !cells.deadline && !!deadline,
      submitDate: toTime(cells.submit),
      gradeDate: null,
      grade: squash(cells.grade),
      teacher: squash(cells.teacher),
      mode: /小组|组/.test(cells.mode || '') ? '小组' : '个人',
      zt,
      pyzt,
      status: submitted ? 'done' : zt === '未交' ? 'pending' : 'unknown',
      statusText: submitted ? (pyzt === '已批改' ? '已提交 · 已批改' : '已提交 · 待批阅') : zt === '未交' ? '未提交' : '状态未知',
      completed: submitted,
      text: squash(rowText).slice(0, 300),
      section: 'homework',
      source: 'tab-dom',
      fetchedAt: now,
    };
  }

  if (kind === 'file') {
    const fk = fileKind(title, cells.type || '');
    return {
      id: `wj:${wlkcid}:${hashString(title + (raw.url || ''))}`,
      title,
      url: abs(PAGE.fileList(wlkcid)),
      downloadUrl: raw.url || '',
      date: toTime(cells.date) ?? toTime(rowText),
      size: parseSize(cells.size || ''),
      typeHint: squash(cells.type),
      ext: fk.ext,
      fileKind: fk.kind,
      pinned: false,
      text: squash(cells.type || ''),
      section: 'file',
      source: 'tab-dom',
      fetchedAt: now,
    };
  }

  return {
    id: `gg:${wlkcid}:${hashString(title + (raw.url || ''))}`,
    title,
    url: raw.url || abs(PAGE.noticeList(wlkcid)),
    date: toTime(cells.date) ?? toTime(rowText),
    author: squash(cells.author),
    pinned: /置顶/.test(rowText),
    // 表格里能读到“未读”就标未读，读不到就是未知 —— 不要谎报已读
    unread: /未读/.test(rowText) ? true : null,
    attachment: '',
    text: squash(rowText).slice(0, 300),
    section: 'notice',
    source: 'tab-dom',
    fetchedAt: now,
  };
}

/**
 * DOM 解析器（parsers/list-page.js）产出的条目 -> 统一模型。
 *
 * DOM 条目里日期已经是 epoch ms，链接也已经绝对化，比纯文本兜底路径信息更全，
 * 所以单独走一条映射，不再退化成字符串重新解析。
 */
export function fromDomItem(it, kind, wlkcid, now = Date.now()) {
  if (!it || !it.title) return null;

  if (kind === 'homework') {
    const ids = idsFromHomeworkUrl(it.url);
    // 链接本身就编码了状态：viewZy=未交、viewTj=已交未批改、viewCj=已批改
    const zt = ids.view === 'viewZy' ? '未交' : ids.view ? '已交' : (it.status === 'done' ? '已交' : '未交');
    const pyzt = ids.view === 'viewCj' ? '已批改' : ids.view === 'viewTj' ? '未批阅' : '';
    const deadline = it.deadline || null;
    const submitted = zt === '已交';
    return {
      id: it.id || `zy:${wlkcid}:${ids.xszyid || ids.zyid || hashString(it.title)}`,
      title: it.title,
      url: it.url || abs(homeworkUrl({ wlkcid, zyid: ids.zyid, xszyid: ids.xszyid, zt, pyzt, deadline, now })),
      submitUrl: ids.xszyid ? abs(PAGE.homeworkSubmit(wlkcid, ids.xszyid)) : '',
      listUrl: abs(PAGE.homeworkList(wlkcid)),
      deadline,
      deadlineText: deadline ? '' : (it.deadlineReason || ''),
      deadlineInferred: !!it.deadlineInferred,
      submitDate: null,
      gradeDate: null,
      grade: '',
      teacher: '',
      mode: '个人',
      zt,
      pyzt,
      status: submitted ? 'done' : 'pending',
      statusText: submitted ? (pyzt === '已批改' ? '已提交 · 已批改' : '已提交 · 待批阅') : '未提交',
      completed: submitted,
      text: it.text || '',
      section: 'homework',
      source: 'tab-dom',
      fetchedAt: now,
    };
  }

  if (kind === 'file') {
    const fk = fileKind(it.title, it.url || '');
    return {
      id: it.id || `wj:${wlkcid}:${hashString(it.title + (it.url || ''))}`,
      title: it.title,
      url: abs(PAGE.fileList(wlkcid)),
      downloadUrl: it.downloadUrl || '',
      date: it.date || null,
      size: it.size || null,
      typeHint: it.ext || '',
      ext: it.ext || fk.ext,
      fileKind: it.fileKind || fk.kind,
      pinned: false,
      text: it.text || '',
      section: 'file',
      source: 'tab-dom',
      fetchedAt: now,
    };
  }

  return {
    id: it.id || `gg:${wlkcid}:${hashString(it.title + (it.url || ''))}`,
    title: it.title,
    url: it.url || abs(PAGE.noticeList(wlkcid)),
    date: it.date || null,
    author: '',
    pinned: false,
    // DOM 路径没法像接口那样拿到 sfyd，只能看页面上有没有“未读”的标记；
    // 判断不了就置 null（未知），**不要谎报成已读**
    unread: /未读/.test(it.text || '') ? true : null,
    attachment: '',
    text: it.text || '',
    section: 'notice',
    source: 'tab-dom',
    fetchedAt: now,
  };
}

export { truncate };
