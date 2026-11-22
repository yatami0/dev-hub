# hub

Claude が並列で進める作業を、1か所のデータで統制するための仕組み。
このリポジトリが持つのは仕組みだけで、作業のデータは環境ごとにローカルへ置く。

設計は [design.html](design.html) を開いて読む。

## 導入

上から順に実行する。Linux(Windows では WSL の中)を前提にしている。

### 1. 要るものを入れる

| 要るもの | 使うところ |
| --- | --- |
| Node.js | `hub` コマンドと MCP |
| Git | データの履歴と作業場 |
| Claude Code(`claude` コマンド) | セッション |
| bubblewrap、socat | セッションのサンドボックス |

bubblewrap と socat は次で入る(Ubuntu / Debian の場合)。

```bash
sudo apt-get install bubblewrap socat
```

### 2. clone して初期化する

```bash
git clone <このリポジトリ> ~/dev/hub
node ~/dev/hub/tool/hub.mjs init
hub status
```

`init` がやること:

- データリポジトリ `~/dev/data` を作る(ローカルの Git で履歴を持つ)
- `~/dev/repos`、`~/dev/work`、`~/dev/profiles`、`~/dev/data/approvals` を作る
- `hub` コマンドを `~/.local/bin` につなぐ
- Claude Code 向けのルール `~/dev/CLAUDE.md` をつなぐ

`hub` が見つからないときは、`~/.local/bin` を `PATH` に足す。
`init` の最後に「承認の強制は入れていません」と出るが、そのままでよい。push などの承認が要る操作は、人が承認したあとに hub が実行する。

### 3. プロファイルを作る

プロファイルは、セッションが使う Claude Code の設定フォルダ。作業にプロファイルを指定しなければ `default` が使われるので、まず `default` を作ってログインする。ログインは人がやる。

```bash
hub profile add default
CLAUDE_CONFIG_DIR=~/dev/profiles/default claude auth login
hub profile list
```

`hub profile list` で `default` が「ログイン済み」になっていればよい。
既にある設定フォルダをそのままプロファイルにするときは、上の2行の代わりに `hub profile add default --path ~/.claude`。

### 4. Claude Desktop に MCP をつなぐ

Claude Desktop からは MCP でつなぐ。Windows の Claude Desktop の設定(`claude_desktop_config.json`)に次を足し、Claude Desktop を起動し直す。`/usr/bin/node` のところは、WSL の中で `which node` を実行して出た場所に、`<ユーザー名>` は WSL のユーザー名に置き換える。

```json
{ "mcpServers": { "hub": { "command": "wsl.exe", "args": ["--", "/usr/bin/node", "/home/<ユーザー名>/dev/hub/tool/mcp.mjs"] } } }
```

### 5. 作業を1件通して確かめる

```bash
hub task new --title "試し" --purpose "導入の確認"
hub session start --task <作業ID> --prompt "..."
```

`hub task new` が作業 ID を出すので、それを `--task` に渡す。セッションに渡している設定は `hub session settings --task <作業ID>` で見られる。

## 画面

画面のひな形は `screens/hub.html`。Claude に「アーティファクトとして公開して」と頼み、Claude のデスクトップアプリで開く。公開のときは、手元の MCP `host:hub` と、画面が呼ぶ道具を許可に入れる。ファイルを直接開いても、MCP には届かない。

環境ごとの道具(拡張)は `~/dev/extensions/*.mjs` に置く。形は design.html の「コアと拡張」を参照。

置き場を変えるときは、環境変数 `HUB_ROOT` に `~/dev` の代わりの場所を入れる。
