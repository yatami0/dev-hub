#!/usr/bin/env node
// hub: 作業データを書き換える唯一の入口。
// このリポジトリは「仕組み」だけを持つ。データは HUB_ROOT(既定 ~/dev)/data に環境ごとに置く。
// 定義は design.html が原本。1件1ファイルの JSON、欄は平ら、状態の値は下の定数だけ。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = process.env.HUB_ROOT || path.join(os.homedir(), 'dev');
const HUB = path.join(ROOT, 'data'); // データの入れ物。仕組み(このリポジトリ)とは別に、環境ごとに持つ
const KIT = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const WORK = path.join(ROOT, 'work');
const SCHEMA = 1;

const TASK = { active: '進行中', closed: '終了', tidied: '片付け済み' };
const REC = { draft: '下書き', confirmed: '確定', shared: '共有' };
const KINDS = ['現在地', '判断', '調査', '図解'];
const TODO = { open: '未着手', promoted: '作業にした', done: '完了', dropped: '捨てた' };
const GATE = { pending: '未承認', approved: '承認済み' };
const ACTIONS = ['push', '確定', '共有', '作業場の強制削除', 'リモートの作成・削除'];

// ---------- 小道具 ----------
const fail = (msg) => { console.error(`エラー: ${msg}`); process.exit(1); };
const today = () => new Date().toLocaleDateString('sv-SE');
const expand = (p) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
const need = (opt, k) => (typeof opt[k] === 'string' && opt[k] !== '' ? opt[k] : fail(`--${k} が必要です`));

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const listJson = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(path.join(dir, n)))
  : []);

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitOk = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

// 自分が触ったファイルだけを手元でコミットする。ぶつかったら後から来た側がやり直す。
function commit(files, msg) {
  if (!fs.existsSync(path.join(HUB, '.git'))) return;
  const rel = files.map((f) => path.relative(HUB, f));
  for (let i = 0; i < 6; i++) {
    try {
      for (const r of rel) { try { git(HUB, 'add', '-A', '--', r); } catch { /* 未追跡のまま消えたファイル */ } }
      const changed = rel.filter((r) => git(HUB, 'status', '--porcelain', '--', r) !== '');
      if (changed.length) git(HUB, 'commit', '-q', '-m', msg, '--', ...changed);
      return;
    } catch (e) {
      if (!/index\.lock|Unable to create/.test(String(e.stderr || e.message)) || i === 5) {
        console.error(`警告: コミットできませんでした(データは保存済み): ${String(e.stderr || e.message).trim()}`);
        return;
      }
      sleep(200 + Math.floor(Math.random() * 400));
    }
  }
}

// ---------- 置き場 ----------
const P = {
  taskDir: (id) => path.join(HUB, 'tasks', id),
  task: (id) => path.join(HUB, 'tasks', id, 'task.json'),
  ws: (t, id) => path.join(HUB, 'tasks', t, 'workspaces', `${id}.json`),
  rec: (t, id) => path.join(HUB, 'tasks', t, 'records', `${id}.json`),
  gate: (t, id) => path.join(HUB, 'tasks', t, 'gates', `${id}.json`),
  todo: (id) => path.join(HUB, 'todos', `${id}.json`),
  repo: (id) => path.join(HUB, 'repos', `${id}.json`),
};

function newId(prefix, exists) {
  const day = today().replaceAll('-', '');
  for (;;) {
    const id = `${prefix}-${day}-${randomBytes(2).toString('hex').slice(0, 3)}`;
    if (!exists(id)) return id;
  }
}

const allTasks = () => {
  const d = path.join(HUB, 'tasks');
  return fs.existsSync(d)
    ? fs.readdirSync(d).sort().filter((n) => fs.existsSync(P.task(n))).map((n) => readJson(P.task(n)))
    : [];
};
const getTask = (id) => (fs.existsSync(P.task(id)) ? readJson(P.task(id)) : fail(`作業 ${id} がありません`));
const getRepo = (id) => (fs.existsSync(P.repo(id)) ? readJson(P.repo(id)) : fail(`リポジトリ ${id} が登録されていません`));
const wsOf = (t) => listJson(path.join(P.taskDir(t), 'workspaces'));
const recOf = (t) => listJson(path.join(P.taskDir(t), 'records'));
const gateOf = (t) => listJson(path.join(P.taskDir(t), 'gates'));
const allTodos = () => listJson(path.join(HUB, 'todos'));

function findIn(kind, id) {
  for (const t of allTasks()) {
    const hit = (kind === 'ws' ? wsOf(t.id) : kind === 'rec' ? recOf(t.id) : gateOf(t.id)).find((x) => x.id === id);
    if (hit) return hit;
  }
  return fail(`${id} がありません`);
}

// 今いるフォルダが作業場の中なら、その作業を既定にする。
function taskFromCwd() {
  const rel = path.relative(WORK, process.cwd());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const id = rel.split(path.sep)[0];
  return fs.existsSync(P.task(id)) ? id : null;
}
const taskArg = (opt) => (typeof opt.task === 'string' ? opt.task : taskFromCwd() || fail('--task が必要です(作業場の外にいます)'));

// ---------- 判定 ----------
// 「ここにしか無いもの」が残っているかは保存せず、毎回 Git に聞く。
function wsCheck(w) {
  if (!fs.existsSync(w.path)) return { exists: false, uncommitted: 0, ahead: 0, clean: true };
  const uncommitted = git(w.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
  const base = gitOk(w.path, 'rev-parse', '--verify', '-q', `origin/${w.base}`) ? `origin/${w.base}` : w.base;
  const ahead = Number(git(w.path, 'rev-list', '--count', `${base}..HEAD`));
  return { exists: true, uncommitted, ahead, clean: uncommitted === 0 && ahead === 0 };
}

// 承認済みのゲートが無ければ、未承認のゲートを起こして止まる。
function requireGate(taskId, action, target) {
  const gates = gateOf(taskId).filter((g) => g.action === action && g.target === target);
  if (gates.some((g) => g.status === GATE.approved)) return;
  let g = gates.find((x) => x.status === GATE.pending);
  if (!g) {
    g = { schema: SCHEMA, id: newId('g', (i) => fs.existsSync(P.gate(taskId, i))), task_id: taskId, action, target, status: GATE.pending };
    writeJson(P.gate(taskId, g.id), g);
    commit([P.gate(taskId, g.id)], `gate: ${action} ${target} の承認待ち`);
  }
  fail(`人の承認が必要です。承認待ち: ${g.id}(${action} / ${target})`);
}

function tidyIfDone(taskId) {
  const t = getTask(taskId);
  if (t.status !== TASK.closed) return;
  if (wsOf(taskId).length || recOf(taskId).some((r) => r.status === REC.draft)) return;
  t.status = TASK.tidied;
  writeJson(P.task(taskId), t);
  commit([P.task(taskId)], `task: ${taskId} 片付け済み`);
  console.log(`作業 ${taskId} は片付け済みになりました`);
}

// ---------- コマンド ----------
const ASK_RULES = ['Bash(git push *)', 'Bash(git * push *)', 'Bash(hub gate approve *)', 'Bash(gh repo create *)', 'Bash(gh repo delete *)'];

function link(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const st = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) return console.log(`そのままにしました(既に別のファイルがあります): ${dest}`);
  if (st) fs.rmSync(dest);
  fs.symlinkSync(src, dest);
  console.log(`リンクしました: ${dest} → ${src}`);
}

const cmd = {
  // clone した先で1回だけ実行する。データの入れ物を作り、コマンドと決まりをつなぐ。
  init({ opt }) {
    fs.mkdirSync(HUB, { recursive: true });
    if (!fs.existsSync(path.join(HUB, '.git'))) {
      git(HUB, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(HUB, '.gitignore'), '*.tmp\n');
      git(HUB, 'add', '.gitignore');
      git(HUB, 'commit', '-q', '-m', 'データの入れ物を開始');
      console.log(`データの入れ物を作りました: ${HUB}`);
    } else console.log(`データの入れ物は既にあります: ${HUB}`);
    for (const d of ['repos', 'work']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
    link(path.join(KIT, 'CLAUDE.md'), path.join(ROOT, 'CLAUDE.md'));
    link(path.join(KIT, 'tool', 'hub.mjs'), path.join(os.homedir(), '.local', 'bin', 'hub'));
    if (!opt['with-permissions']) return console.log('承認の強制は入れていません。入れるなら: hub init --with-permissions');
    const f = path.join(os.homedir(), '.claude', 'settings.json');
    const s = fs.existsSync(f) ? readJson(f) : {};
    s.permissions ??= {}; s.permissions.ask ??= [];
    const added = ASK_RULES.filter((r) => !s.permissions.ask.includes(r));
    s.permissions.ask.push(...added);
    writeJson(f, s);
    console.log(`承認の強制: ${added.length ? `${added.length} 件のルールを ${f} に足しました` : '既に入っています'}`);
  },

  'task new'({ opt }) {
    if (opt.parent) getTask(opt.parent);
    const t = {
      schema: SCHEMA, id: newId('t', (i) => fs.existsSync(P.task(i))), parent_id: opt.parent || '',
      title: need(opt, 'title'), purpose: need(opt, 'purpose'), status: TASK.active,
      absorbed_into: '', created_at: today(), closed_at: '',
    };
    writeJson(P.task(t.id), t);
    commit([P.task(t.id)], `task: ${t.id} ${t.title}`);
    console.log(t.id);
  },
  'task list'({ opt }) {
    const ts = allTasks().filter((t) => (opt.all ? true : t.status !== TASK.tidied));
    if (opt.json) return console.log(JSON.stringify(ts, null, 2));
    const kids = (pid, depth) => ts.filter((t) => t.parent_id === pid).forEach((t) => {
      console.log(`${'  '.repeat(depth)}${t.id}  [${t.status}]  ${t.title}`);
      kids(t.id, depth + 1);
    });
    kids('', 0);
    ts.filter((t) => t.parent_id && !ts.some((p) => p.id === t.parent_id)).forEach((t) => console.log(`${t.id}  [${t.status}]  ${t.title}(親は片付け済み)`));
  },
  'task show'({ pos, opt }) {
    const t = getTask(pos[0] || taskArg(opt));
    const data = {
      task: t, children: allTasks().filter((c) => c.parent_id === t.id),
      workspaces: wsOf(t.id).map((w) => ({ ...w, check: wsCheck(w) })),
      records: recOf(t.id), gates: gateOf(t.id), todos: allTodos().filter((d) => d.origin_task_id === t.id),
    };
    if (opt.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`${t.id}  [${t.status}]  ${t.title}\n  目的: ${t.purpose}`);
    if (t.parent_id) console.log(`  親: ${t.parent_id}`);
    if (t.absorbed_into) console.log(`  吸収先: ${t.absorbed_into}`);
    data.children.forEach((c) => console.log(`  子: ${c.id} [${c.status}] ${c.title}`));
    data.workspaces.forEach((w) => console.log(`  作業場: ${w.id} ${w.repo_id}/${w.branch} → ${w.check.exists ? (w.check.clean ? '消してよい' : `残りあり(未コミット ${w.check.uncommitted} / 未取り込み ${w.check.ahead})`) : '実体なし'}`));
    data.records.forEach((r) => console.log(`  記録: ${r.id} [${r.status}] ${r.kind} ${r.title}`));
    data.gates.forEach((g) => console.log(`  ゲート: ${g.id} [${g.status}] ${g.action} / ${g.target}`));
    data.todos.filter((d) => d.status === TODO.open).forEach((d) => console.log(`  ToDo: ${d.id} ${d.text}`));
  },
  'task close'({ pos, opt }) {
    const t = getTask(pos[0] || taskArg(opt));
    if (t.status !== TASK.active) fail(`作業 ${t.id} は既に ${t.status} です`);
    const open = allTasks().filter((c) => c.parent_id === t.id && c.status === TASK.active);
    if (open.length) fail(`子が残っています: ${open.map((c) => c.id).join(', ')}。終わらせる・吸収させる・切り離す、のどれかにしてください`);
    if (opt['absorbed-into']) { getTask(opt['absorbed-into']); t.absorbed_into = opt['absorbed-into']; }
    t.status = TASK.closed; t.closed_at = today();
    writeJson(P.task(t.id), t);
    commit([P.task(t.id)], `task: ${t.id} 終了`);
    console.log(`作業 ${t.id} を終了にしました`);
    const todos = allTodos().filter((d) => d.origin_task_id === t.id && d.status === TODO.open);
    if (todos.length) console.log(`仕分けが必要な ToDo: ${todos.map((d) => d.id).join(', ')}`);
    const left = wsOf(t.id);
    if (left.length) console.log(`片付けが必要な作業場: ${left.map((w) => w.id).join(', ')}`);
    tidyIfDone(t.id);
  },
  'task detach'({ pos }) {
    const t = getTask(pos[0] || fail('作業の番号が必要です'));
    t.parent_id = '';
    writeJson(P.task(t.id), t);
    commit([P.task(t.id)], `task: ${t.id} 親から切り離し`);
    console.log(`作業 ${t.id} を独立させました`);
  },

  'repo add'({ pos, opt }) {
    const id = pos[0] || fail('リポジトリの呼び名が必要です');
    const p = expand(need(opt, 'path'));
    if (!gitOk(p, 'rev-parse', '--git-dir')) fail(`${p} は Git リポジトリではありません`);
    let remote = typeof opt.remote === 'string' ? opt.remote : '';
    if (!remote) { try { remote = git(p, 'remote', 'get-url', 'origin'); } catch { remote = ''; } }
    writeJson(P.repo(id), { schema: SCHEMA, id, remote_url: remote, path: p });
    commit([P.repo(id)], `repo: ${id}`);
    console.log(`${id} を登録しました(${remote ? 'リモートあり' : '手元だけ'})`);
  },
  'repo list'({ opt }) {
    const rs = listJson(path.join(HUB, 'repos'));
    if (opt.json) return console.log(JSON.stringify(rs, null, 2));
    rs.forEach((r) => console.log(`${r.id}  ${r.remote_url || '(手元だけ)'}  ${r.path}`));
  },

  'ws new'({ opt }) {
    const t = getTask(taskArg(opt));
    if (t.status !== TASK.active) fail(`作業 ${t.id} は ${t.status} なので作業場を切れません`);
    const r = getRepo(need(opt, 'repo'));
    const branch = need(opt, 'branch');
    const base = typeof opt.base === 'string' ? opt.base : git(r.path, 'symbolic-ref', '--short', 'HEAD');
    const dest = path.join(WORK, t.id, r.id);
    if (fs.existsSync(dest)) fail(`${dest} は既にあります`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(r.path, 'worktree', 'add', '-q', '-b', branch, dest, base);
    const w = { schema: SCHEMA, id: newId('w', (i) => fs.existsSync(P.ws(t.id, i))), task_id: t.id, repo_id: r.id, branch, base, path: dest };
    writeJson(P.ws(t.id, w.id), w);
    commit([P.ws(t.id, w.id)], `ws: ${w.id} ${r.id}/${branch}`);
    console.log(`${w.id}  ${dest}`);
  },
  'ws list'({ opt }) {
    const tasks = typeof opt.task === 'string' ? [getTask(opt.task)] : allTasks();
    const rows = tasks.flatMap((t) => wsOf(t.id).map((w) => ({ ...w, task_status: t.status, check: wsCheck(w) })));
    if (opt.json) return console.log(JSON.stringify(rows, null, 2));
    rows.forEach((w) => console.log(`${w.id}  ${w.task_id}[${w.task_status}]  ${w.repo_id}/${w.branch}  ${w.check.exists ? (w.check.clean ? '消してよい' : `残りあり(未コミット ${w.check.uncommitted} / 未取り込み ${w.check.ahead})`) : '実体なし'}`));
  },
  'ws remove'({ pos, opt }) {
    const w = findIn('ws', pos[0] || fail('作業場の番号が必要です'));
    const c = wsCheck(w);
    if (!c.clean) {
      if (!opt.force) fail(`ここにしか無いものが残っています(未コミット ${c.uncommitted} / 未取り込み ${c.ahead})。それでも消すなら --force(人の承認が要ります)`);
      requireGate(w.task_id, '作業場の強制削除', w.id);
    }
    const r = getRepo(w.repo_id);
    if (c.exists) git(r.path, 'worktree', 'remove', ...(opt.force ? ['--force'] : []), w.path);
    gitOk(r.path, 'worktree', 'prune');
    gitOk(r.path, 'branch', '-D', w.branch);
    fs.rmSync(P.ws(w.task_id, w.id));
    try { fs.rmdirSync(path.dirname(w.path)); } catch { /* 他の作業場が残っている */ }
    commit([P.ws(w.task_id, w.id)], `ws: ${w.id} 片付け`);
    console.log(`作業場 ${w.id} を消しました`);
    tidyIfDone(w.task_id);
  },

  'record add'({ opt }) {
    const t = getTask(taskArg(opt));
    const kind = need(opt, 'kind');
    if (!KINDS.includes(kind)) fail(`--kind は ${KINDS.join(' / ')} のどれかです`);
    const file = expand(need(opt, 'file'));
    if (!fs.existsSync(file)) fail(`${file} がありません`);
    const rel = path.relative(HUB, file);
    if (rel.startsWith('..')) fail('記録のファイルは全体管理リポジトリの中に置いてください');
    const r = { schema: SCHEMA, id: newId('r', (i) => fs.existsSync(P.rec(t.id, i))), task_id: t.id, kind, title: need(opt, 'title'), file: rel, status: REC.draft, published_url: '' };
    writeJson(P.rec(t.id, r.id), r);
    commit([P.rec(t.id, r.id), file], `record: ${r.id} ${r.title}`);
    console.log(r.id);
  },
  'record list'({ opt }) {
    const tasks = typeof opt.task === 'string' ? [getTask(opt.task)] : allTasks();
    const rows = tasks.flatMap((t) => recOf(t.id));
    if (opt.json) return console.log(JSON.stringify(rows, null, 2));
    rows.forEach((r) => console.log(`${r.id}  ${r.task_id}  [${r.status}]  ${r.kind}  ${r.title}  ${r.file}`));
  },
  'record confirm'({ pos }) {
    const r = findIn('rec', pos[0] || fail('記録の番号が必要です'));
    if (r.status !== REC.draft) fail(`記録 ${r.id} は既に ${r.status} です`);
    requireGate(r.task_id, '確定', r.id);
    r.status = REC.confirmed;
    writeJson(P.rec(r.task_id, r.id), r);
    commit([P.rec(r.task_id, r.id)], `record: ${r.id} 確定`);
    console.log(`記録 ${r.id} を確定にしました`);
    tidyIfDone(r.task_id);
  },
  'record share'({ pos, opt }) {
    const r = findIn('rec', pos[0] || fail('記録の番号が必要です'));
    if (r.status !== REC.confirmed) fail(`共有できるのは確定した記録だけです(今は ${r.status})`);
    const url = need(opt, 'url');
    requireGate(r.task_id, '共有', r.id);
    r.status = REC.shared; r.published_url = url;
    writeJson(P.rec(r.task_id, r.id), r);
    commit([P.rec(r.task_id, r.id)], `record: ${r.id} 共有`);
    console.log(`記録 ${r.id} を共有にしました`);
  },
  'record drop'({ pos }) {
    const r = findIn('rec', pos[0] || fail('記録の番号が必要です'));
    if (r.status !== REC.draft) fail('捨てられるのは下書きだけです');
    const file = path.join(HUB, r.file);
    fs.rmSync(file, { force: true });
    fs.rmSync(P.rec(r.task_id, r.id));
    commit([P.rec(r.task_id, r.id), file], `record: ${r.id} 破棄`);
    console.log(`記録 ${r.id} を捨てました`);
    tidyIfDone(r.task_id);
  },

  'todo add'({ opt }) {
    const origin = typeof opt.origin === 'string' ? opt.origin : taskFromCwd() || '';
    if (origin) getTask(origin);
    const day = opt.day === 'today' ? today() : typeof opt.day === 'string' ? opt.day : '';
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('--day は YYYY-MM-DD か today です');
    const d = { schema: SCHEMA, id: newId('d', (i) => fs.existsSync(P.todo(i))), text: need(opt, 'text'), day, origin_task_id: origin, status: TODO.open, promoted_to: '' };
    writeJson(P.todo(d.id), d);
    commit([P.todo(d.id)], `todo: ${d.id} ${d.text}`);
    console.log(d.id);
  },
  'todo list'({ opt }) {
    const day = opt.day === 'today' ? today() : typeof opt.day === 'string' ? opt.day : '';
    let ds = allTodos().filter((d) => (opt.all ? true : d.status === TODO.open));
    if (day) ds = ds.filter((d) => !d.day || d.day <= day);
    if (opt.json) return console.log(JSON.stringify(ds, null, 2));
    const ref = day || today();
    ds.sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999'));
    ds.forEach((d) => console.log(`${d.id}  ${d.day ? (d.day < ref ? `持ち越し(${d.day})` : d.day) : 'いつか'}  ${opt.all ? `[${d.status}] ` : ''}${d.text}${d.origin_task_id ? `  ← ${d.origin_task_id}` : ''}`));
  },
  'todo promote'({ pos, opt }) {
    const f = P.todo(pos[0] || fail('ToDo の番号が必要です'));
    if (!fs.existsSync(f)) fail(`ToDo ${pos[0]} がありません`);
    const d = readJson(f);
    if (d.status !== TODO.open) fail(`ToDo ${d.id} は既に ${d.status} です`);
    if (opt.parent) getTask(opt.parent);
    const t = {
      schema: SCHEMA, id: newId('t', (i) => fs.existsSync(P.task(i))), parent_id: opt.parent || '',
      title: typeof opt.title === 'string' ? opt.title : d.text, purpose: typeof opt.purpose === 'string' ? opt.purpose : d.text,
      status: TASK.active, absorbed_into: '', created_at: today(), closed_at: '',
    };
    d.status = TODO.promoted; d.promoted_to = t.id;
    writeJson(P.task(t.id), t); writeJson(f, d);
    commit([P.task(t.id), f], `todo: ${d.id} を作業 ${t.id} に`);
    console.log(t.id);
  },
  'todo done'({ pos }) { setTodo(pos[0], TODO.done); },
  'todo drop'({ pos }) { setTodo(pos[0], TODO.dropped); },

  'gate add'({ opt }) {
    const t = getTask(taskArg(opt));
    const action = need(opt, 'action');
    if (!ACTIONS.includes(action)) fail(`--action は ${ACTIONS.join(' / ')} のどれかです`);
    const g = { schema: SCHEMA, id: newId('g', (i) => fs.existsSync(P.gate(t.id, i))), task_id: t.id, action, target: need(opt, 'target'), status: GATE.pending };
    writeJson(P.gate(t.id, g.id), g);
    commit([P.gate(t.id, g.id)], `gate: ${action} ${g.target} の承認待ち`);
    console.log(g.id);
  },
  'gate list'({ opt }) {
    let gs = allTasks().flatMap((t) => gateOf(t.id));
    if (opt.pending) gs = gs.filter((g) => g.status === GATE.pending);
    if (opt.json) return console.log(JSON.stringify(gs, null, 2));
    gs.forEach((g) => console.log(`${g.id}  ${g.task_id}  [${g.status}]  ${g.action} / ${g.target}`));
  },
  // 人だけが実行する。Claude Code 側では権限設定で毎回確認にしてある。
  'gate approve'({ pos }) {
    const g = findIn('gate', pos[0] || fail('ゲートの番号が必要です'));
    g.status = GATE.approved;
    writeJson(P.gate(g.task_id, g.id), g);
    commit([P.gate(g.task_id, g.id)], `gate: ${g.id} 承認`);
    console.log(`ゲート ${g.id} を承認しました(${g.action} / ${g.target})`);
  },
  'gate check'({ opt }) {
    const t = taskArg(opt);
    const ok = gateOf(t).some((g) => g.action === need(opt, 'action') && g.target === need(opt, 'target') && g.status === GATE.approved);
    if (!ok) requireGate(t, need(opt, 'action'), need(opt, 'target'));
    console.log('承認済み');
  },

  status({ opt }) {
    const tasks = allTasks().filter((t) => t.status !== TASK.tidied);
    const gates = allTasks().flatMap((t) => gateOf(t.id)).filter((g) => g.status === GATE.pending);
    const todos = allTodos().filter((d) => d.status === TODO.open && d.day && d.day <= today());
    if (opt.json) return console.log(JSON.stringify({ tasks, pending_gates: gates, todos_today: todos }, null, 2));
    console.log('■ 作業'); cmd['task list']({ opt: {} });
    console.log('\n■ 承認待ち'); gates.forEach((g) => console.log(`${g.id}  ${g.task_id}  ${g.action} / ${g.target}`));
    console.log('\n■ ToDo(今日まで / 日付なし)'); cmd['todo list']({ opt: { day: 'today' } });
  },
  // 登録の無いフォルダ(ゴミ)と、実体の無い登録を見つける。
  scan({ opt }) {
    const known = new Set(allTasks().flatMap((t) => wsOf(t.id).map((w) => w.path)));
    const stray = [];
    if (fs.existsSync(WORK)) for (const t of fs.readdirSync(WORK)) for (const r of fs.readdirSync(path.join(WORK, t))) {
      const p = path.join(WORK, t, r);
      if (!known.has(p)) stray.push(p);
    }
    const missing = [...known].filter((p) => !fs.existsSync(p));
    if (opt.json) return console.log(JSON.stringify({ unregistered: stray, missing }, null, 2));
    stray.forEach((p) => console.log(`登録なし: ${p}`));
    missing.forEach((p) => console.log(`実体なし: ${p}`));
    if (!stray.length && !missing.length) console.log('ずれはありません');
  },
};

function setTodo(id, status) {
  const f = P.todo(id || fail('ToDo の番号が必要です'));
  if (!fs.existsSync(f)) fail(`ToDo ${id} がありません`);
  const d = readJson(f);
  if (d.status !== TODO.open) fail(`ToDo ${d.id} は既に ${d.status} です`);
  d.status = status;
  writeJson(f, d);
  commit([f], `todo: ${d.id} ${status}`);
  console.log(`ToDo ${d.id} を「${status}」にしました`);
}

// ---------- 入口 ----------
const argv = process.argv.slice(2);
const two = argv.slice(0, 2).join(' ');
const name = cmd[two] ? two : cmd[argv[0]] ? argv[0] : null;
if (!name) {
  console.log(`使い方: hub <コマンド> [--json]\n\n${Object.keys(cmd).map((k) => `  hub ${k}`).join('\n')}\n\n置き場: ${HUB}`);
  process.exit(argv.length ? 1 : 0);
}
if (name !== 'init' && !fs.existsSync(HUB)) fail(`${HUB} がありません。先に hub init を実行してください`);
cmd[name](parse(argv.slice(name.split(' ').length)));
