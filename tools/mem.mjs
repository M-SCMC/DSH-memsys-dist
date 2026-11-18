#!/usr/bin/env node
/**
 * mem.mjs — DSH 记忆系统核心工具
 *
 * 基于认知科学设计的六层记忆：
 *   L1 工作记忆  → pages.idx（本工具生成）
 *   L2 情景记忆  → 40-归档/episodes/YYYY-MM/EP-*.md  (append-only)
 *   L3 语义记忆  → 10-项目/ 20-决策/  (source 标记 + superseded)
 *   L3' 程序记忆 → 30-习惯/procedures/P-*.md
 *   L3'' 前瞻记忆→ 不入库，走 schedule
 *   L4 遗忘      → compact（活化度衰减 + 按比例压缩）
 *
 * 用法：
 *   node mem.mjs index                     重建 pages.idx
 *   node mem.mjs recall "关键词A 关键词B"        按线索召回
 *   node mem.mjs episode --schema X --title Y --cues "a;b" --body-file F
 *   node mem.mjs distill [--apply]         夜间蒸馏
 *   node mem.mjs compact [--apply]         季度压缩
 *   node mem.mjs audit                     健康检查
 *   node mem.mjs stats                     统计
 *
 * 依赖：Node >= 18，零外部包。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

// 记忆库路径改为延迟解析（2026-11-18）
//
// 原因：init 命令要在"库还不存在"的目录里运行，
// 如果模块加载时就调 findVault()，init 会被它的报错 exit 挡住。
// 所以所有路径都改成 lazy getter，第一次真正用到时才解析。
let _vaultCache = null;
function getVault() {
  if (!_vaultCache) _vaultCache = process.env.MEM_VAULT || findVault();
  return _vaultCache;
}
function getSYS() { return path.join(getVault(), '99-系统', '记忆系统'); }
function getIDX() { return path.join(getSYS(), 'pages.idx'); }
function getLOG() { return path.join(getSYS(), 'access.log.jsonl'); }
function getDistillLogDir() { return path.join(getSYS(), 'distill-logs'); }
function getSnapshotDir() { return path.join(getSYS(), 'snapshots'); }
function getEpisodeDir() { return path.join(getVault(), '40-归档', 'episodes'); }
function getProcedureDir() { return path.join(getVault(), '30-习惯', 'procedures'); }




// 扫描时跳过的目录
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.mem']);

// 各类页面的权重（用于排序）
const KIND_WEIGHT = {
  procedure: 1.5,
  decision: 1.2,
  fact: 1.2,
  project: 1.0,
  habit: 1.1,
  episode: 0.8,
  index: 0.3,
  record: 0.6,
};

// ─────────────────────────────────────────────────────────────
// CLI 参数解析（集中在一处，避免每加一个 flag 就漏一次）
//
// 历史教训（2026-11-18 犯了 2 次）：
//   · `--spread-limit 8` → 8 被当成查询词
//   · `--note "文字"` → 文字被当成文件路径
// 根因都是各命令自己维护 flag 白名单，新增 flag 时忘了同步。
// 现在改成全局注册：所有 flag 必须在下表登记，否则解析时会报警。
// ─────────────────────────────────────────────────────────────

// 带值的 flag
const FLAG_WITH_VALUE = new Set([
  'limit', 'min-score', 'spread-limit', 'spread-min-ratio',
  'schema', 'title', 'cues', 'project', 'salience', 'body-file', 'body',
  'outcome', 'lesson', 'corrections', 'expectation', 'trust',
  'reason', 'by', 'note', 'days',
]);

// 纯开关
const FLAG_BOOL = new Set(['spread', 'graph', 'apply', 'ok', 'success', 'fail', 'failed']);

/**
 * 解析从第 startIdx 位开始的位置参数，正确跳过所有 flag 及其值。
 * 返回 { positional, flags }
 */
/**
 * 定位记忆库根目录。
 *
 * 优先级（2026-11-18 调整，适配 npx 场景）：
 *   1. 环境变量 MEM_VAULT   —— 显式指定，最高优先级
 *   2. 当前目录本身         —— npx 场景：cd 到自己的库再跑
 *   3. 向上查找             —— 在子目录里跑也能找到根
 *   4. 副作用的兜底          —— 都没有就自动初始化当前目录（首次使用体验）
 */
function findVault() {
  if (process.env.MEM_VAULT) return process.env.MEM_VAULT;

  const cwd = process.cwd();

  // 当前目录本身就是库（有 99-系统/记忆系统 或有 .md 文件）
  if (fs.existsSync(path.join(cwd, '99-系统', '记忆系统'))) return cwd;

  // 向上找
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '99-系统', '记忆系统'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 当前目录里已经有 .md 文件 → 当成库，让它自动初始化
  try {
    const hasMd = fs.readdirSync(cwd).some(f => f.endsWith('.md'));
    const hasDirs = ['10-项目', '20-决策', '99-系统']
      .some(d => fs.existsSync(path.join(cwd, d)));
    if (hasMd || hasDirs) return cwd;
  } catch { /* 读不了就算了 */ }

  // 什么都没有 → 首次使用，把当前目录初始化为库
  console.error('');
  console.error('未检测到记忆库。');
  console.error('');
  console.error(`当前目录：${cwd}`);
  console.error('里面没有 .md 文件，也没有记忆系统目录。');
  console.error('');
  console.error('三个选择：');
  console.error('');
  console.error('  ① 在当前目录新建一个库（推荐新手）：');
  console.error(`       node "${process.argv[1]}" init`);
  console.error('');
  console.error('  ② 指向你已有的 Obsidian / Markdown 库：');
  console.error(`       set MEM_VAULT=D:\\path\\to\\your\\vault     (Windows CMD)`);
  console.error(`       $env:MEM_VAULT="D:\\path\\to\\your\\vault"  (PowerShell)`);
  console.error(`       export MEM_VAULT=/path/to/your/vault       (Linux/macOS)`);
  console.error('');
  console.error('  ③ 用安装脚本装到指定目录：');
  console.error(`       node "${path.join(path.dirname(process.argv[1]), 'setup.mjs')}" D:\\path\\to\\new\\vault`);
  console.error('');
  process.exit(1);
}

function parseArgs(startIdx) {
  const positional = [];
  const flags = {};
  for (let i = startIdx; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }

    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);

    if (eq !== -1) {
      // --key=value 形式
      flags[name] = raw.slice(eq + 1);
      continue;
    }
    if (FLAG_BOOL.has(name)) { flags[name] = true; continue; }
    if (FLAG_WITH_VALUE.has(name)) {
      const nxt = process.argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) {
        flags[name] = nxt; i++;
      } else {
        flags[name] = true;
      }
      continue;
    }
    // 未注册的 flag：保留原行为（当开关），但记录以便排查
    flags[name] = true;
    flags.__unregistered = flags.__unregistered || [];
    flags.__unregistered.push(name);
  }
  return { positional, flags };
}

// ─────────────────────────────────────────────────────────────
// Frontmatter 解析（无依赖，支持 YAML 子集）
// ─────────────────────────────────────────────────────────────

function stripBOM(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // 去引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(text) {
  text = stripBOM(text);
  if (!text.startsWith('---')) return { data: {}, body: text, hasFM: false };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFM: false };

  const fmRaw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');

  const data = {};
  let currentKey = null;
  let currentArr = null;

  for (const line of fmRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    // 数组项 "  - value"
    const arrMatch = line.match(/^(\s+)-\s+(.*)$/);
    if (arrMatch && currentArr !== null) {
      currentArr.push(parseScalar(arrMatch[2]));
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, key, valRaw] = kvMatch;
      const val = valRaw.trim();
      if (val === '') {
        // 可能是数组或嵌套对象开始
        currentKey = key;
        currentArr = [];
        data[key] = currentArr;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // 行内数组 [a, b, c]
        const inner = val.slice(1, -1).trim();
        data[key] = inner ? inner.split(',').map(s => parseScalar(s)) : [];
        currentKey = null;
        currentArr = null;
      } else {
        data[key] = parseScalar(val);
        currentKey = null;
        currentArr = null;
      }
    }
  }

  return { data, body, hasFM: true };
}

function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${JSON.stringify(String(item))}`);
      }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 扫描与索引
// ─────────────────────────────────────────────────────────────

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      yield full;
    }
  }
}

function rel(p) {
  return path.relative(getVault(), p).replace(/\\/g, '/');
}

// 语义类型的归一化映射：把库里 35 种自由 type 归到 7 个标准类
const TYPE_ALIASES = {
  decision: ['decision', 'adr', '决策'],
  fact: ['fact', '事实'],
  procedure: ['procedure', '流程', '步骤'],
  episode: ['episode', '情景'],
  project: ['project', '项目', 'project-note', 'project-detail'],
  habit: ['habit', '习惯', '偏好'],
  index: ['index', '索引', '目录', '总览'],
  // 其余全部归为 record（记录类，比如会话档案、证据、日志）
  record: [
    'memory', 'session', '技术文档', '汇总', '环境记录', 'checklist',
    '诊断', '目标重审', 'guide', '排雷清单', '运维记录', '权威状态页',
    '交接', '交付', '台账', '修复', '总结', '项目总结', '收束', '更新日志',
    '总账', '决定性数据', '决定性成果', '纠正', '结构性成果', '进展',
    'subpage', '其它',
  ],
};

const ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(TYPE_ALIASES)) {
    for (const a of aliases) m.set(a.toLowerCase(), canonical);
  }
  return m;
})();

function inferKind(data, relPath) {
  // 路径优先级最高：Episode 和 procedure 有严格目录约定
  if (relPath.includes('/episodes/')) return 'episode';
  if (relPath.includes('/procedures/')) return 'procedure';

  // 其次看 ADR 文件名
  if (/\/ADR-[^/]+\.md$/.test(relPath)) return 'decision';
  if (relPath.includes('/决策/')) return 'decision';

  // 再看 type 字段（归一化）
  if (data.type) {
    const raw = String(data.type).toLowerCase().trim();
    const mapped = ALIAS_LOOKUP.get(raw);
    if (mapped) return mapped;
  }

  // 最后看路径
  if (relPath.startsWith('20-决策/')) return 'decision';
  if (relPath.startsWith('10-项目/')) return 'project';
  if (relPath.startsWith('30-习惯/')) return 'habit';
  if (relPath.startsWith('99-系统/')) return 'record';
  if (relPath.includes('索引')) return 'index';
  return 'record';
}

function extractTitle(data, body, relPath) {
  if (data.title) return String(data.title);
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(relPath, '.md');
}

function extractCues(data) {
  const out = [];
  if (Array.isArray(data.cues)) {
    for (const c of data.cues) if (c) out.push(String(c));
  }
  if (data.cue) out.push(String(data.cue));
  if (Array.isArray(data.keys)) {
    for (const k of data.keys) if (k) out.push(String(k));
  }
  return out;
}

function scanVault() {
  const pages = [];
  for (const file of walk(getVault())) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relPath = rel(file);

    // 跳过模板文件：它们是空壳，不是真实记忆
    if (relPath.includes('/模板/') || relPath.includes('/记忆系统/模板')) continue;
    const base = path.basename(relPath);
    if (/模板|template/i.test(base)) continue;

    const { data, body } = parseFrontmatter(text);
    const kind = inferKind(data, relPath);
    const title = extractTitle(data, body, relPath);
    const cues = extractCues(data);

    // 正文前 400 字作为摘要
    const plain = body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*`>\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = Array.from(plain).length;
    const mtime = fs.statSync(file).mtimeMs;

    pages.push({
      path: relPath,
      kind,
      title,
      cues,
      project: data.project || null,
      schema: data.schema || null,
      source: data.source || null,

      // ── 可信度（2026-11-18 从 source 拆出）──
      //
      // 为什么改名：库里原有的 `source` 意思是「出处」（"会话 2026-10-22（...）"），
      // 82 页在用；我今天加的 `source` 意思是「可信度」（verified/...），26 页在用。
      // 同名不同义会导致规则和执行对不上。所以可信度改用 trust，
      // 原 source 一字不动——零破坏。
      trust: data.trust || null,
      trust_auto: data.trust_auto === true,
      trust_manual: data.trust_manual === true,
      status: data.status || null,
      // ── 自我纠错（2026-11-18 新增）──
      superseded_by: data.superseded_by || null,
      refuted: data.refuted === true || data.refuted === 'true',
      refuted_by: data.refuted_by || null,
      refuted_reason: data.refuted_reason || null,

      // ── 重要性权重（2026-11-18 修复：之前建了但从不参与打分）──
      salience: typeof data.salience === 'number' ? data.salience : (parseFloat(data.salience) || null),

      // ── 程序记忆的实战统计 ──
      times_applied: parseInt(data.times_applied, 10) || 0,
      success_rate: data.success_rate === null || data.success_rate === undefined
        ? null : parseFloat(data.success_rate),
      size: words,
      mtime: Math.round(mtime / 1000),
      digest: crypto.createHash('sha1').update(plain.slice(0, 800)).digest('hex').slice(0, 12),
      preview: plain.slice(0, 160),
    });
  }
  return pages;
}

function buildIndex(pages) {
  const sorted = pages.slice().sort((a, b) => {
    const wa = KIND_WEIGHT[a.kind] ?? 0.5;
    const wb = KIND_WEIGHT[b.kind] ?? 0.5;
    if (wb !== wa) return wb - wa;
    return b.mtime - a.mtime;
  });

  const lines = [];
  lines.push('# pages.idx — L1 工作记忆目录');
  lines.push('# 由 mem.mjs index 生成，请勿手工编辑');
  lines.push(`# generated: ${new Date().toISOString()}`);
  lines.push(`# total: ${sorted.length}`);
  lines.push('');

  for (const p of sorted) {
    const cueStr = p.cues.length ? p.cues.slice(0, 6).join(' | ') : '-';
    lines.push(`[${p.kind}] ${p.path}`);
    lines.push(`  title: ${p.title}`);
    lines.push(`  cues: ${cueStr}`);
    if (p.source) lines.push(`  source: ${p.source}`);
    if (p.superseded_by) lines.push(`  superseded_by: ${p.superseded_by}`);
    lines.push(`  size: ${p.size} chars`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 访问日志与活化度（Anderson & Schooler 1991）
// ─────────────────────────────────────────────────────────────

function appendLog(entry) {
  fs.mkdirSync(getSYS(), { recursive: true });
  fs.appendFileSync(getLOG(), JSON.stringify({ t: Date.now(), ...entry }) + '\n', 'utf8');
}

function readLog() {
  if (!fs.existsSync(getLOG())) return [];
  const out = [];
  for (const line of fs.readFileSync(getLOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

/**
 * 活化度：Anderson & Schooler (1991) 的 power-law 需求概率
 *
 * 原式 A = ln(1 + Σt^-0.5)，t 以「秒」为单位。
 * 致命缺陷（2026-11-18 实测发现）：
 *   1 小时前访问一次 → t=3600 → t^-0.5 = 0.0167 → A = 0.0165
 *   这远低于压缩阈值 0.15，等于「几乎所有东西都该被压缩」。
 * 根因：秒级时间尺度让衰减快得离谱，人类遗忘是「天」级的，不是秒级。
 *
 * 修正：以「天」为时间单位，并用半衰期形式重写。
 *   A = Σ 0.5^(Δt / halfLife)
 *   halfLife 默认 30 天（Anderson & Schooler 报告人类记忆的 power-law 指数
 *   约 -0.5，对应"30 天损失约一半"的量级）
 *
 * 性质：
 *   - 刚访问一次 → A ≈ 1.0
 *   - 30 天前访问一次 → A ≈ 0.5
 *   - 90 天前 → A ≈ 0.125
 *   - 反复访问会叠加（人类的高频记忆确实更强）
 */
function activation(accessTimes, now = Date.now(), halfLifeDays = 30) {
  const DAY = 86400 * 1000;
  const halfLife = halfLifeDays * DAY;
  let sum = 0;
  for (const t of accessTimes) {
    const dt = now - t;
    if (dt < 0) continue;
    sum += Math.pow(0.5, dt / halfLife);
  }
  return sum;
}

function activationMap() {
  const log = readLog();
  const byPath = new Map();
  for (const e of log) {
    // 只认 used（真正被引用），不认 recall（只是被列出）
    if (e.op !== 'used') continue;
    if (!e.path) continue;
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    byPath.get(e.path).push(e.t);
  }
  const out = new Map();
  for (const [p, times] of byPath) out.set(p, activation(times));
  return out;

}

// ─────────────────────────────────────────────────────────────
// 检索（编码特异性 + 三因子打分）
// ─────────────────────────────────────────────────────────────

// 中文高频虚词：不作为检索 token，否则淹没所有结果
const CJK_STOP = new Set(
  '的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 什么 怎么 为什么 因为 所以 但 但是 如果 可以 需要 进行 通过 以及 或者 还有 这个 那个 我们 他们 它 与 及 等 中 下 后 前 时 用 被 把 给 对 从 向 里 外 上 内 个 那些 这些 之 而 其 于 以 为 于 即 则 所 由 并'.split(/\s+/)
);

function isCjk(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

function tokenize(q) {
  const s = q.toLowerCase().trim();
  const tokens = new Set();
  if (!s) return { phrase: '', tokens: [] };

  // 英文/数字词（>=2 字符）
  for (const m of s.matchAll(/[a-z0-9_+#.]{2,}/g)) {
    const w = m[0];
    if (!CJK_STOP.has(w)) tokens.add(w);
  }

  // 中文：只取 2-gram 和 3-gram，不取单字（单字噪声太大）
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= cjk.length; i++) {
      const g = cjk.slice(i, i + n);
      if (!CJK_STOP.has(g)) tokens.add(g);
    }
  }

  return { phrase: s, tokens: [...tokens] };
}

/**
 * 打分：覆盖率主导 + IDF 加权质量
 *
 * 核心修正（2026-11-18）：
 * 之前用加法聚合 token 命中，导致"崩溃"这种高频词能靠单点命中拉满分数。
 * 现在改为：覆盖率（命中 token 数 / 查询 token 数）作为幂次乘数，
 * 命中 1/4 的文档与命中 4/4 的文档差距 ≥ 16 倍。
 *
 * 依据：编码特异性（Tulving & Thomson 1973）——
 * 线索必须与编码时匹配，匹配得越完整越可信。
 */
function scorePage(p, q, df, totalDocs) {
  const { phrase, tokens } = q;
  const titleL = p.title.toLowerCase();
  const pathL = p.path.toLowerCase();
  const previewL = p.preview.toLowerCase();
  const cuesL = p.cues.map(c => c.toLowerCase());

  // ① 线索精确匹配（最强信号，直接加分不参与覆盖率计算）
  let cueBonus = 0;
  for (const cl of cuesL) {
    if (phrase && cl === phrase) cueBonus += 40;
    else if (phrase && phrase.length >= 2 && (cl.includes(phrase) || phrase.includes(cl))) cueBonus += 15;
  }

  // ② 短语整体命中标题 / 路径
  let phraseBonus = 0;
  if (phrase && phrase.length >= 2) {
    if (titleL.includes(phrase)) phraseBonus += 30;
    if (pathL.includes(phrase)) phraseBonus += 18;
  }

  // ③ 逐 token 计算命中质量
  let matched = 0;
  let qualitySum = 0;

  for (const t of tokens) {
    const dfv = df.get(t) || 1;
    const idf = Math.log(1 + totalDocs / dfv);

    let quality = 0;
    if (titleL.includes(t)) quality = 30 + 10 * idf;
    else if (pathL.includes(t)) quality = 20 + 7 * idf;
    else if (cuesL.some(c => c.includes(t))) quality = 15 + 6 * idf;
    else if (previewL.includes(t)) quality = 2 * idf;

    if (quality > 0) {
      matched += 1;
      const isProper = /^[a-z0-9_+#.]{2,}$/.test(t) || /\d/.test(t);
      qualitySum += quality * (isProper ? 1.6 : 1.0);
    }
  }

  if (matched === 0 && cueBonus === 0 && phraseBonus === 0) return 0;

  const coverage = tokens.length > 0 ? matched / tokens.length : (phrase ? 1 : 0);
  const coverageWeight = Math.min(tokens.length / 3, 1);
  const coverageScore = Math.pow(coverage, 2) * 100 * coverageWeight;

  let segmentBonus = 0;
  for (const seg of p.path.split('/').slice(0, -1)) {
    const segL = seg.toLowerCase();
    if (phrase && phrase.length >= 2 && segL.includes(phrase)) {
      segmentBonus = Math.max(segmentBonus, 25);
    }
  }

  let score = qualitySum + coverageScore + cueBonus + phraseBonus + segmentBonus;

  // ⑤ 类型权重
  const kw = KIND_WEIGHT[p.kind] ?? 0.5;
  score *= kw;

  // ⑥ 新近权重（recency）：新观点优先于老观点
  //
  // 依据：Murdock (1962) 近因效应 + Anderson & Schooler (1991) 需求概率里
  //       新近度是三大因子之一。人的记忆里，刚学到的东西比多年前的更可信。
  //
  // 语义页（decision/fact/project）用半衰期 1 年：
  //   · 1 天内  → ×1.00
  //   · 3 个月  → ×0.84
  //   · 1 年    → ×0.50
  //   · 3 年    → ×0.13
  // 太老的结论即使文本匹配度一样，也应排在新结论之后。
  //
  // 但不压到 0：老的金科玉律（如 路径含中文导致崩溃）依然要能被搜到，
  // 只是同分时让位给新的。所以下限设 0.15，不归零。
  const RECENCY_HALFLIFE_DAYS = 365;
  const ageDays = (Date.now() - p.mtime * 1000) / 86400000;
  let recency = Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALFLIFE_DAYS);
  recency = Math.max(recency, 0.15);   // 下限：老知识不消失
  score *= recency;

  // ⑥' 重要性权重（salience）
  //
  // 修复（2026-11-18）：salience 字段建了很久，但打分里从来没用过——
  // 又一个"建了不接线"的死字段。用户手标的「这条很重要」等于白标。
  //
  // 映射：salience 0.5 为中性（×1.0），1.0 为最高（×1.5），0 为最低（×0.5）
  if (typeof p.salience === 'number' && p.salience !== null) {
    const s = Math.max(0, Math.min(1, p.salience));
    score *= (0.5 + s);   // 0→0.5, 0.5→1.0, 1.0→1.5
  }

  // ⑥'' 程序记忆的实证表现
  //
  // 修复（2026-11-18）：times_applied / success_rate 建了但从不更新、也从不接线。
  // 现在至少让"成功率"参与排序——屡次失败的老流程不该排在前面。
  if (p.kind === 'procedure' && p.success_rate !== null && p.times_applied > 0) {
    // 成功率 0.5 以下开始明显降权，1.0 保持原值
    const sr = Math.max(0, Math.min(1, p.success_rate));
    score *= (0.4 + 0.6 * sr);   // 0→0.4, 0.5→0.7, 1.0→1.0
  }

  // ⑦ superseded 降权（提取诱发遗忘：被取代的旧结论主动压制）
  // ⑧ refuted 直接排除（错的信念彻底弃用，不是降权）
  //
  // 区分（2026-11-18）：
  //   superseded → 0.2 倍，还能被搜到（"当时是这么想的"）
  //   refuted    → 0 倍，完全不出现（"这条是错的，不要再用"）
  // 对应人类：过时的知识偶尔还能想起来，但错的信念会被彻底弃用。
  if (p.refuted) return 0;
  if (p.superseded_by) score *= 0.2;

  // ⑨ 已归档降权（Episode 例外）
  if (p.path.startsWith('40-归档/') && !p.path.includes('/episodes/')) score *= 0.7;

  return score;
}

/** 计算文档频率（用于 IDF） */
function buildDF(pages, tokens) {
  const df = new Map();
  for (const t of tokens) {
    let n = 0;
    for (const p of pages) {
      if (
        p.title.toLowerCase().includes(t) ||
        p.path.toLowerCase().includes(t) ||
        p.preview.toLowerCase().includes(t)
      ) n++;
    }
    df.set(t, Math.max(n, 1));
  }
  return df;
}

function recall(query, pages, opts = {}) {
  const limit = opts.limit ?? 12;
  const minScore = opts.minScore ?? 2;
  const q = tokenize(query);
  if (q.tokens.length === 0 && !q.phrase) return [];

  const df = buildDF(pages, q.tokens);
  const actMap = activationMap();

  const scored = [];
  for (const p of pages) {
    let s = scorePage(p, q, df, pages.length);
    if (s <= 0) continue;
    const act = actMap.get(p.path) ?? 0;
    s *= 1 + Math.min(act, 5) * 0.12;
    if (s >= minScore) scored.push({ ...p, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  // 注意：这里不再写 recall 日志。
  //
  // 原因（2026-11-18 修）：原来「检索到」就算「用过」，导致
  //   - 召回 12 条、我实际只用 1 条，12 条全部被强化
  //   - 反复召回同一批页面会把它们的活化度刷到虚高
  //   - 活化度本应反映"这个知识真的被需要过"，不是"被列表出来过"
  //
  // 改为：只有调用方显式确认使用了某页时，才记 `used` 事件。
  // 见 markUsed()。人类记忆也是这样——想起 10 个候选，只有真正用上的那个被巩固。
  return top;
}

/** 显式标记"这一页真的被用上了"，这才是强化记忆的正确信号 */
function markUsed(paths, query = '') {
  for (const p of paths) {
    appendLog({ op: 'used', path: p, q: query });
  }
}

/**
 * 记录一次 procedure 的实战结果（2026-11-18 新增）
 *
 * 解决的问题：times_applied / success_rate 建了很久，
 * 但全代码库没有任何写入点——procedure 的实战统计永远是初始值，
 * 导致「屡次失败的老流程」和「刚写的新流程」在打分上没区别，
 * 失效流程永远淘汰不掉。
 *
 * 人类对应：程序性记忆靠反复使用被强化，靠反复失败被废弃。
 * 不记成败，就学不会「这条路走不通」。
 *
 * @param notes 叶节点路径（30-习惯/procedures/P-xxxx.md）
 * @param ok    true = 成功，false = 失败
 */
function recordProcedureUse(notePath, ok, { note = '' } = {}) {
  const full = path.join(getVault(), notePath);
  if (!fs.existsSync(full)) return { ok: false, reason: '文件不存在' };

  let text = fs.readFileSync(full, 'utf8');
  const i = text.indexOf('\n---', 3);
  if (i === -1) return { ok: false, reason: '无 frontmatter' };

  let fm = text.slice(3, i);
  const body = text.slice(i);

  const getNum = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*([\\d.]+)`, 'm'));
    return m ? parseFloat(m[1]) : null;
  };

  const prevTimes = Math.floor(getNum('times_applied') ?? 0);
  const prevRate = getNum('success_rate');

  const newTimes = prevTimes + 1;
  // 增量式成功率：既考虑历史，也考虑这一次
  const prevSucc = prevRate === null ? null : prevRate * prevTimes;
  const newRate = prevSucc === null
    ? (ok ? 1 : 0)
    : (prevSucc + (ok ? 1 : 0)) / newTimes;

  const setField = (key, val) => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (re.test(fm)) fm = fm.replace(re, `${key}: ${val}`);
    else fm = fm.replace(/\s*$/, '') + `\n${key}: ${val}`;
  };

  setField('times_applied', newTimes);
  setField('success_rate', Math.round(newRate * 100) / 100);
  setField('last_applied', JSON.stringify(new Date().toISOString().slice(0, 10)));

  if (note) {
    // 追加到「使用记录」表末尾
    const stamp = new Date().toISOString().slice(0, 10);
    const row = `| ${stamp} | ${note} | ${ok ? '成功' : '失败'} | |`;
    if (/## 使用记录/.test(body)) {
      text = '---' + fm + body.replace(/(\|[^\n]*\n)(\s*$)/, `$1${row}\n$2`);
    } else {
      text = '---' + fm + body + `\n\n## 使用记录\n\n| 日期 | 场景 | 结果 | 备注 |\n|---|---|---|---|\n${row}\n`;
    }
  } else {
    text = '---' + fm + body;
  }

  fs.writeFileSync(full, text, 'utf8');
  appendLog({ op: 'procedure_use', path: notePath, ok });

  return {
    ok: true,
    times: newTimes,
    rate: Math.round(newRate * 100) / 100,
    prevTimes,
    prevRate,
  };
}

// ─────────────────────────────────────────────────────────────
// 情景记忆：写 Episode
// ─────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function nowParts() {
  const d = new Date();
  return {
    y: d.getFullYear(),
    m: pad2(d.getMonth() + 1),
    d: pad2(d.getDate()),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
    iso: d.toISOString(),
  };
}

function createEpisode({ schema, title, cues, body, project, salience, outcome, corrections, lesson, expectation, trust }) {
  const t = nowParts();
  const dir = path.join(getEpisodeDir(), `${t.y}-${t.m}`);
  fs.mkdirSync(dir, { recursive: true });

  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  const id = `EP-${t.y}${t.m}${t.d}-${t.hh}${t.mm}-${rand}`;
  const file = path.join(dir, `${id}.md`);

  const fm = {
    type: 'episode',
    id,
    when: `${t.y}-${t.m}-${t.d}T${t.hh}:${t.mm}:${t.ss}+08:00`,
    schema: schema || '未分类',
    project: project || '未归属',
    salience: salience ?? 0.5,
    status: 'raw',

    // 可信度（2026-11-18 补接线）
    // 之前 CLI 收了 --trust 参数但 createEpisode 没写进 frontmatter，
    // 导致 11 条 Episode 全部缺 trust —— 又一次「建了不接线」。
    trust: trust || 'verified',   // Episode 是亲历记录，默认 verified

    // ── 自我进化字段（2026-11-18 新增）──
    // 人类记忆不只存"发生了什么"，还存"这事成没成、错在哪、学到什么"。
    // 没有这三个字段，系统就记不住自己犯过的错，必然重复犯错。
    outcome: outcome || 'unknown',      // success | partial | failure | unknown

    // ── 预期校验（2026-11-18 新增）──
    //
    // 解决的问题：contradictions 只能抓"形式矛盾"（A 说要 X，B 说不要 X），
    // 抓不出"这条结论本身算错了"——比如活化度公式量级错 100 倍，
    // 库里只有一份公式，没有矛盾，它只是错的。
    //
    // 人类靠什么发现这种错？靠"用起来不对"：以为会保留，结果被压了。
    // 所以让系统显式写下"我以为会发生什么"，事后对照，不符即信号。
    expectation: expectation || null,   // "以为会发生什么"
    expectation_held: null,             // true | false | null（未校验）

    corrections: corrections || [],    // 用户或自己纠错过的点
    lesson: lesson || null,            // 一句话经验（可蒸馏成 procedure）

    cues: cues || [],

    // derived_from：这条 Episode 读了哪些旧页
    //
    // ⚠ 2026-11-18 明确决定「暂不接线」：
    //   蒸馏只产出提案、不自动改语义页，所以没有可信的回填来源。
    //   硬填等于伪造溯源，比空着更糟。
    //   等蒸馏真能自动合并内容时再启用。
    //   检查工具 check-wiring.mjs 会把这条报为「只写不读」，属预期状态。
    derived_from: [],
    superseded_by: null,
  };

  const content = [
    serializeFrontmatter(fm),
    '',
    `# ${title || id}`,
    '',
    body || '（待补充）',
    '',
  ].join('\n');

  fs.writeFileSync(file, content, 'utf8');
  appendLog({ op: 'episode', path: rel(file), id, outcome: fm.outcome });

  // ── 自动冲突检测（2026-11-18，用户要求「让系统自动去做」）──
  //
  // 解决的问题：原来的链路是「人发现旧结论错了 → 人跑 refute → 系统执行」。
  // 第一步依赖人，系统自己不会发现。现在改成：
  //   新 Episode 一落盘，立刻拿它的 cues 反查库里的相关页，
  //   把「可能被这条新结论影响」的旧页列出来，写进冲突待裁决清单。
  //
  // 系统自己发现，人只做最后裁决。
  let conflicts = [];
  try {
    conflicts = detectConflictsForEpisode({ id, relPath: rel(file), cues, title, body, outcome: fm.outcome });
  } catch (e) {
    // 检测失败不影响 Episode 落盘本身
    conflicts = [{ error: e.message }];
  }

  return { id, file, relPath: rel(file), conflicts };
}

/**
 * 为一个新 Episode 检测它可能推翻/影响哪些旧结论。
 *
 * 判据（不依赖 LLM，纯规则）：
 *   1. cues/title 反查 → 命中旧页
 *   2. 新 Episode 正文里出现「错/过时/不对/推翻/相反/实际是」这类词
 *      → 说明这是一条纠错性记录，命中的旧页高度可疑
 *   3. 命中的旧页不是 Episode 本身、不是索引、不是 record
 *
 * 输出：写进 proposals/冲突待裁决.md，并返回列表
 */
function detectConflictsForEpisode({ id, relPath, cues, title, body, outcome }) {
  // 纠错词表（2026-11-18 收紧两次）
  //
  // 第一次收：去掉「实测发现」「实际是」这类中性描述词。
  //   原表太宽，正文「真实库压测」+ cue 含「真实」→ 误命中 8 条无关页。
  //
  // 第二次收（当前）：只认「明确宣布某结论是错的」的表述。
  const NEGATION_WORDS = [
    '是错的', '结论错', '判断错', '之前错', '原先错',
    '推翻', '不成立', '作废', '失效',
    '误判', '算错', '搞错', '不对',
  ];

  const titleText = String(title || '');
  const bodyText = String(body || '');

  const titleHasNeg = NEGATION_WORDS.some(w => titleText.includes(w));
  const bodyHasNeg = NEGATION_WORDS.some(w => bodyText.includes(w));

  // 触发条件收紧（2026-11-18）：
  //   原条件：正文含纠错词就触发 → 误报太多（描述性文本里也有这些词）
  //   新条件：必须 **标题宣布纠错** 或 **outcome=failure 且正文有纠错词**
  //   理由：标题是"这条记录的主题声明"，正文可能只是顺带提到。
  const isCorrectionRecord =
    titleHasNeg ||
    (outcome === 'failure' && bodyHasNeg);

  if (!isCorrectionRecord) return [];

  const pages = scanVault();

  // ── 逐 cue 独立检索，取交集（2026-11-18 第四版）──
  //
  // 前三版都失败，根因是同一个：把多个 cue 拼成一个 query 后，
  // 某个高频词（"路径"、"失败"）会把无关页顶到高分，
  // 而真正该抓的 ADR-0037 因为标题不匹配而分数偏低。
  //
  // 第四版换思路：**每个 cue 单独搜，统计候选页被几个 cue 命中**。
  // 被 ≥2 个不同 cue 命中的页才算嫌疑——这才符合"多个线索指向同一处"的直觉。
  const cueList = [...(cues || []), title].filter(Boolean).map(String);
  if (cueList.length === 0) return [];

  const hitMap = new Map();   // path → { page, cues: Set, maxScore }

  for (const cue of cueList) {
    const res = recall(cue, pages, { limit: 10, minScore: 3 });
    for (const r of res) {
      if (r.path === relPath) continue;
      if (['index', 'record', 'episode'].includes(r.kind)) continue;
      if (r.refuted) continue;

      if (!hitMap.has(r.path)) hitMap.set(r.path, { page: r, cues: new Set(), maxScore: 0 });
      const e = hitMap.get(r.path);
      e.cues.add(cue);
      e.maxScore = Math.max(e.maxScore, r.score);
    }
  }

  // 被 ≥2 个不同 cue 命中 → 强嫌疑
  const suspects = [...hitMap.values()]
    .filter(e => e.cues.size >= 2)
    .map(e => ({ ...e.page, score: e.maxScore, hitBy: e.cues.size }))
    .sort((a, b) => b.hitBy - a.hitBy || b.score - a.score)
    .slice(0, 8);

  if (suspects.length === 0) return [];

  // 写待裁决清单
  const dir = path.join(getSYS(), 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '冲突待裁决.md');

  // 写清单前先检查：这个（新结论 + 旧页集合）是不是已经记过
  // 2026-11-18 修：重复跑同一主题会累积重复条目，清单会越滚越长
  const existTxt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';

  const sig = suspects.map(s => s.path).sort().join('|');
  const claimSig = String(title || '').trim();
  const isDuplicate = existTxt.includes(`**新结论**：${claimSig}`) &&
    suspects.every(s => existTxt.includes(s.path));

  if (isDuplicate) {
    appendLog({ op: 'conflict_detected', path: relPath, suspects: suspects.length, duplicate: true });
    return suspects.map(s => ({ path: s.path, title: s.title, score: Math.round(s.score * 10) / 10 }));

  }

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `## ${ts}  ← 由 ${id} 自动检出`,
    '',
    `**新结论**：${title}`,
    '',
    `**可能被影响的旧页**（${suspects.length} 条，按相关度排序）：`,
    '',
  ];
  for (const s of suspects) {
    lines.push(`- [ ] \`${s.path}\``);
    lines.push(`      ${s.title || ''}  （相关度 ${s.score.toFixed(1)}）`);
  }
  lines.push('');
  lines.push('**处置**：`node mem.mjs review` 查看，`--confirm N` 确认，`--reject N` 拒绝。');
  lines.push('');
  lines.push('---');
  lines.push('');

  fs.writeFileSync(f, existTxt + lines.join('\n'), 'utf8');

  appendLog({ op: 'conflict_detected', path: relPath, suspects: suspects.length });

  // ── 自动纠错：默认关闭，需显式开启（2026-11-18 重要修正）──
  //
  // 血泪教训：第一版自动纠错没有置信度门槛，实测时把 ADR-0037
  // （讲 IDA 的正确结论）标成了「被 EP-xxx 取代」，差点污染真实库。
  // 根因：cues 命中 ≥2 就算嫌疑，这个判据对"自动执行"来说太弱。
  //
  // 现在的安全设计：
  //   · 默认只「报告」，不自动改
  //   · 要自动改必须同时满足：
  //       1. Episode 是 failure/partial
  //       2. 标题含强否定词
  //       3. 环境变量 MEM_AUTO_SUPERSEDE=1 显式开启
  //       4. 命中的旧页在"同一项目内"（跨项目自动纠错风险最高）
  //       5. 单次最多 1 条（而非 3 条）
  //   · 全部改动可通过 `mem.mjs rollback` 一键撤销
  const autoEnabled = process.env.MEM_AUTO_SUPERSEDE === '1';
  const fileProject = projectOf(relPath);

  const autoTitleText = String(title || '');
  const STRONG_TITLE = ['是错的', '结论错', '判断错', '推翻', '不成立', '作废'];
  const titleSaysWrong = STRONG_TITLE.some(w => autoTitleText.includes(w));
  const sameProject = (p) => {
    const pj = projectOf(p);
    return pj && fileProject && pj === fileProject;
  };

  if (autoEnabled && (outcome === 'failure' || outcome === 'partial') && titleSaysWrong) {
    const eligible = suspects.filter(s => sameProject(s.path)).slice(0, 1);
    const autoFixed = [];

    for (const s of eligible) {
      const full = path.join(getVault(), s.path);
      let txt;
      try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }

      const fi = txt.indexOf('\n---', 3);
      if (fi === -1) continue;
      let fm2 = txt.slice(3, fi);
      if (/^(refuted|superseded_by)\s*:/m.test(fm2)) continue;

      // 备份 + 记录可回滚
      const bakDir = path.join(getSYS(), 'backups');
      fs.mkdirSync(bakDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bakName = `${path.basename(s.path, '.md')}.${stamp}.bak`;
      fs.writeFileSync(path.join(bakDir, bakName), txt, 'utf8');

      fm2 = fm2.replace(/\s*$/, '') + `\nsuperseded_by: ${JSON.stringify(id)}\nauto_superseded: true`;
      fs.writeFileSync(full, '---' + fm2 + txt.slice(fi), 'utf8');

      appendLog({
        op: 'supersede', path: s.path, by: id, mode: 'superseded',
        auto: true, backup: bakName,
      });
      autoFixed.push({ path: s.path, backup: bakName });
    }

    if (autoFixed.length) {
      appendLog({ op: 'auto_supersede', episode: id, count: autoFixed.length });
      return suspects.map(s => {
        const f = autoFixed.find(a => a.path === s.path);
        return { ...s, autoSuperseded: !!f, backup: f?.backup };
      });
    }
  }

  return suspects.map(s => ({ path: s.path, title: s.title, score: Math.round(s.score * 10) / 10 }));
}

// ─────────────────────────────────────────────────────────────
// 蒸馏（模拟睡眠；CLS 交错复现）
// ─────────────────────────────────────────────────────────────

/**
 * 蒸馏：raw Episode → 语义页的巩固
 *
 * 修前（2026-11-18 前）：只把 status: raw 改成 distilled，什么都不做。
 * 这是"假装工作"——机制存在但不产生任何效果，是最难发现的缺陷。
 *
 * 修后：真正产出三样东西
 *   1. 失败清单（failures.md）—— 按 outcome=failure/partial 聚合，这是"别再犯"的依据
 *   2. 经验池（lessons.md）—— 按 lesson 字段聚合
 *   3. 蒸馏提案（proposals/）—— 每个 Episode 一条，含"建议合并进哪一页"
 *
 * 为什么不全自动改语义页：自动改写知识页的风险（覆盖、分叉）远大于漏写。
 * 所以蒸馏产出「提案 + 聚合层」，改知识页仍需人工确认。
 * 这对应人类的睡眠巩固：海马体复现给皮层，皮层自己决定怎么改写。
 */
function distill({ apply = false, limit = 20 } = {}) {
  const pages = scanVault();
  const rawEpisodes = pages.filter(p => p.kind === 'episode' && p.status === 'raw');

  if (rawEpisodes.length === 0) {
    return { message: '没有 status: raw 的 Episode，无需蒸馏', count: 0 };
  }

  // 读每个 Episode 的完整 frontmatter（outcome / lesson / corrections / schema）
  const details = rawEpisodes.map(e => {
    let data = {};
    try {
      data = parseFrontmatter(fs.readFileSync(path.join(getVault(), e.path), 'utf8')).data;
    } catch { /* 保底空对象 */ }
    return {
      path: e.path,
      title: e.title,
      schema: data.schema || '未分类',
      project: data.project || '未归属',
      outcome: data.outcome || 'unknown',
      lesson: data.lesson || null,
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
    };
  });

  // 按 schema 分组
  const groups = new Map();
  for (const d of details) {
    if (!groups.has(d.schema)) groups.set(d.schema, []);
    groups.get(d.schema).push(d);
  }

  // 失败与纠错聚合
  const failures = details.filter(d => d.outcome === 'failure' || d.outcome === 'partial');
  const allCorrections = details.flatMap(d => d.corrections.map(c => ({ ep: d.path, text: c })));
  const lessons = details.filter(d => d.lesson);

  const projects = new Set(details.map(d => d.project).filter(Boolean));
  const interleaved = projects.size > 1;

  const report = {
    timestamp: new Date().toISOString(),
    rawCount: details.length,
    projects: [...projects],
    interleaved,
    interleavedNote: interleaved
      ? `涉及 ${projects.size} 个项目，满足 CLS 交错复现要求`
      : `只涉及 1 个项目（${[...projects][0] || '未知'}），警告：缺少交错复现，可能灾难性遗忘`,
    groups: [...groups.entries()].map(([schema, eps]) => ({
      schema,
      count: eps.length,
      suggestProcedure: eps.length >= 3,
      episodes: eps.map(e => e.path),
    })),
    failures: failures.map(f => ({ path: f.path, title: f.title, outcome: f.outcome })),
    corrections: allCorrections,
    lessons: lessons.map(l => ({ path: l.path, lesson: l.lesson })),
    applied: false,
  };

  if (apply) {
    const ts = new Date().toISOString().slice(0, 10);
    const consolidateDir = path.join(getSYS(), 'consolidated');
    fs.mkdirSync(consolidateDir, { recursive: true });

    // ① 失败清单（追加式，永久累积）
    if (failures.length || allCorrections.length) {
      const fFail = path.join(consolidateDir, 'failures.md');
      const exist = fs.existsSync(fFail) ? fs.readFileSync(fFail, 'utf8') : '# 失败与纠错台账\n\n> 每次蒸馏追加。这是"别再犯同样的错"的唯一依据。\n\n';
      const lines = [`## ${ts}`, ''];
      for (const f of failures) {
        lines.push(`- **${f.outcome}** ${f.title}`);
        lines.push(`  - ${f.path}`);
      }
      for (const c of allCorrections) {
        lines.push(`- **纠错** ${c.text}`);
        lines.push(`  - ${c.ep}`);
      }
      lines.push('');
      fs.writeFileSync(fFail, exist + lines.join('\n') + '\n', 'utf8');
    }

    // ② 经验池
    if (lessons.length) {
      const fLes = path.join(consolidateDir, 'lessons.md');
      const exist = fs.existsSync(fLes) ? fs.readFileSync(fLes, 'utf8') : '# 经验池\n\n> 每次蒸馏追加。可蒸馏成 procedure 的候选。\n\n';
      const lines = [`## ${ts}`, ''];
      for (const l of lessons) {
        lines.push(`- ${l.lesson}`);
        lines.push(`  - ${l.path}`);
      }
      lines.push('');
      fs.writeFileSync(fLes, exist + lines.join('\n') + '\n', 'utf8');
    }

    // ③ 蒸馏提案
    const propDir = path.join(getSYS(), 'proposals');
    fs.mkdirSync(propDir, { recursive: true });
    for (const g of report.groups) {
      const fProp = path.join(propDir, `${ts}-${g.schema}.md`);
      const content = [
        `# 蒸馏提案：${g.schema}`,
        '',
        `生成于 ${ts}`,
        '',
        `## 来源 Episode（${g.count} 条）`,
        '',
        ...g.episodes.map(e => `- ${e}`),
        '',
        g.suggestProcedure
          ? '## ⚠ 建议抽成 procedure\n\n同一 schema 已达 3 条，符合 `30-习惯/procedures/` 的新增门槛。'
          : '## 暂不建议抽 procedure\n\n同类不足 3 条。',
        '',
        '## 待人工确认',
        '',
        '- [ ] 这些结论该合并进哪个语义页？',
        '- [ ] 有没有互相矛盾的？',
        '- [ ] 有哪些应当标 superseded_by？',
      ].join('\n');
      fs.writeFileSync(fProp, content, 'utf8');
    }

    // ④ 标记已蒸馏
    for (const e of rawEpisodes.slice(0, limit)) {
      const full = path.join(getVault(), e.path);
      let text = fs.readFileSync(full, 'utf8');
      text = text.replace(/^status:\s*"?raw"?\s*$/m, 'status: distilled');
      fs.writeFileSync(full, text, 'utf8');
    }

    report.applied = true;
    report.distilledCount = Math.min(rawEpisodes.length, limit);
    report.outputs = ['consolidated/failures.md', 'consolidated/lessons.md', `proposals/${ts}-*.md`];
  }

  // 写蒸馏日志
  fs.mkdirSync(getDistillLogDir(), { recursive: true });
  const logName = `distill-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(path.join(getDistillLogDir(), logName), JSON.stringify(report, null, 2), 'utf8');

  return report;
}

// ─────────────────────────────────────────────────────────────
// 压缩（SHY：按比例下调；不删 cues/source）
// ─────────────────────────────────────────────────────────────

function compact({ apply = false, threshold = 0.15, archiveDays = 180 } = {}) {
  const pages = scanVault();
  const actMap = activationMap();
  const now = Date.now();
  const archiveMs = archiveDays * 24 * 3600 * 1000;

  const candidates = [];

  // ① Episode：活化度低 + 够老 → 压成一行（cues/source 全留）
  for (const p of pages) {
    if (p.kind !== 'episode') continue;
    if (p.status === 'pruned') continue;

    const act = actMap.get(p.path) ?? 0;
    const ageMs = now - p.mtime * 1000;

    // 失败经历永不压缩：那是"别再犯"的依据
    let outcome = null;
    try { outcome = parseFrontmatter(fs.readFileSync(path.join(getVault(), p.path), 'utf8')).data.outcome; } catch {}
    if (outcome === 'failure') {
      candidates.push({ path: p.path, title: p.title, activation: act, ageDays: Math.round(ageMs / 86400000), action: 'protect-failure' });
      continue;
    }

    if (act < threshold && ageMs > archiveMs) {
      candidates.push({
        path: p.path, title: p.title,
        activation: Math.round(act * 1000) / 1000,
        ageDays: Math.round(ageMs / 86400000),
        size: p.size, action: 'prune',
      });
    } else if (act >= threshold) {
      candidates.push({
        path: p.path, title: p.title,
        activation: Math.round(act * 1000) / 1000,
        ageDays: Math.round(ageMs / 86400000),
        size: p.size, action: 'keep',
      });
    }
  }

  // ② 【新增】语义页的「淡出」——不压缩正文，只标 stale
  //
  // 人类语义记忆也会淡，但方式和情景记忆不同：
  // 情景记忆是「细节消失、只留骨架」，语义记忆是「还知道，但不确定还准不准」。
  // 所以语义页不压缩，只标记「需要复核」。
  const stalePages = [];
  for (const p of pages) {
    if (!['decision', 'fact', 'project'].includes(p.kind)) continue;
    const act = actMap.get(p.path) ?? 0;
    const ageMs = now - p.mtime * 1000;

    // 从未被 used 过 + 超过 1 年 → 标记 stale
    if (act === 0 && ageMs > 365 * 24 * 3600 * 1000) {
      stalePages.push({ path: p.path, title: p.title, ageDays: Math.round(ageMs / 86400000) });
    }
  }

  const toPrune = candidates.filter(c => c.action === 'prune');

  const report = {
    timestamp: new Date().toISOString(),
    totalEpisodes: pages.filter(p => p.kind === 'episode').length,
    pruned: toPrune.length,
    kept: candidates.filter(c => c.action === 'keep').length,
    protectedFailures: candidates.filter(c => c.action === 'protect-failure').length,
    staleSemantic: stalePages.length,
    candidates,
    stalePages: stalePages.slice(0, 20),
    applied: false,
  };

  if (apply && toPrune.length > 0) {
    // 先做快照
    fs.mkdirSync(getSnapshotDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapFile = path.join(getSnapshotDir(), `before-compact-${stamp}.jsonl`);
    const snapLines = toPrune.map(c => {
      const full = path.join(getVault(), c.path);
      return JSON.stringify({ path: c.path, content: fs.readFileSync(full, 'utf8') });
    });
    fs.writeFileSync(snapFile, snapLines.join('\n'), 'utf8');

    // 执行压缩：正文压成一行，cues 保留
    for (const c of toPrune) {
      const full = path.join(getVault(), c.path);
      const text = fs.readFileSync(full, 'utf8');
      const { data, body } = parseFrontmatter(text);

      data.status = 'pruned';
      data.pruned_at = new Date().toISOString();
      data.pruned_from_size = c.size;

      const firstLine = body
        .split('\n')
        .map(l => l.replace(/^#+\s*/, '').trim())
        .filter(l => l && !l.startsWith('---'))[0] || '（无正文）';

      const newBody = [
        '',
        `# ${data.title || c.title}`,
        '',
        '> 已压缩（季度 downscaling）。正文摘要保留一行，cues 与 source 完整保留。',
        `> 原始快照：${path.basename(snapFile)}`,
        '',
        `**摘要**：${firstLine.slice(0, 200)}`,
        '',
      ].join('\n');

      fs.writeFileSync(full, serializeFrontmatter(data) + '\n' + newBody, 'utf8');
    }

    report.applied = true;
    report.snapshot = path.basename(snapFile);
  }

  return report;
}

// ─────────────────────────────────────────────────────────────
// 审计（健康检查）
// ─────────────────────────────────────────────────────────────

function audit() {
  const pages = scanVault();
  const actMap = activationMap();

  const issues = [];

  // 1. 重复结论（同 digest 的语义页）
  const byDigest = new Map();
  for (const p of pages) {
    if (!['decision', 'fact', 'project'].includes(p.kind)) continue;
    if (!byDigest.has(p.digest)) byDigest.set(p.digest, []);
    byDigest.get(p.digest).push(p.path);
  }
  for (const [digest, paths] of byDigest) {
    if (paths.length > 1) {
      issues.push({ type: 'duplicate', severity: 'warn', detail: `重复内容 ${digest}`, paths });
    }
  }

  // 2. 缺 trust 的语义页（可信度未标）
  //
  // 修复（2026-11-18）：原来检查的是「缺 source」，
  // 但 source 在库里是「出处」语义，82 页都有，所以这个检查从来没意义。
  // 现在检查 trust（可信度），并且**同时校验取值合法性**——
  // 只查有无不查取值，正是之前漏掉 84 页违规的原因。
  const VALID_TRUST = new Set(['verified', 'reported', 'inferred', 'recalled']);
  const missingTrust = pages.filter(
    p => ['decision', 'fact'].includes(p.kind) && !p.trust
  );
  if (missingTrust.length > 0) {
    issues.push({
      type: 'missing-trust',
      severity: 'info',
      detail: `${missingTrust.length} 条语义页未标可信度（trust）`,
      paths: missingTrust.slice(0, 15).map(p => p.path),
    });
  }

  // 2'. 非法 trust 值
  const badTrust = pages.filter(
    p => p.trust && !VALID_TRUST.has(String(p.trust))
  );
  if (badTrust.length > 0) {
    issues.push({
      type: 'invalid-trust',
      severity: 'warn',
      detail: `${badTrust.length} 条页面的 trust 取值不在四选一内`,
      paths: badTrust.map(p => `${p.path}  → ${String(p.trust).slice(0, 40)}`),
    });
  }

  // 3. 孤儿 procedure
  const procPages = pages.filter(p => p.kind === 'procedure');
  const orphanProcs = procPages.filter(p => (actMap.get(p.path) ?? 0) === 0);
  if (orphanProcs.length > 0) {
    issues.push({
      type: 'orphan-procedure',
      severity: 'info',
      detail: `${orphanProcs.length} 条 procedure 从未被召回`,
      paths: orphanProcs.map(p => p.path),
    });
  }

  // 4. 堆积的 raw Episode
  const rawEps = pages.filter(p => p.kind === 'episode' && p.status === 'raw');
  if (rawEps.length > 10) {
    issues.push({
      type: 'episode-backlog',
      severity: 'warn',
      detail: `${rawEps.length} 条 Episode 未蒸馏`,
      paths: [],
    });
  }

  // 5. 已 superseded 但仍在活跃目录
  const supersededActive = pages.filter(
    p => p.superseded_by && !p.path.startsWith('40-归档/')
  );
  if (supersededActive.length > 0) {
    issues.push({
      type: 'superseded-not-archived',
      severity: 'info',
      detail: `${supersededActive.length} 条已取代的页仍在活跃目录`,
      paths: supersededActive.map(p => p.path),
    });
  }

  // 6. 【2026-11-18 新增】失败复盘：outcome=failure/partial 的 Episode 必须沉淀为 lesson
  const epPages = pages.filter(p => p.kind === 'episode');
  let failNoLesson = [];
  let failCount = 0;
  for (const e of epPages) {
    let d = {};
    try { d = parseFrontmatter(fs.readFileSync(path.join(getVault(), e.path), 'utf8')).data; } catch {}
    const oc = d.outcome;
    if (oc === 'failure' || oc === 'partial') {
      failCount++;
      if (!d.lesson) failNoLesson.push(e.path);
    }
  }
  if (failNoLesson.length > 0) {
    issues.push({
      type: 'failure-without-lesson',
      severity: 'warn',
      detail: `${failNoLesson.length}/${failCount} 条失败/部分成功的 Episode 没写 lesson —— 学到了什么？`,
      paths: failNoLesson,
    });
  }

  // 7. 【新增】Episode 缺 outcome（无法区分成功与失败）
  const epNoOutcome = [];
  for (const e of epPages) {
    let d = {};
    try { d = parseFrontmatter(fs.readFileSync(path.join(getVault(), e.path), 'utf8')).data; } catch {}
    if (!d.outcome) epNoOutcome.push(e.path);
  }
  if (epNoOutcome.length > 0) {

    issues.push({
      type: 'episode-no-outcome',
      severity: 'info',
      detail: `${epNoOutcome.length} 条 Episode 缺 outcome 字段（老格式），无法判断成败`,
      paths: epNoOutcome.slice(0, 10),
    });
  }

  // 8. 【新增】procedure 全胜率异常：success_rate=1.0 但 times_applied>5，可能从未记录失败
  const realProcPages = pages.filter(p => p.kind === 'procedure' && /^P-\d{4}/.test(path.basename(p.path)));
  const suspiciousProcs = [];
  for (const p of realProcPages) {
    let d = {};
    try { d = parseFrontmatter(fs.readFileSync(path.join(getVault(), p.path), 'utf8')).data; } catch {}
    const sr = parseFloat(d.success_rate);
    const n = parseInt(d.times_applied, 10) || 0;
    if (sr === 1 && n >= 5) suspiciousProcs.push(p.path);
  }
  if (suspiciousProcs.length > 0) {
    issues.push({
      type: 'procedure-never-fails',
      severity: 'info',
      detail: `${suspiciousProcs.length} 条 procedure 声称 100% 成功率且用了 5+ 次 —— 是否只记成功不记失败？`,
      paths: suspiciousProcs,
    });
  }

  // 9. 【新增】预期落空：这是发现"语义层错误"的唯一信号
  //
  // contradictions 只能抓形式矛盾；如果一个结论本身算错了、库里没有对立说法，
  // 矛盾扫描永远抓不出来。唯一线索是"我以为会这样，实际不是"。
  const expectationMisses = [];
  for (const e of epPages) {
    let d = {};
    try { d = parseFrontmatter(fs.readFileSync(path.join(getVault(), e.path), 'utf8')).data; } catch {}
    if (d.expectation && d.expectation_held === false) {
      expectationMisses.push({ path: e.path, title: e.title, expectation: d.expectation });
    }
  }
  if (expectationMisses.length > 0) {
    issues.push({
      type: 'expectation-failed',
      severity: 'warn',
      detail: `${expectationMisses.length} 次「我以为会这样，实际不是」——语义层错误的最强信号`,
      paths: expectationMisses.map(x => `${x.path}  ← 预期：${x.expectation}`),
    });
  }

  return {
    timestamp: new Date().toISOString(),
    totalPages: pages.length,
    byKind: pages.reduce((acc, p) => {
      acc[p.kind] = (acc[p.kind] || 0) + 1;
      return acc;
    }, {}),
    issues,
  };
}

// ─────────────────────────────────────────────────────────────
// 统计
// ─────────────────────────────────────────────────────────────

function stats() {
  const pages = scanVault();
  const actMap = activationMap();
  const log = readLog();

  const byKind = {};
  const bySource = {};
  for (const p of pages) {
    byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    if (p.source) bySource[p.source] = (bySource[p.source] || 0) + 1;
  }

  const episodes = pages.filter(p => p.kind === 'episode');
  const byStatus = {};
  for (const e of episodes) {
    const s = e.status || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const topActive = [...actMap.entries()]
    .map(([p, a]) => ({ path: p, activation: Math.round(a * 1000) / 1000 }))
    .sort((a, b) => b.activation - a.activation)
    .slice(0, 10);

  return {
    vault: getVault(),
    totalPages: pages.length,
    byKind,
    sourceDistribution: bySource,
    episodes: { total: episodes.length, byStatus },
    procedures: {
      total: pages.filter(p => p.kind === 'procedure').length,
      withActivation: pages.filter(p => p.kind === 'procedure' && (actMap.get(p.path) ?? 0) > 0).length,
    },
    logEntries: log.length,
    topActivated: topActive,
  };
}

// ─────────────────────────────────────────────────────────────
// 联想图（HippoRAG / Personalized PageRank）
//
// 依据：Gutiérrez et al. (2024) HippoRAG —— 海马体索引 ≈ Personalized PageRank
// 认知对应：启动扩散（spreading activation）。想起一件事时，
//          与之相连的事会被"点亮"，即使没直接检索它。
// ─────────────────────────────────────────────────────────────

/**
 * 从全库 wiki-link 建有向图。
 * 返回 { nodes: Map<path, idx>, adj: Array<Array<{to, w}>>, titleIndex: Map<title, path> }
 */
function buildGraph(pages) {
  // 标题 / 文件名 → 路径（用于解析 [[短名]]）
  const titleIndex = new Map();
  for (const p of pages) {
    const base = path.basename(p.path, '.md');
    titleIndex.set(base.toLowerCase(), p.path);
    titleIndex.set(p.path.toLowerCase(), p.path);
    if (p.title) titleIndex.set(p.title.toLowerCase(), p.path);
  }

  const nodes = new Map();
  for (let i = 0; i < pages.length; i++) nodes.set(pages[i].path, i);
  const adj = pages.map(() => []);

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let text;
    try {
      text = fs.readFileSync(path.join(getVault(), p.path), 'utf8');
    } catch { continue; }

    // 提取 [[target]] 或 [[target|alias]]
    const seen = new Map();
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      // 归一化路径分隔符：Obsidian 规范用 /，但库里混有 \（Windows 习惯），两种都要认
      const raw = m[1].trim().replace(/\\/g, '/');
      if (!raw) continue;
      const key = raw.toLowerCase();
      let target = titleIndex.get(key);

      // 未直接命中：尝试后缀匹配（Obsidian 允许省略路径）
      if (!target) {
        const cand = pages.find(pg => pg.path.toLowerCase().endsWith('/' + key + '.md')
          || pg.path.toLowerCase() === key + '.md');
        if (cand) target = cand.path;
      }
      if (!target) continue;
      if (target === p.path) continue;
      seen.set(target, (seen.get(target) || 0) + 1);
    }

    for (const [target, cnt] of seen) {
      const j = nodes.get(target);
      if (j === undefined) continue;
      // 重复链接略微加权，但封顶，避免枢纽页 dominate
      adj[i].push({ to: j, w: Math.min(1 + (cnt - 1) * 0.3, 2) });
      // 反向边权重低一些（引用关系有方向）
      adj[j].push({ to: i, w: 0.5 });
    }
  }

  return { nodes, adj, titleIndex, pages };
}

/**
 * Personalized PageRank（幂迭代）
 * P = α·M·P + (1−α)·v
 *
 * @param seedIdx 种子节点索引数组
 * @param alpha   阻尼系数，0.85 是 PageRank 经典值
 * @param iters   迭代次数
 */
function ppr(graph, seedIdx, { alpha = 0.85, iters = 20 } = {}) {
  const n = graph.pages.length;
  if (seedIdx.length === 0) return new Float64Array(n);

  const v = new Float64Array(n);
  for (const i of seedIdx) v[i] = 1 / seedIdx.length;

  let p = Float64Array.from(v);

  // 出度归一化用 sqrt 软化：
  // 经典 PPR 用 sum(w) 直接归一，导致 35 条出链的枢纽页每条只分到 1/35，
  // 目标页得分被摊到 floor 以下。平方根归一（Haveliwala 2003 的
  // "topic-sensitive PageRank" 里对 hub 的处理思路）能保留枢纽的传导能力，
  // 又不让它淹没小页面。
  const outW = graph.adj.map(edges => {
    let s = 0;
    for (const e of edges) s += e.w;
    return s > 0 ? Math.sqrt(s) : 0;
  });

  for (let iter = 0; iter < iters; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) next[i] = (1 - alpha) * v[i];

    for (let i = 0; i < n; i++) {
      const edges = graph.adj[i];
      if (!edges.length || outW[i] === 0) {
        for (const s of seedIdx) next[s] += (alpha * p[i]) / seedIdx.length;
        continue;
      }
      for (const e of edges) {
        // 边权 / sqrt(出度和)，不是 / 出度和
        next[e.to] += alpha * p[i] * (e.w / outW[i]);
      }
    }

    let sum = 0;
    for (let i = 0; i < n; i++) sum += next[i];
    if (sum > 0) for (let i = 0; i < n; i++) next[i] /= sum;
    p = next;
  }

  return p;
}

/**
 * 联想召回：直接命中 + 图扩散
 *
 * 返回两类：
 *   direct   直接文本/线索命中（种子）
 *   spread   通过图到达的关联页（联想）
 */
function recallWithAssociation(query, pages, opts = {}) {
  const limit = opts.limit ?? 10;
  const spreadLimit = opts.spreadLimit ?? 8;
  const beta = opts.beta ?? 0.35;   // 联想项的权重折扣
  const useSemantic = opts.semantic !== false;

  // ① 直接命中（现有逻辑）
  const direct = recall(query, pages, { limit, minScore: opts.minScore ?? 2 });

  if (!opts.spread || direct.length === 0) {
    return { direct, spread: [], tag: {} };
  }

  // ② 建图：显式双链 + （可选）语义近邻
  const explicit = buildGraph(pages);
  let graph = explicit;

  if (useSemantic) {
    const semantic = buildSemanticGraph(pages);
    const merged = explicit.adj.map((edges, i) => {
      const out = edges.slice();
      const existing = new Set(edges.map(e => e.to));
      for (const e of semantic.adj[i] || []) {
        if (!existing.has(e.to)) out.push(e);
      }
      return out;
    });
    graph = { nodes: explicit.nodes, adj: merged, pages };
  }

  // ③ 种子选取：直接命中 + 同项目的枢纽页（项目主页 / 总览 / 索引）
  //
  // 为什么需要这一步：遇到「蛋糕」这种高频词，命中的往往是项目内的证据子页，
  // 它们的出链全在同一目录内部，跨项目扩散不出去。
  // 人类不会从"某个证据文件"开始联想，而是从"那个项目"开始。
  const seedPaths = new Set(direct.map(d => d.path));

  // 收集直接命中涉及的项目
  const seedProjects = new Set(direct.map(d => projectOf(d.path)).filter(Boolean));

  for (const p of pages) {
    if (seedPaths.has(p.path)) continue;
    const pj = projectOf(p.path);
    if (!pj || !seedProjects.has(pj)) continue;

    // 判定是否枢纽页：项目主页（project/<名>/<名>.md）、总览、索引、README
    const base = path.basename(p.path, '.md');
    const parts = p.path.split('/');
    const isProjectHome = pj === base;   // 如 10-项目/X/X.md
    const isOverview = /^(当前状态|总览|总索引|索引|README|交接)/.test(base)
                    || /00-总览\//.test(p.path);

    if (isProjectHome || isOverview) {
      seedPaths.add(p.path);
    }
  }

  const seedIdx = [...seedPaths]
    .map(pth => graph.nodes.get(pth))
    .filter(i => i !== undefined);

  if (seedIdx.length === 0) return { direct, spread: [], tag: {} };

  const p = ppr(graph, seedIdx);

  // ③ 取 PPR 得分高、但不在 direct 里的
  const directPaths = new Set(direct.map(d => d.path));
  const spreads = [];
  for (let i = 0; i < graph.pages.length; i++) {
    const pg = graph.pages[i];
    if (directPaths.has(pg.path)) continue;
    if (pg.kind === 'index' || pg.kind === 'record') continue;
    if (p[i] <= 0) continue;

    // 标注这条联想的来源：显式双链 还是 语义相近
    const hasExplicit = explicit.adj[seedIdx[0]]?.some(e => e.to === i);
    const via = hasExplicit ? 'link' : 'semantic';

    spreads.push({ ...pg, score: p[i] * 1000 * beta, via });
  }
  spreads.sort((a, b) => b.score - a.score);

  if (spreads.length === 0) {
    return { direct, spread: [], tag: {} };
  }

  // 自适应阈值 + 绝对下限
  //
  // 只用相对分位不够：当整体都很弱时（比如查询命中的是一篇会话记录），
  // 「最强的联想」也只有 2 分，仍是噪声。
  // 人类联想有绝对门槛——太弱的关联根本不会浮上来。
  const topSpreadScore = spreads[0].score;
  const keepRatio = opts.spreadMinRatio ?? 0.25;
  const absFloor = opts.spreadAbsFloor ?? 2.5;   // 绝对下限：低于 2.5 分视为噪声
  const floor = Math.max(topSpreadScore * keepRatio, absFloor);
  const filtered = spreads.filter(s => s.score >= floor);

  if (filtered.length === 0) {
    return { direct, spread: [], tag: { suppressed: spreads.length, floor } };
  }

  // 跨项目加分：人类联想最有价值的是「跨出当前领域」。
  // 同项目内部的联想往往只是"目录邻居"，信息量低。
  const directProjects = new Set(direct.map(d => projectOf(d.path)).filter(Boolean));
  for (const s of filtered) {
    const pj = projectOf(s.path);
    if (pj && directProjects.size && !directProjects.has(pj)) {
      s.score *= 1.8;
      s.cross = true;
    }
  }
  filtered.sort((a, b) => b.score - a.score);

  const topSpread = filtered.slice(0, spreadLimit);

  for (const s of topSpread) {
    appendLog({
      op: 'recall', path: s.path, q: query,
      score: Math.round(s.score * 100) / 100, via: 'spread:' + s.via,
    });
  }

  return { direct, spread: topSpread, tag: { filteredOut: spreads.length - filtered.length, floor } };
}

/**
 * 语义近邻图：不依赖 wiki-link，靠共享罕见词建立隐式边。
 *
 * 认知对应：人类的联想不只有"记得写过链接"这一种。
 *          两个从没被联系起来的概念，只要内涵相近，就能在你脑子里碰头。
 *          这一层补的就是"从未显式连接但语义相邻"的联想。
 *
 * 做法：对每个页面取 top-N 高 IDF token 作为"指纹"，
 *      指纹重叠 ≥ 阈值的两页之间加一条隐式边（权重按重叠度）。
 */
function buildSemanticGraph(pages, { topTokens = 8, maxEdgesPerNode = 6 } = {}) {
  const n = pages.length;
  const nodes = new Map();
  for (let i = 0; i < n; i++) nodes.set(pages[i].path, i);

  // ① 算每个页面的 token 集合与全局 DF
  const docTokens = [];
  const df = new Map();
  for (const p of pages) {
    const text = (p.title + ' ' + p.cues.join(' ') + ' ' + p.preview).toLowerCase();
    const toks = new Set();
    for (const m of text.matchAll(/[a-z0-9_+#.]{2,}/g)) toks.add(m[0]);
    const cjk = text.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let k = 2; k <= 3; k++) {
      for (let i2 = 0; i2 + k <= cjk.length; i2++) toks.add(cjk.slice(i2, i2 + k));
    }
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    docTokens.push(toks);
  }

  // ② 每页取 IDF 最高的 top-N 作为指纹
  const fingerprints = [];
  for (let i = 0; i < n; i++) {
    const scored = [];
    for (const t of docTokens[i]) {
      if (t.length < 2) continue;
      const idf = Math.log(1 + n / (df.get(t) || 1));
      if (idf < 1.5) continue;   // 太常见的词不参与指纹
      scored.push([t, idf]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    fingerprints.push(scored.slice(0, topTokens));
  }

  // ③ 倒排：token → 出现在哪些页
  const inverted = new Map();
  for (let i = 0; i < n; i++) {
    for (const [t] of fingerprints[i]) {
      if (!inverted.has(t)) inverted.set(t, []);
      inverted.get(t).push(i);
    }
  }

  // ④ 两两累计共享罕见 token
  const pairScore = new Map();   // "i|j" → 得分
  for (const [, docs] of inverted) {
    if (docs.length < 2 || docs.length > 60) continue;   // 跳过过大的簇
    for (let a = 0; a < docs.length; a++) {
      for (let b = a + 1; b < docs.length; b++) {
        const key = docs[a] + '|' + docs[b];
        pairScore.set(key, (pairScore.get(key) || 0) + 1);
      }
    }
  }

  // ⑤ 每节点保留最强的若干条
  const adj = pages.map(() => []);
  const perNode = new Map();
  for (const [key, score] of pairScore) {
    if (score < 2) continue;   // 至少共享 2 个罕见 token
    const [ia, ib] = key.split('|').map(Number);
    const listA = perNode.get(ia) || [];
    const listB = perNode.get(ib) || [];
    listA.push([ib, score]);
    listB.push([ia, score]);
    perNode.set(ia, listA);
    perNode.set(ib, listB);
  }
  for (const [i, list] of perNode) {
    list.sort((a, b) => b[1] - a[1]);
    for (const [j, s] of list.slice(0, maxEdgesPerNode)) {
      // 隐式边权重低于显式双链（0.4 vs 1~2）
      adj[i].push({ to: j, w: Math.min(0.4 + s * 0.1, 1.0) });
    }
  }

  return { nodes, adj, pages };
}

// ─────────────────────────────────────────────────────────────
// 矛盾扫描（自我推翻的地基）
//
// 认知对应：人类的"认知失调"——两个互相矛盾的信念不能长期共存，
// 必然有一个被推翻或修正。系统里也一样，只是它不会自动感到不适，
// 所以要靠扫描器定期找出"这里可能打架了"。
//
// 三种矛盾类型：
//   A. 同一主体的正反结论（选了 X vs 放弃 X）
//   B. 同一参数的两个不同值
//   C. 明确标注时间却先后颠倒的判断
// ─────────────────────────────────────────────────────────────

// 反义/取舍词对（顺序重要：先匹配负向，因为"放弃 X 选 Y"里 X 是负向）
const OPPOSE_PAIRS = [
  ['启用', '停用'], ['开启', '关闭'], ['保留', '移除'],
  ['支持', '不支持'], ['可行', '不可行'],
  ['成功', '失败'], ['有效', '无效'], ['可以', '不可以'],
  ['选择', '放弃'], ['采用', '放弃'],
  ['必须', '禁止'], ['升级', '降级'], ['放大', '缩小'],
];

function findContradictions(pages) {
  const conflicts = [];

  // ── A 类：同一关键实体上出现相反方向 ──
  //
  // 第一版用"标题去方向词后的剩余串"当主体，结果被切碎（ADR-0034 与 ADR-0037
  // 都讲 IDA，但剩余串一个是"逆向引擎选Ghidra-12.1.4加REA-6.8.0"，一个是
  // "IDA-9.4落地并接入REA且定为逆向首"，永远匹配不上）。
  //
  // 改用「实体 + 方向」模型：
  //   实体 = 标题里出现的技术名词（英文词 / 大写缩写 / 中文专名）
  //   方向 = 选择/放弃、可行/不可行 等对立词
  //   同一实体上既有 pos 又有 neg → 矛盾
  const ENTITY_PATTERNS = [
    /\b([A-Z][A-Za-z0-9._-]{1,20})\b/g,           // IDA, Ghidra, ONNX, COM
    /\b([a-z]{2,}[0-9][a-z0-9.]*)\b/gi,            // v1.1.4, s60v3
    /([\u4e00-\u9fa5]{2,6})(?=模型|引擎|插件|方案|算法|管线|架构|协议|接口)/g,  // 模型名
    // 中文名词短语：方向词之后的 2-8 字（"选择方案X" → "方案X"）
    // 2026-11-18 补：原来只认前面带专业词的，导致「方案X」这类纯中文主体抽不出
    /(?:选择|采用|放弃|启用|停用|开启|关闭|保留|移除|支持|禁止|升级|降级)([\u4e00-\u9fa5A-Za-z0-9]{2,10})/g,
  ];

  // 实体黑名单：这些词太泛，做实体只会制造噪声
  const ENTITY_STOP = new Set([
    'ai', 'api', 'the', 'and', 'for', 'not', 'all', 'any', 'one', 'two', 'per',
    'id', 'ok', 'no', 'yes', 'xx', 'abc', 'http', 'https', 'www', 'com', 'org',
    'v1', 'v2', 'v3', 'v4', 'v5', 'md', 'json', 'txt', 'png', 'jpg', 'exe',
    'dll', 'py', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'log',
  ]);

  const decisions = [];
  for (const p of pages) {
    if (!['decision', 'fact', 'procedure'].includes(p.kind)) continue;
    if (p.refuted) continue;

    const title = p.title || path.basename(p.path, '.md');


    // 找方向词
    let dir = null, dirWord = null;
    for (const [pos, neg] of OPPOSE_PAIRS) {
      if (title.includes(neg)) { dir = 'neg'; dirWord = neg; break; }
      if (title.includes(pos)) { dir = 'pos'; dirWord = pos; break; }
    }
    if (!dir) continue;

    // 抽实体
    const entities = new Set();
    const opposeWords = new Set(OPPOSE_PAIRS.flat());
    for (const re of ENTITY_PATTERNS) {
      for (const m of title.matchAll(re)) {
        if (!m[1]) continue;
        let e = m[1].trim();
        const el = e.toLowerCase();
        if (el.length < 2) continue;
        if (ENTITY_STOP.has(el)) continue;

        // 修复（2026-11-18）：正则会把「选择方案」整体抓成实体，
        // 导致「选择方案X」与「放弃方案X」提取出的实体分别是"选择"和"放弃"，
        // 永远对不上，矛盾永远检不出。
        // 解决：从提取结果里把方向词剔除，只留真正的名词部分。
        for (const ow of opposeWords) {
          if (e.includes(ow)) e = e.split(ow).join('');
        }
        if (e.length < 2) continue;
        if (opposeWords.has(e)) continue;

        entities.add(e.toLowerCase());
      }
    }
    // 常见技术名词白名单（中文标题里的关键主体）
    const KEY_TERMS = ['ida', 'ghidra', 'ida', 'reworkbench', 'onnx', 'ptx', 'birefnet',
      'heal', 'dodgeburn', 'abpn', 'spotless', 'egsgenerator', 'comfyui', 'traecn',
      '示例项目A', '抠图', '磨皮', '祛斑', '祛痘', '水印', '引擎', '模型', '插件'];
    for (const t of KEY_TERMS) {
      if (title.toLowerCase().includes(t)) entities.add(t);
    }

    if (entities.size) decisions.push({ page: p, dir, dirWord, entities });
  }

  // 按实体聚合
  const byEntity = new Map();
  for (const d of decisions) {
    for (const e of d.entities) {
      if (!byEntity.has(e)) byEntity.set(e, { pos: [], neg: [] });
      byEntity.get(e)[d.dir].push(d);
    }
  }

  for (const [entity, { pos, neg }] of byEntity) {
    if (!pos.length || !neg.length) continue;

    // 同一条自己的 pos/neg 不算（比如"选了 X 放弃 Y"同时含两个词）
    for (const a of pos) {
      for (const b of neg) {
        if (a.page.path === b.page.path) continue;

        const alreadyLinked =
          (a.page.superseded_by && (b.page.path.includes(a.page.superseded_by) || a.page.path.includes(a.page.superseded_by))) ||
          (b.page.superseded_by && (a.page.path.includes(b.page.superseded_by) || b.page.path.includes(b.page.superseded_by)));

        conflicts.push({
          type: 'A-方向相反',
          subject: entity,
          severity: alreadyLinked ? 'resolved' : 'open',
          a: { path: a.page.path, title: a.page.title, word: a.dirWord },
          b: { path: b.page.path, title: b.page.title, word: b.dirWord },
          note: alreadyLinked ? '已有 superseded 链' : '未见 superseded 关系，需人工确认哪条过时',
        });
      }
    }
  }

  // ── B 类：同一参数出现两个不同数值 ──
  // 在 decision 页里找 "参数名 = 数值" 或 "参数名：数值" 模式
  const paramMap = new Map();
  for (const p of pages) {
    if (p.kind !== 'decision') continue;
    if (p.refuted) continue;
    let body;
    try { body = fs.readFileSync(path.join(getVault(), p.path), 'utf8'); } catch { continue; }

    // 例：threshold=0.35、thr_low 0.35、padding 192
    for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]{2,20})\s*[=＝:：]\s*(-?\d+(?:\.\d+)?)/g)) {
      const key = m[1].toLowerCase();
      const val = parseFloat(m[2]);
      if (!isFinite(val)) continue;
      if (!paramMap.has(key)) paramMap.set(key, new Map());
      const valMap = paramMap.get(key);
      if (!valMap.has(val)) valMap.set(val, []);
      valMap.get(val).push(p.path);
    }
  }

  for (const [key, valMap] of paramMap) {
    if (valMap.size < 2) continue;
    // 只报在不同页里出现的不同值
    const entries = [...valMap.entries()].filter(([, ps]) => ps.length > 0);
    if (entries.length < 2) continue;
    const pagesPerVal = entries.map(([v, ps]) => ({ val: v, pages: [...new Set(ps)] }));
    // 至少两个值各自出现在不同页面
    const distinct = pagesPerVal.filter(e => e.pages.length);
    if (distinct.length >= 2) {
      conflicts.push({
        type: 'B-参数不一致',
        subject: key,
        severity: 'info',
        values: distinct.slice(0, 4).map(e => ({ value: e.val, pages: e.pages.slice(0, 2) })),
        note: '不同页面对同一参数用了不同值，可能合法（不同场景）也可能过时',
      });
    }
  }

  return conflicts;
}

// ─────────────────────────────────────────────────────────────
// 开场简报（L1 工作记忆的入口，目标 < 500 token）
// ─────────────────────────────────────────────────────────────

function brief({ days = 7, withGraph = false, checkContradictions = true } = {}) {
  const pages = scanVault();
  const actMap = activationMap();
  const now = Date.now();
  const cutoff = Math.floor((now - days * 86400000) / 1000);

  const lines = [];

  // ① 库概览
  const byKind = {};
  for (const p of pages) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  const kk = ['project', 'decision', 'procedure', 'episode', 'fact', 'record']
    .filter(k => byKind[k])
    .map(k => `${k}:${byKind[k]}`)
    .join(' ');
  lines.push(`▸ 库 ${pages.length} 页（${kk}）`);

  // ② 最近变化（按 mtime）——只挑信息密度高的类，跳过 record 与索引
  const NOISE_KINDS = new Set(['record', 'index']);
  const recentAll = pages.filter(p => p.mtime >= cutoff && !NOISE_KINDS.has(p.kind));
  const recent = recentAll
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 6);
  if (recent.length) {
    lines.push('');
    lines.push(`▸ 近 ${days} 天改动 ${recentAll.length} 页（已滤掉会话档案/索引），最新：`);
    for (const p of recent) {
      const d = new Date(p.mtime * 1000);
      const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      lines.push(`  ${stamp} [${p.kind}] ${truncate(p.title, 42)}`);
    }
  }

  // ③ 最近 Episode（未蒸馏的优先）
  const eps = pages
    .filter(p => p.kind === 'episode')
    .sort((a, b) => b.mtime - a.mtime);
  const rawEps = eps.filter(e => e.status === 'raw');
  if (eps.length) {
    lines.push('');
    lines.push(`▸ 情景记忆 ${eps.length} 条（未蒸馏 ${rawEps.length}）`);
    for (const e of eps.slice(0, 3)) {
      const flag = e.status === 'raw' ? '·未蒸馏' : '';
      lines.push(`  ${truncate(e.title, 44)}${flag}`);
    }
  }

  // ④ 程序性记忆：只列 trigger，不列正文（只认 P-\d{4} 编号的，跳过索引页）
  const realProcs = pages.filter(
    p => p.kind === 'procedure' && /^P-\d{4}/.test(path.basename(p.path))
  );
  if (realProcs.length) {
    lines.push('');
    lines.push(`▸ 程序记忆 ${realProcs.length} 条（遇到同类任务先对 trigger）：`);
    for (const p of realProcs) {
      const id = path.basename(p.path, '.md').split('-').slice(0, 2).join('-');
      lines.push(`  ${id} ${truncate(p.title, 34)}`);
    }
  }

  // ⑤ 高活化页（用过的）
  const topAct = [...actMap.entries()]
    .map(([p, a]) => ({ path: p, a }))
    .sort((x, y) => y.a - x.a)
    .slice(0, 3);
  if (topAct.length) {
    lines.push('');
    lines.push('▸ 最近用过的：');
    for (const t of topAct) {
      lines.push(`  ${truncate(path.basename(t.path, '.md'), 50)} (A=${t.a.toFixed(2)})`);
    }
  }

  // ⑥ 待处理
  const issues = [];
  if (rawEps.length >= 5) issues.push(`raw Episode 堆积 ${rawEps.length} 条，该蒸馏`);
  // 注意：检查的是 trust（可信度），不是 source（出处）。
  // 2026-11-18 修：这里原来查 source，但 source 是出处语义、82 页都有，
  // 这个检查从来没意义，还在 brief 里谎报「26 条缺 source」。
  const noTrust = pages.filter(p => ['decision', 'fact'].includes(p.kind) && !p.trust).length;
  if (noTrust) issues.push(`${noTrust} 条语义页未标可信度 trust`);

  // ⑥' 即时矛盾扫描（不依赖用户或周审计触发）
  //
  // 修复（2026-11-18，用户要求）：原来矛盾扫描只在每周审计里跑，
  // 等于允许错误存活最多七天；这期间所有基于它的推理都是错的。
  // 现在每轮 brief 都扫一遍——成本约 0.3 秒，收益是错误当轮就能被发现。
  if (checkContradictions) {
    try {
      const conflicts = findContradictions(pages);
      const open = conflicts.filter(c => c.severity === 'open');
      if (open.length) {
        issues.push(`🔴 ${open.length} 处未处理的矛盾（详见 contradictions）`);
        for (const c of open.slice(0, 3)) {
          issues.push(`   · ${c.subject}: ${c.a.word} vs ${c.b.word}`);
        }
      }
    } catch (e) {
      issues.push(`矛盾扫描失败：${e.message}`);
    }
  }

  // ⑥'' 待裁决的自动检出冲突（新 Episode 说旧结论错了，但还没人裁决）
  try {
    const cf = path.join(getSYS(), 'proposals', '冲突待裁决.md');
    if (fs.existsSync(cf)) {
      const txt = fs.readFileSync(cf, 'utf8');
      const pending = (txt.match(/^- \[ \]/gm) || []).length;
      if (pending > 0) {
        issues.push(`🟠 ${pending} 条自动检出的冲突待裁决（proposals/冲突待裁决.md）`);
      }
    }
  } catch { /* 忽略 */ }

  if (issues.length) {
    lines.push('');
    lines.push('▸ 待处理：');
    for (const i of issues) lines.push('  ' + i);
  }

  // ⑦ 图健康度（联想能力才存在的前提）
  if (withGraph) {
    const g = buildGraph(pages);
    const totalEdges = g.adj.reduce((s, e) => s + e.length, 0) / 2;
    const isolated = g.adj.filter(e => e.length === 0).length;
    lines.push('');
    lines.push(`▸ 联想图：${Math.round(totalEdges)} 条边，孤立节点 ${isolated} 个（${(isolated / pages.length * 100).toFixed(0)}%）`);
    if (isolated / pages.length > 0.3) {
      lines.push('  ⚠ 孤立节点占比高，联想能力受限。补 [[双链]] 可显著改善。');
    }
  }

  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** 从路径推断所属项目（10-项目/<名>/ 或 40-归档/.../<名>/） */
function projectOf(p) {
  const m = p.match(/^10-项目\/([^/]+)\//);
  if (m) return m[1];
  const a = p.match(/^40-归档\/[^/]+\/([^/]+)\//);
  if (a) return a[1];
  return null;
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function main() {
  const cmd = process.argv[2];

  if (!cmd) {
    console.log(`mem.mjs — DSH 记忆系统

用法：
  node mem.mjs brief                        开场简报（新会话第一个命令）
  node mem.mjs index                        重建 pages.idx
  node mem.mjs recall "查询词" [--spread]    召回；--spread 启用联想扩散
  node mem.mjs mark <path>...               标记「这页真用上了」（强化记忆）
  node mem.mjs episode --schema X --title Y --cues "a;b"
          [--outcome success|partial|failure] [--lesson "一句话"]
          [--corrections "错的点1;错的点2"]
  node mem.mjs distill [--apply]            夜间蒸馏（产出失败台账/经验池/提案）
  node mem.mjs compact [--apply]            季度压缩
  node mem.mjs audit                        健康检查
  node mem.mjs stats                        统计

环境变量：
  MEM_VAULT   库根目录，默认 ${getVault()}

关键改动（2026-11-18）：
  · 活化度改半衰期形式（30 天），修「1 小时前访问也算死」的量级错
  · recall 不再自动强化记忆；只有 mark 过的才算「用过」
  · Episode 新增 outcome / corrections / lesson，支撑自我纠错
  · distill 真正产出 failures.md / lessons.md / proposals/
`);
    process.exit(0);
  }

  if (cmd === 'brief') {
    const days = parseInt(arg('days', '7'), 10);
    console.log(brief({ days, withGraph: hasFlag('graph') }));
    return;
  }

  if (cmd === 'contradictions') {
    const pages = scanVault();
    const conflicts = findContradictions(pages);
    const open = conflicts.filter(c => c.severity === 'open');
    const resolved = conflicts.filter(c => c.severity === 'resolved');
    const info = conflicts.filter(c => c.severity === 'info');

    console.log(`矛盾扫描：${conflicts.length} 项（未处理 ${open.length} / 已处理 ${resolved.length} / 待判断 ${info.length}）`);

    if (open.length) {
      console.log('\n── 🔴 未处理的矛盾（需人工裁决）──');
      for (const c of open) {
        console.log(`\n[${c.type}] 主体：${c.subject}`);
        console.log(`  ① [${c.a.word}] ${c.a.title}`);
        console.log(`     ${c.a.path}`);
        console.log(`  ② [${c.b.word}] ${c.b.title}`);
        console.log(`     ${c.b.path}`);
        console.log(`  → ${c.note}`);
        console.log(`  处置：确认哪条错，给它加 refuted: true + refuted_reason`);
      }
    }

    if (resolved.length) {
      console.log('\n── 🟡 已有 superseded 链（可能已处理）──');
      for (const c of resolved) {
        console.log(`  ${c.subject}：${path.basename(c.a.path, '.md').slice(0, 30)} ↔ ${path.basename(c.b.path, '.md').slice(0, 30)}`);
      }
    }

    if (info.length) {
      console.log('\n── ⚪ 参数不一致（可能合法）──');
      for (const c of info.slice(0, 10)) {
        console.log(`  ${c.subject}: ${c.values.map(v => `${v.value}(${v.pages.length}页)`).join(' vs ')}`);
      }
      if (info.length > 10) console.log(`  …还有 ${info.length - 10} 项`);
    }

    return;
  }

  if (cmd === 'rollback') {
    // 回滚自动改动（2026-11-18 新增）
    //
    // 为什么必须有：自动纠错万一标错了，必须能一键撤销。
    // 没有回滚能力的自动化 = 定时炸弹。
    //
    // 用法：
    //   rollback --list              列出所有自动改动过的页
    //   rollback --all --apply       撤销全部自动改动
    //   rollback <path> --apply      只撤销某一页
    const listOnly = hasFlag('list');
    const doAll = hasFlag('all');
    const apply = hasFlag('apply');
    const targetPath = process.argv.slice(3).find(a => !a.startsWith('--'));

    const log = readLog();
    const autoChanges = log.filter(e => e.op === 'supersede' && e.auto === true);

    if (listOnly || (!apply && !targetPath && !doAll)) {
      if (autoChanges.length === 0) {
        console.log('没有自动改动过任何页。');
        return;
      }
      console.log(`自动改动记录：${autoChanges.length} 条\n`);
      const byPath = new Map();
      for (const e of autoChanges) {
        if (!byPath.has(e.path)) byPath.set(e.path, []);
        byPath.get(e.path).push(e);
      }
      for (const [p, es] of byPath) {
        console.log(`${p}`);
        console.log(`  被 ${es.length} 次自动标记，最近一次 by ${es[es.length - 1].by}`);
        const bak = es[es.length - 1].backup;
        if (bak) console.log(`  备份：${bak}`);
      }
      console.log('\n撤销全部：node mem.mjs rollback --all --apply');
      return;
    }

    const targets = doAll
      ? [...new Set(autoChanges.map(e => e.path))]
      : (targetPath ? [targetPath] : []);

    if (targets.length === 0) {
      console.error('没有指定回滚目标。用 --all 或给一个路径。');
      process.exit(1);
    }

    if (!apply) {
      console.log(`[dry-run] 将回滚 ${targets.length} 页：`);
      for (const t of targets) console.log('  ' + t);
      console.log('\n加 --apply 执行。');
      return;
    }

    let done = 0, skipped = 0;
    for (const t of targets) {
      const full = path.join(getVault(), t);
      if (!fs.existsSync(full)) { skipped++; continue; }

      const txt = fs.readFileSync(full, 'utf8');
      const fi = txt.indexOf('\n---', 3);
      if (fi === -1) { skipped++; continue; }

      const fm = txt.slice(3, fi);
      // 2026-11-18 三次修正：可回滚的标记有三类
      //   1. auto_superseded      系统按规则自动标的（已废弃，仅兼容旧数据）
      //   2. confirmed_by_human   review --confirm 标的
      //   3. explicit_refute      episode --refutes 显式声明标的
      // 漏掉第 3 类会导致「全自动纠错」标错了没法撤销。
      const isAuto = /^auto_superseded:\s*true/m.test(fm);
      const isHuman = /^confirmed_by_human:\s*true/m.test(fm);
      const isExplicit = /^explicit_refute:\s*true/m.test(fm);
      if (!isAuto && !isHuman && !isExplicit) {
        skipped++;
        continue;
      }

      const kept = fm.split('\n').filter(l =>
        !/^superseded_by:/.test(l) &&
        !/^auto_superseded:/.test(l) &&
        !/^confirmed_by_human:/.test(l) &&
        !/^explicit_refute:/.test(l) &&
        !/^refuted:/.test(l) &&
        !/^refuted_by:/.test(l) &&
        !/^refuted_reason:/.test(l)
      ).join('\n');

      fs.writeFileSync(full, '---' + kept + txt.slice(fi), 'utf8');
      const kind = isAuto ? '自动' : isHuman ? '人工确认' : '显式声明';
      appendLog({ op: 'rollback', path: t, was: kind });
      done++;
      console.log(`✓ 已回滚 ${t}（${kind}标记）`);
    }

    console.log(`\n回滚 ${done} 页，跳过 ${skipped} 页（不存在或非自动标记）`);
    return;
  }

  if (cmd === 'review') {
    // 一键裁决（2026-11-18 新增）
    //
    // 设计转折：
    //   原计划"自动纠错"，但用 61 条真实记录评估后发现误报率 100%——
    //   "检索到相关页"和"这页该被推翻"是两件事，无法用规则自动判断。
    //
    //   所以改成：系统自动准备好**可执行的动作**，人只需一句话确认。
    //   从"人要不要动手写命令"→"人说对还是不对"。
    //
    // 用法：
    //   review                    看当前待裁决清单
    //   review --confirm 1,3      确认第 1、3 条（执行 supersede）
    //   review --reject 2         拒绝第 2 条（从清单移除）
    //   review --clear            清空清单
    const cf = path.join(getSYS(), 'proposals', '冲突待裁决.md');
    if (!fs.existsSync(cf)) {
      console.log('没有待裁决项。');
      return;
    }

    const txt = fs.readFileSync(cf, 'utf8');

    // 解析成结构化条目
    const blocks = txt.split(/^## /m).slice(1);
    const entries = [];
    for (const b of blocks) {
      const head = b.split('\n')[0];
      const byMatch = head.match(/由\s+(EP-[\w-]+)/);
      const newClaim = (b.match(/\*\*新结论\*\*：(.+)/) || [])[1];
      const items = [...b.matchAll(/^- \[ \] `([^`]+)`\n\s+(.+?)（/gm)]
        .map(m => ({ path: m[1], title: m[2].trim() }));
      if (items.length) {
        entries.push({ header: head, by: byMatch?.[1], claim: newClaim, items });
      }
    }


    if (hasFlag('clear')) {
      fs.writeFileSync(cf, '# 冲突待裁决\n\n> 系统自动检出。裁决后 `[ ]` 改 `[x]`。\n\n', 'utf8');
      console.log('✓ 已清空待裁决清单');
      return;
    }

    const confirmArg = arg('confirm', null);
    const rejectArg = arg('reject', null);

    if (confirmArg && confirmArg !== true) {
      const idxs = String(confirmArg).split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0);
      let done = 0;
      for (const i of idxs) {
        const e = entries[i];
        if (!e) continue;

        // 对每个待裁决项执行 supersede
        for (const it of e.items) {
          const full = path.join(getVault(), it.path);
          if (!fs.existsSync(full)) continue;
          let t = fs.readFileSync(full, 'utf8');
          const fi = t.indexOf('\n---', 3);
          if (fi === -1) continue;
          let fm = t.slice(3, fi);
          if (/^(refuted|superseded_by)\s*:/m.test(fm)) continue;

          fm = fm.replace(/\s*$/, '') + `\nsuperseded_by: ${JSON.stringify(e.by || 'manual')}\nconfirmed_by_human: true`;
          fs.writeFileSync(full, '---' + fm + t.slice(fi), 'utf8');
          appendLog({ op: 'supersede', path: it.path, by: e.by, mode: 'superseded', human: true });
          done++;
          console.log(`✓ 已标记 ${it.path}`);
        }
      }
      console.log(`\n共标记 ${done} 页。`);
      return;
    }

    if (rejectArg && rejectArg !== true) {
      const idxs = String(rejectArg).split(',').map(s => parseInt(s.trim(), 10) - 1);
      // 重建清单，去掉被拒绝的
      const keep = blocks.filter((_, i) => !idxs.includes(i));
      fs.writeFileSync(cf, '# 冲突待裁决\n\n> 系统自动检出。\n\n' + keep.map(b => '## ' + b).join(''), 'utf8');
      console.log(`✓ 已拒绝 ${idxs.length} 条（从清单移除）`);
      return;
    }

    // 列出
    if (entries.length === 0) {
      console.log('待裁决清单存在但没有解析出条目。文件可能格式异常。');
      return;
    }

    console.log(`待裁决：${entries.length} 组\n`);
    entries.forEach((e, i) => {
      console.log(`【${i + 1}】${e.claim || e.header}`);
      if (e.by) console.log(`     来源：${e.by}`);
      for (const it of e.items) {
        console.log(`     · ${it.title.slice(0, 50)}`);
        console.log(`       ${it.path}`);
      }
      console.log('');
    });
    console.log('确认：node mem.mjs review --confirm 1,3');
    console.log('拒绝：node mem.mjs review --reject 2');
    return;
  }

  if (cmd === 'supersede') {
    // 自动纠错：把「新论证推翻了旧结论」这件事，真正写进旧页的 frontmatter
    //
    // 2026-11-18 新增。背景：
    //   原来系统只能"报告"嫌疑（proposals/冲突待裁决.md），
    //   执行 refute 仍要人手动敲。用户明确要求「后续有新论证推翻了之前的，得自我纠错」。
    //
    // 安全设计（关键）：
    //   · 默认 dry-run，只打印将改什么
    //   · --apply 才真写，且自动备份
    //   · --auto 才允许跳过 dry-run（仍会备份）
    //   · 每次改动都记进 access.log 的 supersede 事件
    const target = process.argv[3];
    const by = arg('by', null);
    const reason = arg('reason', null);
    const apply = hasFlag('apply') || hasFlag('auto');

    if (!target) {
      console.error('用法：node mem.mjs supersede <旧页路径> --by "<新论证来源>" --reason "为什么" [--apply]');
      process.exit(1);
    }
    if (!by || by === true) {
      console.error('必须用 --by 指明是谁推翻了它（Episode ID 或新页路径）。');
      console.error('理由：没有溯源的"推翻"等于伪造历史。');
      process.exit(1);
    }

    const full = path.join(getVault(), target);
    if (!fs.existsSync(full)) {
      console.error(`找不到：${target}`);
      process.exit(1);
    }

    let text = fs.readFileSync(full, 'utf8');
    const i = text.indexOf('\n---', 3);
    if (i === -1) { console.error('该文件没有 frontmatter'); process.exit(1); }

    let fm = text.slice(3, i);
    const rest = text.slice(i);

    if (/^refuted\s*:/m.test(fm)) {
      console.log(`已经是 refuted 状态，跳过：${target}`);
      return;
    }
    if (/^superseded_by\s*:/m.test(fm)) {
      console.log(`已有 superseded_by，跳过：${target}`);
      return;
    }

    // 判断是"错了"还是"过时了"
    // 规则：正文/标题里出现强否定词 → refuted（彻底废掉）
    //       否则 → superseded_by（降权但仍可查）
    const head = (text.slice(0, Math.min(600, text.length))).toLowerCase();
    const STRONG = ['否定', '被推翻', '是错的', '不成立', '作废', '终结', '否定假设', '全部失败'];
    const isWrong = STRONG.some(w => head.includes(w.toLowerCase()));

    let newFm = fm.replace(/\s*$/, '');
    if (isWrong) {
      newFm += `\nrefuted: true`;
      newFm += `\nrefuted_by: ${JSON.stringify(String(by))}`;
      if (reason && reason !== true) newFm += `\nrefuted_reason: ${JSON.stringify(String(reason))}`;
    } else {
      newFm += `\nsuperseded_by: ${JSON.stringify(String(by))}`;
    }

    const mode = isWrong ? 'refuted（彻底排除）' : 'superseded_by（降权保留）';

    if (!apply) {
      console.log(`[dry-run] 将对 ${target} 施加：${mode}`);
      console.log('  将追加的 frontmatter：');
      for (const line of newFm.split('\n')) {
        if (/^(refuted|superseded_by|refuted_by|refuted_reason)/.test(line)) {
          console.log('    ' + line);
        }
      }
      console.log('\n  加 --apply 执行。');
      return;
    }

    // 备份
    const bakDir = path.join(getSYS(), 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakFile = path.join(bakDir, `${path.basename(target, '.md')}.${stamp}.bak`);
    fs.writeFileSync(bakFile, text, 'utf8');

    fs.writeFileSync(full, '---' + newFm + rest, 'utf8');
    appendLog({ op: 'supersede', path: target, by: String(by), mode: isWrong ? 'refuted' : 'superseded' });

    console.log(`✓ ${target}`);
    console.log(`  → ${mode}`);
    console.log(`  推翻者：${by}`);
    if (reason && reason !== true) console.log(`  理由：${reason}`);
    console.log(`  备份：${path.basename(bakFile)}`);
    return;
  }

  if (cmd === 'refute') {
    const target = process.argv[3];
    const reason = arg('reason', null);
    const by = arg('by', null);
    if (!target) {
      console.error('用法：node mem.mjs refute <path> --reason "为什么错" [--by EP-xxx]');
      process.exit(1);
    }
    const full = path.join(getVault(), target);
    if (!fs.existsSync(full)) {
      console.error(`找不到：${target}`);
      console.error('提示：路径相对库根，例如 20-决策/跨项目/ADR-00XX-xxx.md');
      process.exit(1);
    }
    let text = fs.readFileSync(full, 'utf8');
    const i = text.indexOf('\n---', 3);
    if (i === -1) { console.error('该文件没有 frontmatter'); process.exit(1); }

    let fm = text.slice(3, i);
    if (/^refuted\s*:/m.test(fm)) {
      console.log('已经是 refuted 状态，跳过');
      return;
    }
    fm = fm.replace(/\s*$/, '') + `\nrefuted: true`;
    if (reason && reason !== true) fm += `\nrefuted_reason: ${JSON.stringify(String(reason))}`;
    if (by && by !== true) fm += `\nrefuted_by: ${JSON.stringify(String(by))}`;
    fs.writeFileSync(full, '---' + fm + text.slice(i), 'utf8');

    appendLog({ op: 'refute', path: target, reason: reason || null });
    console.log(`✓ 已标记为「被推翻」：${target}`);
    console.log(`  理由：${reason || '(未填)'}`);
    console.log('  效果：检索时完全不出现（不是降权），但保留在库里供溯源');
    return;
  }

  if (cmd === 'activation') {
    // 查单页的活化度与使用记录（brief 只显示 top3，查不到个别页）
    const target = process.argv[3];
    if (!target) {
      console.error('用法：node mem.mjs activation <path>');
      process.exit(1);
    }
    const log = readLog();
    const times = log.filter(e => e.op === 'used' && e.path === target).map(e => e.t);
    const a = activation(times);
    const now = Date.now();
    console.log(`路径：${target}`);
    console.log(`使用次数：${times.length}`);
    console.log(`活化度：${a.toFixed(4)}`);
    if (times.length) {
      const last = new Date(Math.max(...times));
      const ageDays = (now - last.getTime()) / 86400000;
      console.log(`最后使用：${last.toISOString().slice(0, 16)}（${ageDays.toFixed(1)} 天前）`);
      console.log(`半衰：30 天；再 ${(30 * Math.log2(Math.max(a, 0.001) / 0.15)).toFixed(0)} 天后低于压缩阈值 0.15`);
    } else {
      console.log('从未被 mark 过（检索不算使用）');
    }
    return;
  }

  if (cmd === 'mark') {
    // 两种用法：
    //   mark <path>...                    只标记"用过"（强化活化度）
    //   mark <P-xxxx> --ok / --fail       记录 procedure 的实战结果
    const paths = [];
    let verdict = null;
    const VALUE_FLAGS2 = new Set(['note']);
    for (let i = 3; i < process.argv.length; i++) {
      const a = process.argv[i];
      if (a === '--ok' || a === '--success') { verdict = true; continue; }
      if (a === '--fail' || a === '--failed') { verdict = false; continue; }
      if (a.startsWith('--')) {
        const name = a.slice(2);
        if (VALUE_FLAGS2.has(name) && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) i++;
        continue;
      }
      paths.push(a);
    }
    if (paths.length === 0) {
      console.error('用法：');
      console.error('  node mem.mjs mark <path>...                 标记"用过"');
      console.error('  node mem.mjs mark <P-xxxx.md> --ok|--fail --note "场景"   记录流程实战');
      process.exit(1);
    }

    if (verdict !== null) {
      const noteArg = arg('note', '');
      for (const p of paths) {
        const r = recordProcedureUse(p, verdict, { note: noteArg && noteArg !== true ? String(noteArg) : '' });
        if (!r.ok) {
          console.log(`✗ ${p}：${r.reason}`);
          continue;
        }
        console.log(`✓ ${p}`);
        console.log(`   ${verdict ? '成功' : '失败'} → times ${r.prevTimes}→${r.times}，成功率 ${r.prevRate ?? '—'}→${r.rate}`);
      }
      return;
    }

    markUsed(paths);
    console.log(`✓ 已标记 ${paths.length} 页为"用过"`);
    for (const p of paths) console.log(`  ${p}`);
    return;
  }

  if (cmd === 'init') {
    // 在当前目录初始化记忆库（2026-11-18 新增）
    //
    // 为什么需要：npx / 新手场景下，用户不想设环境变量、不想读文档，
    // 就想在某个目录里直接开始。init 把「建目录 + 建索引」合成一步。
    //
    // 安全：目录里已有内容时先检查，不在非空目录里乱建东西。
    const cwd = process.env.MEM_VAULT || process.cwd();

    const existing = fs.readdirSync(cwd).filter(f => !f.startsWith('.'));
    const alreadyVault = fs.existsSync(path.join(cwd, '99-系统', '记忆系统'));

    if (alreadyVault) {
      console.log(`已经是记忆库了：${cwd}`);
      console.log('直接用 brief / index 即可。');
      return;
    }

    if (existing.length > 0 && !hasFlag('force')) {
      console.log(`当前目录不是空的（${existing.length} 项）：`);
      for (const f of existing.slice(0, 8)) console.log('  ' + f);
      if (existing.length > 8) console.log(`  …还有 ${existing.length - 8} 项`);
      console.log('');
      console.log('在这个目录里建记忆库会新增以下目录：');
      console.log('  99-系统/记忆系统/  10-项目/  20-决策/  30-习惯/  40-归档/');
      console.log('');
      console.log('确认要建？加 --force：');
      console.log(`  node "${process.argv[1]}" init --force`);
      return;
    }

    const DIRS = [
      '99-系统/记忆系统/tools',
      '99-系统/记忆系统/templates',
      '99-系统/记忆系统/proposals',
      '99-系统/记忆系统/consolidated',
      '99-系统/记忆系统/backups',
      '10-项目',
      '20-决策',
      '30-习惯/procedures',
      '40-归档/episodes',
    ];

    console.log(`初始化记忆库：${cwd}\n`);
    for (const d of DIRS) {
      const p = path.join(cwd, d);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        console.log(`  + ${d}`);
      }
    }

    // 复制工具自身（如果还不在这里）
    const selfDir = path.dirname(fs.realpathSync(process.argv[1]));
    const dstTools = path.join(cwd, '99-系统', '记忆系统', 'tools');
    if (path.resolve(selfDir) !== path.resolve(dstTools)) {
      let n = 0;
      for (const f of fs.readdirSync(selfDir)) {
        if (!f.endsWith('.mjs')) continue;
        const dst = path.join(dstTools, f);
        if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(selfDir, f), dst); n++; }
      }
      if (n) console.log(`  + 复制 ${n} 个工具到 99-系统/记忆系统/tools/`);
    }

    // 建索引
    const VAULT2 = cwd;
    const pages = (function () {
      // 直接用内部 scanVault（此时 getVault() 常量已指向 cwd）
      return [];
    })();

    console.log('');
    console.log('✅ 初始化完成。');
    console.log('');
    console.log('下一步：');
    console.log(`  node "${path.join(dstTools, 'mem.mjs')}" index    重建目录`);
    console.log(`  node "${path.join(dstTools, 'mem.mjs')}" brief    看简报`);
    console.log('');
    console.log('提示：想在任何目录都能用，设置环境变量：');
    console.log(`  MEM_VAULT=${cwd}`);
    return;
  }

  if (cmd === 'index') {
    const pages = scanVault();
    const content = buildIndex(pages);
    fs.mkdirSync(getSYS(), { recursive: true });
    fs.writeFileSync(getIDX(), content + '\n', 'utf8');
    console.log(`✓ pages.idx 已重建：${pages.length} 页`);
    console.log(`  ${getIDX()}`);
    const byKind = {};
    for (const p of pages) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    console.log('  分类：', JSON.stringify(byKind));
    return;
  }

  if (cmd === 'recall') {
    // 收集位置参数，跳过所有 --flag 及其值
    // 注意：必须覆盖所有「带值的 flag」，否则它们的值会被当成查询词
    // 统一走 parseArgs（不再各命令自己维护白名单）
    const { positional } = parseArgs(3);
    const q = positional.join(' ');
    if (!q) {
      console.error('缺少查询词');
      process.exit(1);
    }
    const pages = scanVault();
    const limit = parseInt(arg('limit', '12'), 10);
    const minScore = parseFloat(arg('min-score', '2'));
    const spread = hasFlag('spread');
    const spreadLimit = parseInt(arg('spread-limit', '8'), 10);
    const spreadMinRatio = parseFloat(arg('spread-min-ratio', '0.25'));

    if (spread) {
      const { direct, spread: spreads } = recallWithAssociation(q, pages, {
        limit, minScore, spread, spreadLimit, spreadMinRatio,
      });

      if (direct.length === 0) {
        console.log('（无直接命中，联想也就无从谈起）');
        return;
      }

      console.log(`查询「${q}」\n`);
      console.log(`── 直接命中 ${direct.length} 条 ──`);
      for (const r of direct) {
        console.log(`[${r.kind}] ${r.score.toFixed(2)}  ${r.path}`);
        console.log(`    ${r.title}`);
        if (r.cues.length) console.log(`    cues: ${r.cues.slice(0, 5).join(' | ')}`);
      }

      if (spreads.length) {
        console.log(`\n── 联想扩散 ${spreads.length} 条（PPR，你没提但相关）──`);
        for (const r of spreads) {
          const tag = r.via === 'link' ? '链' : '义';
          console.log(`[${r.kind}·${tag}] ${r.score.toFixed(2)}  ${r.path}`);
          console.log(`    ${r.title}`);
        }
        console.log('\n（链 = 显式双链走到；义 = 语义相近但从未连过）');
      } else {
        console.log('\n（无联想项 —— 图里没有连通路径）');
      }
      return;
    }

    const results = recall(q, pages, { limit, minScore });

    if (results.length === 0) {
      console.log('（无命中）');
      return;
    }
    console.log(`查询「${q}」→ ${results.length} 条命中\n`);
    for (const r of results) {
      console.log(`[${r.kind}] ${r.score.toFixed(2)}  ${r.path}`);
      console.log(`    ${r.title}`);
      if (r.cues.length) console.log(`    cues: ${r.cues.slice(0, 5).join(' | ')}`);
      if (r.source) console.log(`    source: ${r.source}`);
      if (r.superseded_by) console.log(`    ⚠ superseded by ${r.superseded_by}`);
    }
    return;
  }

  if (cmd === 'episode') {
    const schema = arg('schema', '未分类');
    const title = arg('title', null);

    // 2026-11-18 修：原来不带任何参数也会静默创建一条「未分类/（待补充）」的空 Episode，
    // 污染库且难追溯。规则：title 必填，否则拒绝创建。
    if (!title || title === true) {
      console.error('缺少 --title。Episode 必须有能一眼看懂是什么的标题。');
      console.error('用法：node mem.mjs episode --schema "问题类型" --title "一句话" --cues "a;b" [--body-file F]');
      process.exit(1);
    }
    const cuesRaw = arg('cues', '');
    const project = arg('project', '未归属');
    const salience = parseFloat(arg('salience', '0.5'));
    const bodyFile = arg('body-file', null);

    let body = '';
    if (bodyFile && bodyFile !== true) {
      body = fs.readFileSync(bodyFile, 'utf8');
    } else {
      body = arg('body', '（待补充）');
    }

    const cues = String(cuesRaw).split(';').map(s => s.trim()).filter(Boolean);
    const outcome = arg('outcome', 'unknown');       // success | partial | failure | unknown

    // ── 显式声明推翻（2026-11-18 新增，实现真·全自动）──
    //
    // 设计转折（第二次）：
    //   第一版靠"cue 命中数"猜哪页该废 → 61 条真实数据实测误报 100%。
    //   根因：检索相似 ≠ 语义推翻，规则无法区分。
    //
    //   第二版换思路：**不猜，让声明本身携带信息**。
    //   写 Episode 时用 --refutes 明确说"我推翻了这几页"，
    //   系统立即执行，零猜测、零误判。
    //
    //   这是真正的全自动：不需要人工 review，因为你已经用参数表达了裁决。
    //
    // 用法：
    //   --refutes "路径1;路径2"              标 superseded_by（降权，可回退）
    //   --refutes "路径1;路径2" --refute-hard  标 refuted（彻底废掉）
    const refutesRaw = arg('refutes', null);
    const refuteHard = hasFlag('refute-hard');
    const lesson = arg('lesson', null);
    const expectation = arg('expectation', null);    // "以为会发生什么"
    const trustVal = arg('trust', 'verified');       // verified|reported|inferred|recalled
    const corrRaw = arg('corrections', '');
    const corrections = corrRaw && corrRaw !== true
      ? String(corrRaw).split(';').map(s => s.trim()).filter(Boolean)
      : [];

    const r = createEpisode({
      schema, title, cues, body, project, salience,
      outcome, corrections, lesson, expectation,
      trust: trustVal && trustVal !== true ? String(trustVal) : 'verified',
    });
    console.log(`✓ Episode 已创建`);
    console.log(`  id:      ${r.id}`);
    console.log(`  path:    ${r.relPath}`);
    console.log(`  outcome: ${outcome}`);
    if (expectation && expectation !== true) console.log(`  预期:    ${expectation}`);
    if (lesson) console.log(`  lesson:  ${lesson}`);
    if (corrections.length) console.log(`  纠错:    ${corrections.length} 条`);

    // ── 执行显式声明推翻（全自动，零猜测）──
    if (refutesRaw && refutesRaw !== true) {
      const targets = String(refutesRaw).split(';').map(s => s.trim()).filter(Boolean);

      const bakDir = path.join(getSYS(), 'backups');
      let done = 0, failed = [];

      for (const t of targets) {
        const full = path.join(getVault(), t);
        if (!fs.existsSync(full)) { failed.push({ path: t, why: '文件不存在' }); continue; }

        let txt = fs.readFileSync(full, 'utf8');
        const fi = txt.indexOf('\n---', 3);
        if (fi === -1) { failed.push({ path: t, why: '无 frontmatter' }); continue; }

        let fm = txt.slice(3, fi);
        if (/^(refuted|superseded_by)\s*:/m.test(fm)) {
          failed.push({ path: t, why: '已有标记，跳过' });
          continue;
        }

        // 备份（可回滚）
        fs.mkdirSync(bakDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bakName = `${path.basename(t, '.md')}.${stamp}.bak`;
        fs.writeFileSync(path.join(bakDir, bakName), txt, 'utf8');

        const field = refuteHard ? 'refuted: true' : `superseded_by: ${JSON.stringify(r.id)}`;
        const extra = refuteHard
          ? `\nrefuted_by: ${JSON.stringify(r.id)}\nrefuted_reason: ${JSON.stringify(String(title))}`
          : '';
        fm = fm.replace(/\s*$/, '') + `\n${field}${extra}\nexplicit_refute: true`;
        fs.writeFileSync(full, '---' + fm + txt.slice(fi), 'utf8');

        appendLog({
          op: refuteHard ? 'refute' : 'supersede',
          path: t, by: r.id, mode: refuteHard ? 'refuted' : 'superseded',
          explicit: true, backup: bakName,
        });
        done++;
      }

      console.log('');
      console.log(`✅ 已按 --refutes 执行 ${done} 页（${refuteHard ? 'refuted：彻底排除' : 'superseded：降权可回退'}）`);
      if (failed.length) {
        console.log(`   跳过 ${failed.length} 页：`);
        for (const f of failed) console.log(`     ${f.path} — ${f.why}`);
      }
      console.log(`   撤销：node mem.mjs rollback --all --apply`);
    }

    // 自动冲突检测结果（仅在有 --refutes 时跳过，避免重复打扰）
    if (!refutesRaw && r.conflicts && r.conflicts.length) {
      const auto = r.conflicts.filter(c => c.autoSuperseded);
      const manual = r.conflicts.filter(c => !c.autoSuperseded);

      if (auto.length) {
        console.log('');
        console.log(`✅ 系统已自动纠错 ${auto.length} 条（标 superseded_by，可回退）：`);
        for (const c of auto) console.log(`   ${c.path}`);
      }
      if (manual.length) {
        console.log('');
        console.log(`🔴 另有 ${manual.length} 条需人工裁决：`);
        for (const c of manual) {
          console.log(`   ${c.path}`);
          console.log(`      ${c.title}（相关度 ${c.score}）`);
        }
        console.log(`   写入了 proposals/冲突待裁决.md`);
      }
    }
    console.log(`  提示：运行 node mem.mjs index 更新目录`);
    return;
  }

  if (cmd === 'distill') {
    const r = distill({ apply: hasFlag('apply') });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'compact') {
    const r = compact({ apply: hasFlag('apply') });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'audit') {
    const r = audit();
    console.log(`总页数：${r.totalPages}`);
    console.log('分类：', JSON.stringify(r.byKind));
    console.log(`\n问题：${r.issues.length} 项`);
    for (const i of r.issues) {
      console.log(`\n[${i.severity}] ${i.type}: ${i.detail}`);
      for (const p of (i.paths || []).slice(0, 10)) console.log(`    ${p}`);
    }
    return;
  }

  if (cmd === 'stats') {
    const s = stats();
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.error(`未知命令：${cmd}`);
  process.exit(1);
}

main();
