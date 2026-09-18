/**
 * 轻量日志。保留固定长度的环形缓冲，便于在面板的“诊断”里回看，
 * 也便于用户导出问题现场。
 */

const MAX = 400;
const buffer = [];

const LEVEL_STYLE = {
  debug: 'color:#8a8a8a',
  info: 'color:#5b6b8c',
  warn: 'color:#b26a00',
  error: 'color:#c62828',
};

function push(level, scope, args) {
  const entry = {
    t: Date.now(),
    level,
    scope,
    msg: args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' '),
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`%c[${scope}]`, LEVEL_STYLE[level] || '', ...args);
  return entry;
}

export function createLogger(scope) {
  return {
    debug: (...a) => push('debug', scope, a),
    info: (...a) => push('info', scope, a),
    warn: (...a) => push('warn', scope, a),
    error: (...a) => push('error', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export function dumpLogs() {
  return buffer.slice();
}

export function clearLogs() {
  buffer.length = 0;
}

export const log = createLogger('app');
