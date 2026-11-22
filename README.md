# hub

Claude が並列で進める作業を、1か所のデータで統制するための仕組み。
このリポジトリが持つのは仕組みだけで、作業のデータは環境ごとにローカルへ置く。

設計は [design.html](design.html) を開いて読む。

## 導入

Node.js と Git が要る。

```bash
git clone <このリポジトリ> ~/dev/hub
node ~/dev/hub/tool/hub.mjs init --with-permissions
hub status
```

`init` がやること:

- データリポジトリ `~/dev/data` を作る(ローカルの Git で履歴を持つ)
- `~/dev/repos`、`~/dev/work`、`~/dev/profiles`、`~/dev/data/approvals` を作る
- `hub` コマンドを `~/.local/bin` につなぐ
- Claude Code 向けのルール `~/dev/CLAUDE.md` をつなぐ
- `--with-permissions` を付けると、push などを毎回人に確認する設定を `~/.claude/settings.json` に足す

## プロファイルとセッション

セッションの起動には、Claude Code、bubblewrap、socat が要る(`sudo apt-get install bubblewrap socat`)。

```bash
hub profile add default
CLAUDE_CONFIG_DIR=~/dev/profiles/default claude auth login
hub session start --task <作業ID> --prompt "..."
```

既にある設定フォルダをそのままプロファイルにするときは `hub profile add default --path ~/.claude`。
セッションに渡している設定は `hub session settings --task <作業ID>` で見られる。

## MCP

Claude Desktop からは MCP でつなぐ。Windows の Claude Desktop の設定(`claude_desktop_config.json`)に次を足す。`node` の場所は、WSL の中で `which node` を実行して確かめる。

```json
{ "mcpServers": { "hub": { "command": "wsl.exe", "args": ["--", "/usr/bin/node", "/home/<ユーザー名>/dev/hub/tool/mcp.mjs"] } } }
```

## 画面

画面のひな形は `screens/hub.html`。Claude に「アーティファクトとして公開して」と頼み、Claude のデスクトップアプリで開く。公開のときは、手元の MCP `host:hub` と、画面が呼ぶ道具を許可に入れる。ファイルを直接開いても、MCP には届かない。

環境ごとの道具(拡張)は `~/dev/extensions/*.mjs` に置く。形は design.html の「コアと拡張」を参照。

置き場を変えるときは、環境変数 `HUB_ROOT` に `~/dev` の代わりの場所を入れる。
