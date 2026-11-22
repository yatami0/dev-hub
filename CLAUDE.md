# ~/dev のルール

この配下の作業は、データリポジトリ(`~/dev/data`)のデータで統制する。仕組み(コマンドと設計)は hub リポジトリ(`~/dev/hub`)にあり、定義の原本は `~/dev/hub/design.html`。

- データの書き換えは必ず `hub` コマンドで行う。JSON を直接編集しない。`hub` だけで一覧が出る。
- 始めるときは `hub status` で全体を見る。作業を作るのは `hub task new`、子に分けるのは `--parent`。
- コードを書き換えるときは `hub ws new --repo <ID> --branch <名前>` で作業場を作り、その中で作業する。`~/dev/repos/` の本体では直接作業しない。
- 書き換えてよいのは自分が担当する作業の配下だけ。他の作業のファイルには触らない。
- 人が見る資料(進捗・判断・調査・図解)は HTML で `~/dev/data/tasks/<作業ID>/` に置き、`hub record add` で登録する。
- 引っかかったこと・後でやることは `hub todo add --text "..."` に残す。
- 作業を終了するときは `hub task close`。作業場は `hub ws remove` で削除する(未反映の変更があれば削除されない)。
- 次の操作は人の承認が要る: push / 記録の確定 / 公開 / 未反映の変更がある作業場の強制削除 / リモートの作成・削除。
- 承認が要る操作は、Claude は実行しない。承認待ちに登録して止まる。push は `hub push <作業場ID>`、記録の確定は `hub record confirm <記録ID>`、強制削除は `hub ws remove <作業場ID> --force`、それ以外は `hub gate add`。`git push` を直接実行しない。
- `hub gate approve` は人だけが実行する。人が承認すると、hub がその操作を実行する。承認待ちで止まったら、承認ゲートの ID を伝えて待つ。
- セッションは `hub session start --task <作業ID> --prompt "..."` で起動し、続きは `hub session resume <セッションID> --prompt "..."` で渡す。
- hub リポジトリ自体を直すのは、仕組みを直す作業として頼まれたときだけ。
