#!/usr/bin/env node
// hub の MCP。中身は hub コマンドを呼ぶだけの薄い層。
// コア: 下の表にある hub コマンド。拡張: HUB_ROOT/extensions/*.mjs(環境ごとに足す、読み取りだけ)。
// 標準入出力で JSON-RPC を1行ずつやり取りする。依存するパッケージは無い。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.HUB_ROOT || path.join(os.homedir(), 'dev');
const HUB = path.join(path.dirname(fs.realpathSync(process.argv[1])), 'hub.mjs');

// [コマンド, 説明, 位置で渡す引数, 値を取るオプション(* は必須), 値を取らないオプション, --json を付けるか]
const CORE = [
  ['status', '全体の状況(作業、承認待ち、今日までの ToDo)を返す', '', [], [], true],
  ['task new', '作業を作る', '', ['title*', 'purpose*', 'parent', 'profile'], [], false],
  ['task list', '作業の一覧を返す', '', [], ['all'], true],
  ['task show', '作業1件と、その作業場・記録・承認ゲート・セッション・ToDo を返す', 'id', [], [], true],
  ['task close', '作業を終了する', 'id', ['absorbed-into'], [], false],
  ['task detach', '子の作業を親から切り離す', 'id', [], [], false],
  ['repo add', 'リポジトリを登録する', 'id', ['path*', 'remote', 'profile'], [], false],
  ['repo list', 'リポジトリの一覧を返す', '', [], [], true],
  ['ws new', '作業場を作る', '', ['task*', 'repo*', 'branch*', 'base'], [], false],
  ['ws list', '作業場の一覧と、未反映の変更の有無を返す', '', ['task'], [], true],
  ['ws remove', '作業場を削除する。未反映の変更があるときは force で承認待ちに登録する', 'id', [], ['force'], false],
  ['push', '作業場のブランチの push を承認待ちに登録する。実行は承認のあとに hub が行う', 'id', [], [], false],
  ['record add', '記録(HTML)を登録する', '', ['task*', 'kind*', 'title*', 'file*'], [], false],
  ['record list', '記録の一覧を返す', '', ['task'], [], true],
  ['record confirm', '記録の確定を承認待ちに登録する', 'id', [], [], false],
  ['record share', '承認済みの公開について、公開した URL を記録する', 'id', ['url*'], [], false],
  ['record drop', '下書きの記録を捨てる', 'id', [], [], false],
  ['todo add', 'ToDo を足す', '', ['text*', 'day', 'origin'], [], false],
  ['todo list', 'ToDo の一覧を返す', '', ['day'], ['all'], true],
  ['todo promote', 'ToDo を作業にする', 'id', ['title', 'purpose', 'parent', 'profile'], [], false],
  ['todo done', 'ToDo を完了にする', 'id', [], [], false],
  ['todo drop', 'ToDo を捨てる', 'id', [], [], false],
  ['gate add', '承認ゲートを承認待ちとして登録する', '', ['task*', 'action*', 'target*'], [], false],
  ['gate list', '承認ゲートの一覧を返す', '', [], ['pending'], true],
  ['gate approve', '承認ゲートを承認し、続けてその操作を hub が実行する。人がはっきり承認したときだけ呼ぶこと。Claude の判断では呼ばない', 'id', [], [], false],
  ['profile list', 'プロファイルの一覧を返す', '', [], [], true],
  ['session start', '対話なしで Claude Code のセッションを起動し、終わるまで待って結果を返す', '', ['task*', 'prompt*', 'ws'], [], true],
  ['session resume', 'セッションを再開して続きの指示を渡し、終わるまで待って結果を返す', 'id', ['prompt*'], [], true],
  ['session list', 'セッションの一覧を返す', '', ['task'], [], true],
  ['scan', '未登録の作業場と、実体の無い登録を返す', '', [], [], true],
];

const prop = (k) => k.replace('-', '_');
const tools = new Map();
for (const [cmd, description, pos, opts, flags, json] of CORE) {
  const properties = {}, required = [];
  if (pos) { properties[pos] = { type: 'string', description: 'ID' }; required.push(pos); }
  for (const o of opts) {
    const k = o.replace('*', '');
    properties[prop(k)] = { type: 'string' };
    if (o.endsWith('*')) required.push(prop(k));
  }
  for (const f of flags) properties[prop(f)] = { type: 'boolean' };
  tools.set(cmd.replace(' ', '_'), {
    description, inputSchema: { type: 'object', properties, required },
    run: (a) => {
      const argv = [...cmd.split(' ')];
      if (pos) argv.push(String(a[pos]));
      for (const o of opts) { const k = o.replace('*', ''); if (a[prop(k)] !== undefined && a[prop(k)] !== '') argv.push(`--${k}`, String(a[prop(k)])); }
      for (const f of flags) if (a[prop(f)] === true) argv.push(`--${f}`);
      if (json) argv.push('--json');
      return hub(argv);
    },
  });
}

function hub(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [HUB, ...argv], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ text: [stdout, stderr].map((x) => x.trim()).filter(Boolean).join('\n') || '(出力なし)', isError: !!err });
    });
  });
}

// 拡張: HUB_ROOT/extensions/*.mjs が `export const tools = [{ name, description, inputSchema, run }]` を持つ。
// run は引数を受け取り、文字列か JSON にできる値を返す。名前の先頭には ext_ が付く。
const extDir = path.join(ROOT, 'extensions');
if (fs.existsSync(extDir)) for (const f of fs.readdirSync(extDir).filter((n) => n.endsWith('.mjs')).sort()) {
  try {
    const mod = await import(pathToFileURL(path.join(extDir, f)).href);
    for (const t of mod.tools || []) {
      tools.set(`ext_${t.name}`, {
        description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} },
        run: async (a) => { const r = await t.run(a); return { text: typeof r === 'string' ? r : JSON.stringify(r, null, 2), isError: false }; },
      });
    }
  } catch (e) { console.error(`拡張 ${f} を読めませんでした: ${e.message}`); }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // 通知には答えない
  if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hub', version: '1' } } });
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: [...tools].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  if (method === 'tools/call') {
    const t = tools.get(params?.name);
    if (!t) return send({ id, error: { code: -32602, message: `道具 ${params?.name} はありません` } });
    const a = params.arguments || {};
    const missing = (t.inputSchema.required || []).filter((k) => a[k] === undefined || a[k] === '');
    let r;
    if (missing.length) r = { text: `必要な引数がありません: ${missing.join(', ')}`, isError: true };
    else { try { r = await t.run(a); } catch (e) { r = { text: `失敗しました: ${e.message}`, isError: true }; } }
    return send({ id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
  }
  send({ id, error: { code: -32601, message: `未対応のメソッド: ${method}` } });
}

const pending = new Set();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'JSON として読めません' } }); }
  const p = handle(req).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.all(pending); process.exit(0); });
