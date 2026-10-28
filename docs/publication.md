# 公開前レビューと公開手順

このリポジトリは、完成した Desktop v1 を1件の Initial Commit から公開する構成です。実データ・運用認証情報は含めません。公開するアプリ内容と実動作検証の対応は、[検証記録](verification.md)の build input ダイジェストで確認します。受け入れ結果は検証時点のアプリ内容に対する証拠として示し、文書整理だけで実動作試験を再実施したとは扱いません。

## 公開直前に作者が確認すること

- [ ] README の機能・検証範囲・Codex 活用の説明が、自分の経験と一致している。
- [ ] 課題設定・要件・受け入れ判断と、Codexを活用した設計比較・実装・検証を、実際の役割に沿って説明している。
- [ ] 画像は架空データの実画面で、個人の声・教材・内部情報がない。
- [ ] [MIT License](../LICENSE) の適用範囲が自作コード・文書であることを確認した。依存コード・VOICEVOXのengine/model・生成音声・利用者の教材や録音は、それぞれ [別の条件](../THIRD_PARTY_NOTICES.md)であることを確認した。
- [ ] [検証記録](verification.md)の成功・skip・未実施を確認した。
- [ ] 送信先が `yutoo77/listen-capture-app` であることを確認した。
- [ ] 下記の監査が、最終成果物・全Git履歴・全ref/objectに対して実行済み。
- [ ] 公開先で非公開の脆弱性報告窓口（GitHub Private vulnerability reporting等）を用意する。現時点では未設定。
- [ ] 新規Privateリポジトリの作成と、対象Initial Commitのmainへのpushの承認範囲を確認した。
- [ ] Public化は別の最終承認を受ける。Privateへのpushだけでは公開しない。

## 公開物に含めないもの

旧 `.git`、内部 PR・commit へのリンク、実AWSの識別子・接続手順・State、`.env`、鍵・証明書・Cookie、DB・backup・ログ、録音・実教材、依存パッケージ本体、VOICEVOX engine/model。元データは削除せず原本側に保全します。

公開用の画像・デモ以外のバイナリは、原則として含めません。`.gitignore` だけに頼らず、**全ファイルを確認した clean tree** を配布対象にします。実行して作った `.env` や `.local` が残る作業ディレクトリを、そのまま ZIP にしないでください。

## 初回 push 前の監査

新しい Initial Commit を作成した後、remote を設定する前の clean tree で実行します。

```sh
python scripts/audit-public.py . --require-initial --report ../publication-audit.json
gitleaks dir . --redact=100 --no-banner --report-format json --report-path ../gitleaks-files.json
gitleaks git . --redact=100 --no-banner --report-format json --report-path ../gitleaks-history.json
```

`--require-initial`は全refの総commit数1件・親のないHEAD・remote未設定・clean tree・noreply作者を確認します。push後は別工程で、許可された origin・送信commit・新しい clone のファイル内容を照合します。監査のために remote を外したり、失敗記録を上書きしたりしません。scannerの検出は内容を確認し、安易に一括除外しません。検出0だけで安全と断定せず、画像・音源の出自と目視確認も行います。監査receiptは公開treeの外へ保存します。

監査で確認した誤検出は3件です。認証環境の拒否テストに使う架空のコンテナパス1件は、ファイルと行全体が一致するときだけ許容します。Gitleaks の2件は録音の保存キーを読み出す Python 式であり、文字列の認証情報ではありません。`.gitleaks.toml` は既定ルールを維持し、該当する2ファイルの完全一致行に限って `generic-api-key` の誤検出を除外します。テスト全体や秘密検出ルール全体を無効にはしません。

## 作成・push・Public化の順序

1. `gh api user --jq .login` で意図する個人アカウントを確認する。会社用アカウントなら停止する。
2. `git log --oneline --all`、`git status --short`、`git remote -v`で、完成ファイルから作った親のない Initial Commit 1件と、未レビューの履歴・remoteがないことを確認する。
3. **作成の承認後**、新規の空のPrivateリポジトリ `yutoo77/listen-capture-app` を作成する。同名が存在する場合は上書きせず所有者へ確認する。GitHub側でREADMEやlicenseを追加しない。
4. **pushの承認後**、新規PrivateのActionsを無効化したことを確認し、本人が確認した公開先URLだけをremoteへ設定して、Initial Commit 1件を`main`へpushする。push前にもHEAD・差分・全ファイルを再照合する。

```sh
git remote add origin https://github.com/yutoo77/listen-capture-app.git
git push -u origin HEAD:main
```

5. push後にリモートmain・全branch/tag・ファイル内容がInitial Commit 1件と一致し、Actionsが無効・新規run未実施であることを確認する。CI定義は保存し、Public化後の再有効化・実行は別の承認と利用条件の確認後に行う。成功・失敗・skipを記録し、利用枠不足があっても課金設定を変更しない。過去のローカル・AWS検証は、新規CI成功へ流用しない。
6. **Public化の承認前**に、GitHub上のREADME・画像・Mermaid・相対/外部リンク、全branch/tag、commitの作者/本文/差分、Actionsログ・artifactを確認する。現CIはartifact uploadを定義せず、cloud認証・image配布もしない。将来artifactを追加する場合はtrace・Cookie・録音・dumpを含めない。
7. ログに予期せぬ秘密値・実データ・内部接続先があればPublic化を止める。値を無効化し、必要な履歴/ログ対処を本人と確認する。ローカルscannerの検出0を、まだ存在しないActionsログの安全確認へ流用しない。
8. **Public化の承認後だけ**Visibilityを変更する。公開後も、そのcommitで完了したCIだけを成功と表記する。非公開の脆弱性報告窓口を有効化する。
9. アプリの一般公開URLとは別の作業であることを明記する。このpushでAWSを起動したりデプロイしたりはしない。

初回pushとPublic化、Public化後のCI実行は別工程です。[Actionsの状況](https://github.com/yutoo77/listen-capture-app/actions)で確認できた結果だけを記録します。公開後の変更もこのリポジトリで行い、非公開ファイルや別の開発履歴を取り込みません。
