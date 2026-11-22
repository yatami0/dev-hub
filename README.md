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

置き場を変えるときは、環境変数 `HUB_ROOT` に `~/dev` の代わりの場所を入れる。
