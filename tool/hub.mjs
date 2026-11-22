#!/usr/bin/env node
// hub: 作業データを書き換える唯一の入口。
// このリポジトリは「仕組み」だけを持つ。データは HUB_ROOT(既定 ~/dev)/data に環境ごとに置く。
// 定義は design.html が原本。1件1ファイルの JSON、項目は入れ子にしない、状態の値は下の定数だけ。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = process.env.HUB_ROOT || path.join(os.homedir(), 'dev');
const HUB = path.join(ROOT, 'data'); // データリポジトリ。仕組み(このリポジトリ)とは別に、環境ごとに持つ
const KIT = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const WORK = path.join(ROOT, 'work');
const APPROVALS = path.join(HUB, 'approvals'); // 承認の記録。セッションからは書けない場所にする
const PROFILES = path.join(ROOT, 'profiles'); // プロファイル。Git の管理の外に置く
const DEFAULT_PROFILE = 'default';
const SCHEMA = 1;

const TASK = { active: '進行中', closed: '終了', tidied: '片付け済み' };
const REC = { draft: '下書き', confirmed: '確定', shared: '公開' };
const KINDS = ['進捗', '判断', '調査', '図解'];
const TODO = { open: '未着手', promoted: '作業化済み', done: '完了', dropped: '捨てた' };
const GATE = { pending: '承認待ち', approved: '承認済み', done: '実行済み' };
const ACTIONS = ['push', '確定', '公開', '作業場の強制削除', 'リモートの作成・削除'];

// ---------- 小道具 ----------
const fail = (msg) => { console.error(`エラー: ${msg}`); process.exit(1); };
const today = () => new Date().toLocaleDateString('sv-SE');
const now = () => new Date().toLocaleString('sv-SE');
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
  return execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const gitOk = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

// 自分が触ったファイルだけをローカルでコミットする。ぶつかったら後から来た側がやり直す。
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
  sess: (t, id) => path.join(HUB, 'tasks', t, 'sessions', `${id}.json`),
  approval: (id) => path.join(APPROVALS, `${id}.json`),
  profile: (name) => path.join(PROFILES, name),
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
// 承認ゲートの状態は、承認の記録から決める。承認ゲートのファイルに書かれた status は信用しない。
function gateStatus(g) {
  if (!fs.existsSync(P.approval(g.id))) return GATE.pending;
  const a = readJson(P.approval(g.id));
  if (a.action !== g.action || a.target !== g.target) return GATE.pending;
  return a.executed_at ? GATE.done : GATE.approved;
}
const gateOf = (t) => listJson(path.join(P.taskDir(t), 'gates')).map((g) => ({ ...g, status: gateStatus(g) }));
const sessOf = (t) => listJson(path.join(P.taskDir(t), 'sessions'));
const allTodos = () => listJson(path.join(HUB, 'todos'));

function findIn(kind, id) {
  for (const t of allTasks()) {
    const hit = (kind === 'ws' ? wsOf(t.id) : kind === 'rec' ? recOf(t.id) : kind === 'sess' ? sessOf(t.id) : gateOf(t.id)).find((x) => x.id === id);
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
// 未反映の変更があるかは保存せず、毎回 Git に聞く。
function wsCheck(w) {
  if (!fs.existsSync(w.path)) return { exists: false, uncommitted: 0, ahead: 0, clean: true };
  const uncommitted = git(w.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
  const base = gitOk(w.path, 'rev-parse', '--verify', '-q', `origin/${w.base}`) ? `origin/${w.base}` : w.base;
  const ahead = Number(git(w.path, 'rev-list', '--count', `${base}..HEAD`));
  return { exists: true, uncommitted, ahead, clean: uncommitted === 0 && ahead === 0 };
}

// まだ実行していない承認ゲートが無ければ、承認待ちとして登録する。実行は、人が承認したときに hub が行う。
function ensureGate(taskId, action, target) {
  let g = gateOf(taskId).find((x) => x.action === action && x.target === target && x.status !== GATE.done);
  if (!g) {
    g = { schema: SCHEMA, id: newId('g', (i) => fs.existsSync(P.gate(taskId, i))), task_id: taskId, action, target, status: GATE.pending };
    writeJson(P.gate(taskId, g.id), g);
    commit([P.gate(taskId, g.id)], `gate: ${action} ${target} の承認待ち`);
  }
  return g;
}
const queued = (g) => console.log(g.status === GATE.pending
  ? `承認待ちに登録しました: ${g.id}(${g.action} / ${g.target})。人が承認すると hub が実行します`
  : `承認済みです: ${g.id}。hub gate approve ${g.id} で実行されます`);

// ---------- プロファイル ----------
// プロファイルはデータとして保存しない。フォルダを見て読み取る。
const profiles = () => (fs.existsSync(PROFILES) ? fs.readdirSync(PROFILES).sort().filter((n) => fs.statSync(P.profile(n), { throwIfNoEntry: false })?.isDirectory()) : []);
const checkProfile = (name) => (profiles().includes(name) ? name : fail(`プロファイル ${name} がありません。作るには: hub profile add ${name}`));
const profileOf = (t) => t.profile || DEFAULT_PROFILE;

function newTask(opt, title, purpose) {
  if (opt.parent) getTask(opt.parent);
  if (typeof opt.profile === 'string') checkProfile(opt.profile);
  return {
    schema: SCHEMA, id: newId('t', (i) => fs.existsSync(P.task(i))), parent_id: opt.parent || '',
    title, purpose, status: TASK.active, absorbed_into: '', created_at: today(), closed_at: '',
    profile: typeof opt.profile === 'string' ? opt.profile : '',
  };
}

// ---------- 承認されたときに hub が実行する操作 ----------
function doPush(w) {
  const r = getRepo(w.repo_id);
  if (!r.remote_url) throw new Error(`リポジトリ ${r.id} はローカルのみです(remote_url が空)`);
  if (!fs.existsSync(w.path)) throw new Error(`作業場 ${w.id} の実体がありません`);
  console.log(`push: ${r.remote_url} ${w.branch}`);
  git(w.path, 'push', r.remote_url, `${w.branch}:${w.branch}`);
}
function doConfirm(r) {
  if (r.status !== REC.draft) throw new Error(`記録 ${r.id} は既に ${r.status} です`);
  r.status = REC.confirmed;
  writeJson(P.rec(r.task_id, r.id), r);
  commit([P.rec(r.task_id, r.id)], `record: ${r.id} 確定`);
  console.log(`記録 ${r.id} を確定にしました`);
  tidyIfDone(r.task_id);
}
function doRemove(w, force) {
  const r = getRepo(w.repo_id);
  if (fs.existsSync(w.path)) git(r.path, 'worktree', 'remove', ...(force ? ['--force'] : []), w.path);
  gitOk(r.path, 'worktree', 'prune');
  gitOk(r.path, 'branch', '-D', w.branch);
  fs.rmSync(P.ws(w.task_id, w.id));
  try { fs.rmdirSync(path.dirname(w.path)); } catch { /* 他の作業場が残っている */ }
  commit([P.ws(w.task_id, w.id)], `ws: ${w.id} 片付け`);
  console.log(`作業場 ${w.id} を削除しました`);
  tidyIfDone(w.task_id);
}
// 承認ゲートの対象を、操作ごとに確かめる。
function gateTarget(taskId, action, target) {
  if (action === 'push' || action === '作業場の強制削除') return wsOf(taskId).find((w) => w.id === target) || fail(`対象は、この作業の作業場の ID にしてください: ${target}`);
  if (action === '確定' || action === '公開') return recOf(taskId).find((r) => r.id === target) || fail(`対象は、この作業の記録の ID にしてください: ${target}`);
  return target;
}

// ---------- セッション ----------
// セッションに渡す設定。サンドボックス(Bash)と禁止の設定(Read / Edit / Write)の両方で、
// 認証情報の置き場と承認の記録を守る。
function sessionSettings(t) {
  fs.mkdirSync(APPROVALS, { recursive: true });
  const repos = [...new Set(wsOf(t.id).map((w) => getRepo(w.repo_id).path))];
  const gitDirs = [path.join(HUB, '.git'), ...repos.map((r) => path.join(r, '.git'))];
  const creds = [...new Set([path.join(os.homedir(), '.claude'), ...profiles().map((n) => fs.realpathSync(P.profile(n)))])].map((d) => path.join(d, '.credentials.json'));
  const abs = (p) => `/${p}`; // 権限のルールでは // で始めると絶対パスになる
  return {
    permissions: {
      // 承認の記録は、読めるが書けないようにする。Read を禁止すると、サンドボックスの中では空の場所に差し替わり、
      // 書き込みが通ったように見えてしまう。
      deny: [`Edit(${abs(APPROVALS)}/**)`, ...creds.map((c) => `Read(${abs(c)})`), `Edit(${abs(KIT)}/**)`, 'Bash(git push*)', 'Bash(hub gate approve*)'],
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [HUB, ...repos.map((r) => path.join(r, '.git'))],
        denyWrite: [APPROVALS, KIT, ...gitDirs.flatMap((g) => [path.join(g, 'config'), path.join(g, 'hooks')])],
        denyRead: creds,
      },
    },
  };
}

function runSession(s, prompt, opt) {
  const t = getTask(s.task_id);
  const note = `あなたは作業 ${t.id}「${t.title}」を担当しています。目的: ${t.purpose}。対話なしで動いているので、人に確認はできません。push などの承認が要る操作は hub コマンドで承認待ちに登録し、そこで止まってください。`;
  const args = ['-p', prompt, '--output-format', 'json', '--settings', JSON.stringify(sessionSettings(t)),
    '--permission-mode', 'acceptEdits', '--add-dir', P.taskDir(t.id), '--append-system-prompt', note];
  if (s.claude_session_id) args.push('--resume', s.claude_session_id);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: fs.realpathSync(P.profile(s.profile)), HUB_ROOT: ROOT, HUB_SESSION: '1' });
  let out;
  try {
    out = execFileSync('claude', args, { cwd: s.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { out = e.stdout || fail(`セッションを起動できませんでした: ${e.message}`); }
  let j;
  try { j = JSON.parse(out); } catch { fail(`セッションの結果を読めませんでした: ${out.slice(0, 300)}`); }
  if (!s.claude_session_id && j.session_id) {
    s.claude_session_id = j.session_id;
    writeJson(P.sess(s.task_id, s.id), s);
    commit([P.sess(s.task_id, s.id)], `session: ${s.id} 開始`);
  }
  // 拒否があってもエラーにはならないので、拒否された操作の一覧を必ず返す。
  const denied = (j.permission_denials || []).map((d) => ({ tool: d.tool_name, input: d.tool_input.command || d.tool_input.file_path || '' }));
  if (opt.json) console.log(JSON.stringify({ session: s, is_error: !!j.is_error, result: j.result, denied }, null, 2));
  else {
    console.log(`${s.id}  ${j.is_error ? '[エラー]' : '[完了]'}\n${j.result}`);
    if (denied.length) console.log(`\n拒否された操作(${denied.length} 件):\n${denied.map((d) => `  ${d.tool}: ${d.input}`).join('\n')}`);
  }
  if (j.is_error) process.exit(1);
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
  // clone した先で1回だけ実行する。データリポジトリを作り、コマンドとルールをつなぐ。
  init({ opt }) {
    fs.mkdirSync(HUB, { recursive: true });
    if (!fs.existsSync(path.join(HUB, '.git'))) {
      git(HUB, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(HUB, '.gitignore'), '*.tmp\n');
      git(HUB, 'add', '.gitignore');
      git(HUB, 'commit', '-q', '-m', 'データリポジトリを開始');
      console.log(`データリポジトリを作りました: ${HUB}`);
    } else console.log(`データリポジトリは既にあります: ${HUB}`);
    for (const d of ['repos', 'work', 'profiles', path.join('data', 'approvals')]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
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
    const t = newTask(opt, need(opt, 'title'), need(opt, 'purpose'));
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
      records: recOf(t.id), gates: gateOf(t.id), sessions: sessOf(t.id), todos: allTodos().filter((d) => d.origin_task_id === t.id),
    };
    if (opt.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`${t.id}  [${t.status}]  ${t.title}\n  目的: ${t.purpose}`);
    console.log(`  プロファイル: ${profileOf(t)}`);
    if (t.parent_id) console.log(`  親: ${t.parent_id}`);
    if (t.absorbed_into) console.log(`  吸収先: ${t.absorbed_into}`);
    data.children.forEach((c) => console.log(`  子: ${c.id} [${c.status}] ${c.title}`));
    data.workspaces.forEach((w) => console.log(`  作業場: ${w.id} ${w.repo_id}/${w.branch} → ${w.check.exists ? (w.check.clean ? '削除してよい' : `未反映あり(未コミット ${w.check.uncommitted} / 未取り込み ${w.check.ahead})`) : '実体なし'}`));
    data.records.forEach((r) => console.log(`  記録: ${r.id} [${r.status}] ${r.kind} ${r.title}`));
    data.gates.forEach((g) => console.log(`  承認ゲート: ${g.id} [${g.status}] ${g.action} / ${g.target}`));
    data.sessions.forEach((x) => console.log(`  セッション: ${x.id} ${x.started_at} ${x.cwd}`));
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
    const t = getTask(pos[0] || fail('作業の IDが必要です'));
    t.parent_id = '';
    writeJson(P.task(t.id), t);
    commit([P.task(t.id)], `task: ${t.id} 親から切り離し`);
    console.log(`作業 ${t.id} を独立させました`);
  },

  'repo add'({ pos, opt }) {
    const id = pos[0] || fail('リポジトリのIDが必要です');
    const p = expand(need(opt, 'path'));
    if (!gitOk(p, 'rev-parse', '--git-dir')) fail(`${p} は Git リポジトリではありません`);
    let remote = typeof opt.remote === 'string' ? opt.remote : '';
    if (!remote) { try { remote = git(p, 'remote', 'get-url', 'origin'); } catch { remote = ''; } }
    if (typeof opt.profile === 'string') checkProfile(opt.profile);
    writeJson(P.repo(id), { schema: SCHEMA, id, remote_url: remote, path: p, profile: typeof opt.profile === 'string' ? opt.profile : '' });
    commit([P.repo(id)], `repo: ${id}`);
    console.log(`${id} を登録しました(${remote ? 'リモートあり' : 'ローカルのみ'})`);
  },
  'repo list'({ opt }) {
    const rs = listJson(path.join(HUB, 'repos'));
    if (opt.json) return console.log(JSON.stringify(rs, null, 2));
    rs.forEach((r) => console.log(`${r.id}  ${r.remote_url || '(ローカルのみ)'}  ${r.path}${r.profile ? `  プロファイル: ${r.profile}` : ''}`));
  },

  'ws new'({ opt }) {
    const t = getTask(taskArg(opt));
    if (t.status !== TASK.active) fail(`作業 ${t.id} は ${t.status} なので作業場を作れません`);
    const r = getRepo(need(opt, 'repo'));
    if (r.profile && r.profile !== profileOf(t)) fail(`リポジトリ ${r.id} はプロファイル ${r.profile} 用です。この作業のプロファイルは ${profileOf(t)} です`);
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
    rows.forEach((w) => console.log(`${w.id}  ${w.task_id}[${w.task_status}]  ${w.repo_id}/${w.branch}  ${w.check.exists ? (w.check.clean ? '削除してよい' : `未反映あり(未コミット ${w.check.uncommitted} / 未取り込み ${w.check.ahead})`) : '実体なし'}`));
  },
  'ws remove'({ pos, opt }) {
    const w = findIn('ws', pos[0] || fail('作業場の IDが必要です'));
    const c = wsCheck(w);
    if (c.clean) return doRemove(w, false);
    if (!opt.force) fail(`未反映の変更があります(未コミット ${c.uncommitted} / 未取り込み ${c.ahead})。それでも削除するなら --force(人の承認が要ります)`);
    queued(ensureGate(w.task_id, '作業場の強制削除', w.id));
  },
  // push は hub が実行する。ここでは承認待ちに登録するだけ。
  push({ pos }) {
    const w = findIn('ws', pos[0] || fail('作業場の IDが必要です'));
    if (!getRepo(w.repo_id).remote_url) fail(`リポジトリ ${w.repo_id} はローカルのみです`);
    queued(ensureGate(w.task_id, 'push', w.id));
  },

  'record add'({ opt }) {
    const t = getTask(taskArg(opt));
    const kind = need(opt, 'kind');
    if (!KINDS.includes(kind)) fail(`--kind は ${KINDS.join(' / ')} のどれかです`);
    const file = expand(need(opt, 'file'));
    if (!fs.existsSync(file)) fail(`${file} がありません`);
    const rel = path.relative(HUB, file);
    if (rel.startsWith('..')) fail('記録のファイルはデータリポジトリの中に置いてください');
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
    const r = findIn('rec', pos[0] || fail('記録の IDが必要です'));
    if (r.status !== REC.draft) fail(`記録 ${r.id} は既に ${r.status} です`);
    queued(ensureGate(r.task_id, '確定', r.id));
  },
  // 公開そのものは hub の外で行う。承認済みのときだけ、URL を記録する。
  'record share'({ pos, opt }) {
    const r = findIn('rec', pos[0] || fail('記録の IDが必要です'));
    if (r.status !== REC.confirmed) fail(`公開できるのは確定した記録だけです(今は ${r.status})`);
    const url = need(opt, 'url');
    const g = ensureGate(r.task_id, '公開', r.id);
    if (g.status !== GATE.approved) return queued(g);
    r.status = REC.shared; r.published_url = url;
    writeJson(P.rec(r.task_id, r.id), r);
    commit([P.rec(r.task_id, r.id)], `record: ${r.id} 公開`);
    console.log(`記録 ${r.id} を公開にしました`);
  },
  'record drop'({ pos }) {
    const r = findIn('rec', pos[0] || fail('記録の IDが必要です'));
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
    const f = P.todo(pos[0] || fail('ToDo の IDが必要です'));
    if (!fs.existsSync(f)) fail(`ToDo ${pos[0]} がありません`);
    const d = readJson(f);
    if (d.status !== TODO.open) fail(`ToDo ${d.id} は既に ${d.status} です`);
    const t = newTask(opt, typeof opt.title === 'string' ? opt.title : d.text, typeof opt.purpose === 'string' ? opt.purpose : d.text);
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
    gateTarget(t.id, action, need(opt, 'target'));
    console.log(ensureGate(t.id, action, opt.target).id);
  },
  'gate list'({ opt }) {
    let gs = allTasks().flatMap((t) => gateOf(t.id));
    if (opt.pending) gs = gs.filter((g) => g.status === GATE.pending);
    if (opt.json) return console.log(JSON.stringify(gs, null, 2));
    gs.forEach((g) => console.log(`${g.id}  ${g.task_id}  [${g.status}]  ${g.action} / ${g.target}`));
  },
  // 人だけが実行する。承認を記録し、続けてその操作を hub が実行する。
  // 承認の記録は、セッションからは書けない場所にある。
  'gate approve'({ pos }) {
    if (process.env.HUB_SESSION) fail('セッションの中からは承認できません');
    const g = findIn('gate', pos[0] || fail('承認ゲートの IDが必要です'));
    if (g.status === GATE.done) fail(`承認ゲート ${g.id} は実行済みです`);
    const target = gateTarget(g.task_id, g.action, g.target);
    const a = g.status === GATE.approved ? readJson(P.approval(g.id))
      : { schema: SCHEMA, gate_id: g.id, action: g.action, target: g.target, approved_at: now(), executed_at: '' };
    const save = (status) => {
      writeJson(P.approval(g.id), a);
      writeJson(P.gate(g.task_id, g.id), { ...g, status });
      commit([P.approval(g.id), P.gate(g.task_id, g.id)], `gate: ${g.id} ${status}`);
    };
    save(GATE.approved);
    console.log(`承認ゲート ${g.id} を承認しました(${g.action} / ${g.target})`);
    try {
      if (g.action === 'push') doPush(target);
      else if (g.action === '確定') doConfirm(target);
      else if (g.action === '作業場の強制削除') doRemove(target, true);
      else return console.log('この操作は hub の外で実行します。');
    } catch (e) {
      fail(`承認は記録しましたが、実行に失敗しました: ${String(e.stderr || e.message).trim()}\nもう一度 hub gate approve ${g.id} で再実行できます`);
    }
    a.executed_at = now();
    save(GATE.done);
    console.log('実行しました');
  },
  'gate check'({ opt }) {
    const g = ensureGate(taskArg(opt), need(opt, 'action'), need(opt, 'target'));
    console.log(`${g.id}  ${g.status}`);
    if (g.status !== GATE.approved) process.exit(1);
  },

  'profile list'({ opt }) {
    const rows = profiles().map((n) => ({ name: n, path: fs.realpathSync(P.profile(n)), logged_in: fs.existsSync(path.join(P.profile(n), '.credentials.json')) }));
    if (opt.json) return console.log(JSON.stringify(rows, null, 2));
    rows.forEach((p) => console.log(`${p.name}${p.name === DEFAULT_PROFILE ? '(既定)' : ''}  ${p.logged_in ? 'ログイン済み' : '未ログイン'}  ${p.path}`));
  },
  // 空のプロファイルを作る。--path を付けると、既にある設定フォルダをそのままプロファイルにする。
  'profile add'({ pos, opt }) {
    const name = pos[0] || fail('プロファイルの名前が必要です');
    if (!/^[\w-]+$/.test(name)) fail('プロファイルの名前は英数字と - _ だけにしてください');
    if (fs.lstatSync(P.profile(name), { throwIfNoEntry: false })) fail(`プロファイル ${name} は既にあります`);
    fs.mkdirSync(PROFILES, { recursive: true });
    if (typeof opt.path === 'string') {
      const src = expand(opt.path);
      if (!fs.existsSync(src)) fail(`${src} がありません`);
      fs.symlinkSync(src, P.profile(name));
    } else fs.mkdirSync(P.profile(name));
    console.log(`プロファイル ${name} を作りました: ${P.profile(name)}`);
    if (!fs.existsSync(path.join(P.profile(name), '.credentials.json'))) console.log(`ログイン(人がやる): CLAUDE_CONFIG_DIR=${P.profile(name)} claude auth login`);
  },

  // 対話なしで Claude Code のセッションを起動する。作業場を指定しなければ、作業のフォルダで動く。
  'session start'({ opt }) {
    const t = getTask(taskArg(opt));
    if (t.status !== TASK.active) fail(`作業 ${t.id} は ${t.status} なのでセッションを起動できません`);
    const cwd = typeof opt.ws === 'string' ? (wsOf(t.id).find((w) => w.id === opt.ws) || fail(`作業場 ${opt.ws} はこの作業にありません`)).path : P.taskDir(t.id);
    const s = { schema: SCHEMA, id: newId('s', (i) => fs.existsSync(P.sess(t.id, i))), task_id: t.id, profile: checkProfile(profileOf(t)), cwd, started_at: now(), claude_session_id: '' };
    runSession(s, need(opt, 'prompt'), opt);
  },
  'session resume'({ pos, opt }) {
    const s = findIn('sess', pos[0] || fail('セッションの IDが必要です'));
    checkProfile(s.profile);
    runSession(s, need(opt, 'prompt'), opt);
  },
  // セッションに渡す設定を表示する。何を止めているかを人が確かめるためのもの。
  'session settings'({ opt }) { console.log(JSON.stringify(sessionSettings(getTask(taskArg(opt))), null, 2)); },
  'session list'({ opt }) {
    const tasks = typeof opt.task === 'string' ? [getTask(opt.task)] : allTasks();
    const rows = tasks.flatMap((t) => sessOf(t.id));
    if (opt.json) return console.log(JSON.stringify(rows, null, 2));
    rows.forEach((x) => console.log(`${x.id}  ${x.task_id}  ${x.profile}  ${x.started_at}  ${x.cwd}`));
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
  // 未登録のフォルダ(削除対象)と、実体の無い登録を見つける。
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
  const f = P.todo(id || fail('ToDo の IDが必要です'));
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
