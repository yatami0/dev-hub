# hub

Claude が並列で進める作業を、1か所のデータで統制するための仕組み。
このリポジトリが持つのは仕組みだけで、作業のデータは環境ごとに手元へ置く。

設計は [design.html](design.html) を開いて読む。

## 導入

Node.js と Git が要る。

```bash
git clone <このリポジトリ> ~/dev/hub
node ~/dev/hub/tool/hub.mjs init --with-permissions
hub status
```

`init` がやること:

- データの入れ物 `~/dev/data` を作る(手元の Git で履歴を持つ)
- `~/dev/repos` と `~/dev/work` を作る
- `hub` コマンドを `~/.local/bin` につなぐ
- Claude Code 向けの決まり `~/dev/CLAUDE.md` をつなぐ
- `--with-permissions` を付けると、push などを毎回人に確認する設定を `~/.claude/settings.json` に足す

置き場を変えるときは、環境変数 `HUB_ROOT` に `~/dev` の代わりの場所を入れる。
