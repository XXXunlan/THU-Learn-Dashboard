/**
 * 预览页用的假 chrome API 与假数据。
 *
 * 为什么必须放在**独立文件**里：扩展页面的 CSP 是 `script-src 'self'`，
 * 内联 <script> 会被直接拦掉（控制台会报 "Executing inline script violates ..."），
 * 于是 mock 根本不生效，面板会去问真实的后台 Service Worker 并拿到空状态 ——
 * 现象看起来像“渲染没生效”，实际上是被 CSP 挡了。这个坑值得记下来。
 *
 * 另外：虽然页面跑在 chrome-extension:// 下，`window.chrome` 是真实 API，
 * 直接 `window.chrome = {...}` 会被静默忽略（非严格模式），必须逐属性覆盖。
 */

(function mockChrome() {
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const mk = (o) => Object.assign({
    source: 'api', text: '', ext: '', fileKind: 'file', size: null,
    completed: false, status: 'pending', statusText: '未提交',
    deadline: null, urgency: null, date: null, deadlineInferred: false,
  }, o);

  const courses = [
    {
      id: '2026-2027-1000000001',
      name: '数据结构',
      url: 'https://learn.tsinghua.edu.cn/f/wlxt/course/index?wlkcid=A',
      teacher: '张三',
      term: '2026-2027秋季学期',
      location: '六教 6A201',
      code: '',
      sectionLinks: {
        notice: 'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforePageListXs?wlkcid=A&sfgk=0',
        file: 'https://learn.tsinghua.edu.cn/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=A&sfgk=0',
        homework: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/beforePageList?wlkcid=A',
      },
      errors: [],
      announcements: [
        mk({ id: 'gg:1', title: '关于期中考试安排的通知', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=A&id=11', date: now - 2 * HOUR, author: '李四', section: 'notice', unread: true, text: '期中考试定于第 8 周周六上午，请同学们注意考试地点与座位号安排。' }),
      ],
      files: [
        mk({ id: 'wj:1', title: '第3章_树与二叉树.pdf', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=A', downloadUrl: 'https://learn.tsinghua.edu.cn/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=31', date: now - 26 * HOUR, size: 2411724, ext: 'pdf', fileKind: 'pdf', section: 'file' }),
        mk({ id: 'wj:2', title: '实验二_源码框架.zip', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=A', downloadUrl: 'https://learn.tsinghua.edu.cn/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=32', date: now - 4 * 24 * HOUR, size: 819200, ext: 'zip', fileKind: 'zip', section: 'file' }),
      ],
      homework: [
        mk({ id: 'zy:1', title: '第一次作业：线性表与链表', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewZy?wlkcid=A&sfgq=1&zyid=1&xszyid=11', deadline: now - 6 * HOUR, urgency: 'overdue', section: 'homework',
          description: '示例作业说明：请从本窗口下载示例作业模板，并按要求完成以下任务。\n填写示例问卷；\n阅读一份示例材料并写出简要说明；\n就一个示例话题提出一个你想研究的具体问题。',
          attachments: [{ name: '习题模板.docx', url: 'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/downloadFile?wjid=T1', ext: 'docx', kind: 'doc' }] }),
        mk({ id: 'zy:2', title: '实验二：二叉树遍历实现', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewZy?wlkcid=A&sfgq=0&zyid=2&xszyid=12', deadline: now + 5 * HOUR, urgency: 'critical', section: 'homework',
          description: '实现前序、中序、后序三种遍历，并提交源码与实验报告。',
          attachments: [
            { name: '实验二_源码框架.zip', url: 'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/downloadFile?wjid=T2', ext: 'zip', kind: 'zip' },
            { name: '实验报告模板.pdf', url: 'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/downloadFile?wjid=T3', ext: 'pdf', kind: 'pdf' },
          ] }),
        mk({ id: 'zy:3', title: '作业1 HW#1（站点上本来就没写说明）', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewZy?wlkcid=A&sfgq=0&zyid=3&xszyid=13', deadline: now + 3 * 24 * HOUR, urgency: 'soon', section: 'homework', deadlineInferred: true,
          description: '', descriptionSource: 'empty:作业说明',
          attachments: [{ name: '作业1.pdf', url: 'https://learn.tsinghua.edu.cn/b/wlxt/kczy/zy/student/downloadFile?wjid=T4', ext: 'pdf', kind: 'pdf' }] }),
        mk({ id: 'zy:4', title: '已经交过的作业（默认不应出现）', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewTj?wlkcid=A&zyid=4&xszyid=14', deadline: now + 2 * 24 * HOUR, urgency: 'soon', section: 'homework', completed: true, status: 'done', statusText: '已提交 · 待批阅' }),
        // 雨课堂的作业（另一个平台）：带平台标记、**没有说明字段**（改用章节名占位）、
        // 完成度是题数进度而不是「已交/未交」。这两条用来验证并进来之后的卡片长什么样。
        mk({ id: 'zy:A:ykt:3000001:5000002', title: '第一周作业', url: 'https://pro.yuketang.cn/ai-workspace/lms-graph/3000001/exercise/5000002?is_chapter=1&node_id=6000001', deadline: now + 12 * 24 * HOUR, urgency: 'far', section: 'homework',
          platform: 'yuketang', source: 'yuketang', classroomId: '3000001', leafId: '5000002', chapterName: '示例教材（上）',
          status: 'pending', completed: false, progressText: '0/6', statusText: '未完成（雨课堂 0/6）', description: '', attachments: [], detailEnriched: true }),
        mk({ id: 'zy:A:ykt:3000001:5000001', title: '第0次作业（雨课堂已完成，默认不应出现）', url: 'https://pro.yuketang.cn/ai-workspace/lms-graph/3000001/exercise/5000001?is_chapter=1&node_id=6000001', deadline: now + 20 * 24 * HOUR, urgency: 'far', section: 'homework',
          platform: 'yuketang', source: 'yuketang', classroomId: '3000001', leafId: '5000001', chapterName: '示例教材（上）',
          status: 'done', completed: true, progressText: '2/2', statusText: '已完成（雨课堂 2/2）', description: '', attachments: [], detailEnriched: true }),
      ],
    },
    {
      id: '2026-2027-1000000002',
      name: '示例课程E',
      url: 'https://learn.tsinghua.edu.cn/f/wlxt/course/index?wlkcid=B',
      teacher: '王五',
      term: '2026-2027秋季学期',
      location: '',
      code: '',
      sectionLinks: {},
      errors: [{ scope: 'file', message: '接口没有返回数据；兜底渲染后仍无条目' }],
      announcements: [
        mk({ id: 'gg:2', title: '本周课堂安排调整', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=B&id=21', date: now - 5 * 24 * HOUR, author: '王五', section: 'notice', text: '本周改为线上进行。' }),
        mk({ id: 'gg:3', title: '期末论文选题说明', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?wlkcid=B&id=22', date: now - 8 * 24 * HOUR, author: '王五', section: 'notice' }),
      ],
      files: [],
      homework: [
        mk({ id: 'zy:5', title: '期末论文提纲', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewZy?wlkcid=B&zyid=5&xszyid=15', deadline: now + 10 * 24 * HOUR, urgency: 'far', section: 'homework' }),
      ],
    },
    {
      id: '2026-2027-1000000003',
      name: '高等数学（3）',
      url: 'https://learn.tsinghua.edu.cn/f/wlxt/course/index?wlkcid=C',
      teacher: '',
      term: '',
      location: '',
      code: '',
      sectionLinks: {},
      errors: [],
      announcements: [],
      files: [
        mk({ id: 'wj:3', title: '习题课讲义.pptx', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=C', downloadUrl: 'https://learn.tsinghua.edu.cn/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=33', date: now - 12 * 24 * HOUR, size: 5242880, ext: 'pptx', fileKind: 'ppt', section: 'file' }),
      ],
      homework: [
        mk({ id: 'zy:6', title: '习题册第 5 章（未标注截止）', url: 'https://learn.tsinghua.edu.cn/f/wlxt/kczy/zy/student/viewZy?wlkcid=C&zyid=6&xszyid=16', section: 'homework' }),
      ],
    },
  ];

  const state = {
    settings: {
      autoRefreshMinutes: 60, showCompletedHomework: false, hideEmptyCourses: false,
      deepScanHomework: false, tabFallback: true, tabSettleMs: 3500,
      rememberCredentials: false, autoLogin: true, concurrency: 4,
      maxItemsPerCourse: 60, freshDays: 3, floatingButton: true, theme: 'auto',
      // 调试功能默认关闭 —— 预览页据此验证「默认隐藏、打开开关才出现」
      debugMode: false, yuketangHomework: true,
    },
    cache: {
      fetchedAt: now - 4 * 60 * 1000,
      durationMs: 8421,
      errors: [],
      stats: {
        courses: 3, notices: 3, files: 3, homework: 7, pending: 6, dueSoon: 3,
        methods: { 'course-list': 'api:GET+csrf', csrf: 'tab:page-helper', semester: '2026-2027-1' },
        yuketang: { ok: true, needPermission: false, classrooms: 3, matched: 3, unmatched: 0, found: 5, added: 2, listVia: '接口响应（/v2/api/web/classrooms）', listPath: '/v2/api/web/classrooms' },
      },
      courses,
    },
    session: { loggedIn: true, loginMethod: 'session', lastError: '', needsManualLogin: false, loginUrl: '', loginForm: null },
    progress: null,
    hasSavedPassword: false,
    username: '2026xxxxxx',
  };

  const mockRuntime = {
    getURL: (p) => p,
    getManifest: () => ({ version: '1.0.0-preview' }),
    sendMessage: (msg) => {
      if (msg && msg.type === 'getState') return Promise.resolve({ ok: true, state });
      // 设置要真的写回 state —— 否则 loadState 里的表单回填会把刚改的开关盖回去，
      // 预览页就测不出「打开开关后面板出现」这件事了。
      if (msg && msg.type === 'updateSettings') {
        Object.assign(state.settings, (msg.payload && msg.payload.patch) || {});
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.type === 'exportDiagnostics') return Promise.resolve({ ok: false, error: 'preview' });
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {} },
  };
  const mockPermissions = { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) };
  const mockTabs = { create: () => Promise.resolve({ id: 1 }) };

  let installed = false;
  try {
    Object.defineProperty(window.chrome, 'runtime', { value: mockRuntime, configurable: true, writable: true });
    Object.defineProperty(window.chrome, 'permissions', { value: mockPermissions, configurable: true, writable: true });
    Object.defineProperty(window.chrome, 'tabs', { value: mockTabs, configurable: true, writable: true });
    installed = window.chrome.runtime === mockRuntime;
  } catch (err) {
    installed = false;
  }

  window.__MOCK_INSTALLED__ = installed;
  window.__PREVIEW__ = { state };
  const banner = document.createElement('div');
  banner.id = 'mock-status';
  banner.style.cssText = 'margin:0;padding:6px 12px;background:#eaf6ec;color:#2e7d32;font:12px sans-serif';
  banner.textContent = installed ? 'mock chrome API 已生效（预览数据）' : 'mock 未生效：chrome.runtime 覆盖失败';
  document.addEventListener('DOMContentLoaded', () => {
    document.body.insertBefore(banner, document.body.firstChild);
    // 面板默认停在「作业」标签，切到「全部」才能把公告/文件/作业三类卡片一次性渲染出来，
    // 这样一次无头渲染就能验证全部卡片形态。
    setTimeout(() => {
      const tab = document.querySelector('.tab[data-tab="all"]');
      if (tab) tab.click();
    }, 500);

    // 顺便**真的模拟一次悬停**，验证「移上去看全文」这条链路是通的
    // （不测的话，这个功能坏掉也不会有任何自动化的信号）
    setTimeout(() => {
      const notes = [];
      const desc = document.querySelector('.card-desc');
      if (!desc) {
        notes.push('找不到 .card-desc（说明没渲染出来）');
      } else {
        const cs = getComputedStyle(desc);
        const rect = desc.getBoundingClientRect();
        notes.push(`desc: scrollH=${desc.scrollHeight} clientH=${desc.clientHeight} rectH=${Math.round(rect.height)} w=${Math.round(rect.width)} display=${cs.display} whiteSpace=${cs.whiteSpace} clamp=${cs.webkitLineClamp}`);
        notes.push(`文本前30字: ${(desc.textContent || '').slice(0, 30)}`);
        desc.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const pop = document.querySelector('.desc-pop');
        if (pop) {
          const visible = pop.style.display !== 'none' && pop.style.visibility !== 'hidden';
          notes.push(`desc-pop ${visible ? '可见' : '不可见'}，长度 ${(pop.textContent || '').length}`);
        } else {
          notes.push('desc-pop 未创建（悬停没生效）');
        }
      }
      const attach = document.querySelector('.tag-attach');
      notes.push(attach ? `附件标记: ${attach.textContent.trim()}` : '没有附件标记');

      // 雨课堂那两条：平台标记、状态措辞、没有说明时的占位、以及"已完成要隐藏"
      const ykt = document.querySelector('.tag-platform');
      notes.push(ykt ? `雨课堂标记: ${ykt.textContent.trim()}` : 'BUG: 没有雨课堂标记');
      if (ykt) {
        const card = ykt.closest('.card');
        const st = card && card.querySelector('.status');
        const d = card && card.querySelector('.card-desc');
        notes.push(`雨课堂状态: ${st ? st.textContent.trim() : '无'}`);
        notes.push(`雨课堂说明行: ${d ? d.textContent.trim().slice(0, 30) : '无'}`);
      }
      const shownCompleted = Array.from(document.querySelectorAll('.card-title'))
        .some((t) => t.textContent.includes('雨课堂已完成'));
      notes.push(shownCompleted ? 'BUG: 已完成的雨课堂作业被显示出来了' : '已完成的雨课堂作业已隐藏');

      // 调试功能默认必须藏起来；打开开关后才出现
      const panel = document.querySelector('#debug-panel');
      const dbgBox = document.querySelector('#set-debugMode');
      if (!panel || !dbgBox) {
        notes.push('BUG: 找不到调试面板或调试开关');
      } else {
        const hiddenNow = panel.classList.contains('hidden');
        notes.push(hiddenNow ? '调试功能默认隐藏 ✓' : 'BUG: 调试功能默认没有隐藏');
        dbgBox.checked = true;
        dbgBox.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
          notes.push(panel.classList.contains('hidden') ? 'BUG: 打开开关后调试面板仍隐藏' : '打开开关后调试面板出现 ✓');
          banner.textContent = `mock: ${installed ? 'ok' : 'FAILED'} | ${notes.join(' | ')}`;
        }, 60);
      }
      banner.textContent = `mock: ${installed ? 'ok' : 'FAILED'} | ${notes.join(' | ')}`;
    }, 1000);
  });
})();
