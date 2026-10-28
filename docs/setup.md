# ローカルで試す

このリポジトリだけでDesktop版を起動できます。AWSアカウント、Private版の履歴、以前のDBは必要ありません。最初は同梱デモで「再生 → 録音 → 保存 → 元位置へ戻る」を試します。任意本文の読み上げは、後述のVOICEVOXを起動した場合に利用できます。

## 1. Docker Composeで起動する

必要なもの：Docker Engine / Docker DesktopとCompose v2、Python 3.12以上（設定生成用）、PCのChrome / Edge。DockerはLinuxコンテナを使います。マイクはブラウザへ許可してください。

```sh
python scripts/setup-env.py
docker compose -p listen-capture-portfolio up --build -d --wait
docker compose -p listen-capture-portfolio exec backend python manage.py create_account learner
```

`learner`は好きなユーザー名に置き換えられます。最後のコマンドでパスワードを対話入力します。固定の初期パスワードはありません。`setup-env.py`はランダムなSecret・DBパスワードを`.env`へ作り、既存ファイルを上書きしません。設定内容をGitへ追加しないでください。

APIとWorkerは同じイメージを使います。ビルドは`backend`だけが行い、Workerは完成したイメージを利用します。2026-10-27のクリーン起動で、複数サービスが同じタグを並列ビルドする衝突を確認したため、この構成に修正しました。初回は上記の`up --build`で全体を起動してください。

[http://127.0.0.1:8080](http://127.0.0.1:8080)を開いてログインします。このポートはこのPCのloopback限定です。localhostはマイクを利用できる開発用の安全なコンテキストですが、別のPC・スマホへ公開するためのHTTPS構成ではありません。

1. 「デモ音声で試す」を選ぶ。デモは入力した本文の読み上げではありません。
2. 再生し、「メモする」で5秒ほど録音する。
3. 録音を終了し、サーバー保存の表示を確認する。
4. 録音を聴き直して教材を再開する。
5. 再読み込み後、「声のメモ」から録音を再生し、元位置へ戻る。

通常の停止：

```sh
docker compose -p listen-capture-portfolio stop
```

再開は同じ`up`コマンドです。DBと音声は専用のnamed volumeに残ります。`down --volumes`は保存データを削除するため、通常の終了には使いません。Private版と同時に動かす場合は、8080の衝突を避けて公開候補側のwebのloopback portと、`.env`の`CSRF_TRUSTED_ORIGINS`を同じportに変更して再起動してください。同じproject名・volumeを流用しないでください。

## 2. 任意本文をVOICEVOXで読む（任意）

CPU版VOICEVOX 0.25.2の公式imageをdigest固定で取得します。初回ダウンロードと初期化に時間・ディスク容量が必要です。engineは最大1 CPU・1800 MiBに制限し、アプリやDBにも別途メモリが必要です。4 GiB全体で快適に動くという保証はありません。linux/amd64対象のため、ARM環境ではエミュレーション性能を別途確認してください。

使用する音声ライブラリの利用条件・クレジットは[第三者ソフトウェアと音声](../THIRD_PARTY_NOTICES.md)で確認してください。engineや音声モデルをこのリポジトリに再配布しません。

```sh
docker compose -p listen-capture-portfolio -f compose.yaml -f compose.voicevox.yaml --profile voicevox up --build -d --wait
```

既に通常構成を起動していた場合、Backendの作り直しで変わった内部IPをWeb proxyが引き直すよう、次も実行します。

```sh
docker compose -p listen-capture-portfolio -f compose.yaml -f compose.voicevox.yaml --profile voicevox restart web
```

画面の「声・高さ」で選び、「音声を生成」を押します。新しい声は別の音声版になり、過去の録音は元の音声版へ戻ります。生成中断は処理中の一区間の完了を待つ方式です。即時にCPU処理を中断するものではありません。

engineのポートは外へ公開せず、内部networkからだけ接続します。変更系APIと本文を含むaccess logを無効化しています。PollyはOFFのままで、自動fallbackもしません。

終了時は同じComposeファイルを指定します。

```sh
docker compose -p listen-capture-portfolio -f compose.yaml -f compose.voicevox.yaml --profile voicevox stop
```

## 3. 自動テスト

CIはFrontendとBackend/Browserの2ジョブです。Private履歴やAWS認証は不要です。実マイク・実VOICEVOX・長時間fixtureの一部は明示opt-inで、通常のCI合格から実機成功は主張しません。

Frontend（Node.js 24）：

```sh
npm ci --prefix frontend
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run typecheck --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

Backend（Compose起動後、実PostgreSQL 17）：

```sh
docker compose -p listen-capture-portfolio exec backend python manage.py makemigrations --check --dry-run
docker compose -p listen-capture-portfolio exec backend python manage.py test capture --noinput
```

Browser E2Eと独立復元はCIの[実行手順](../.github/workflows/ci.yml)を参照してください。手元でnative実行する場合はPython 3.12、Node 24、PostgreSQL 17、同じmajorの`pg_dump` / `pg_restore`、FFmpeg / FFprobeを準備します。復元・role検証にはDBとroleの作成・権限設定ができるbootstrap roleを使うため、**専用の検証クラスタ**を用意します。この権限を本番アプリへ与えず、Private版や本番DBへ接続しないでください。`POSTGRES_*`と`PG_BIN`で専用環境を指定します。

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate / macOS・Linux: source .venv/bin/activate
pip install -r backend/requirements.lock
npm ci
npm ci --prefix frontend
npx playwright install chromium
# まだ.envがない場合のみ。既存.envは上書きしません。
python scripts/setup-env.py
# .envのPOSTGRES_*を専用テスト環境に合わせる
python scripts/manage.py test capture --noinput
python scripts/e2e-local.py
python scripts/recovery-drill.py --confirm-disposable
python scripts/database-role-drill.py --confirm-disposable
```

LinuxでChromiumのOS依存ライブラリが未導入の場合は、`npx playwright install --with-deps chromium`を使います。システムパッケージを導入するため、管理者権限が必要になる場合があります。Windowsでは上記の`npx playwright install chromium`を使います。

`e2e-local.py`は新しいDB・media・loopbackサーバーを作り、終了時に自分が作ったDBだけを削除します。通常E2Eは合成マイクと明示された人工音声を使います。復元試験は新しいDB・mediaを使い、元DBへ上書きしません。結果・秘密値・音声・dumpは`.local/`へ残るので公開しないでください。`recovery-drill.py`にはsource記録用のGit commitが必要です。

## 起動で困ったら

- **8080が使用中**：別の起動済みアプリを確認し、この候補のportを変更する。`.env`の`CSRF_TRUSTED_ORIGINS`も同じportへ合わせて再起動する。既存プロセスを一括停止しない。
- **録音できない**：localhostで開いているか、ブラウザのマイク許可と画面の入力マイクを確認する。
- **保存失敗**：タブを閉じず、端末に残っている録音から再送する。端末内保存は消去・容量不足により失われ得る。
- **任意本文の音声化ができない**：デモだけの通常構成では正常。VOICEVOX overlayの起動とhealthを確認する。
- **VOICEVOXが遅い**：CPU生成は長い本文ほど待つ。短い本文から試し、生成済み音声は再生成せず再生する。

これはPC向けローカル再現手順です。公開URL、継続運用、AWS環境の再構築まで自動実行する手順ではありません。

## 短い本人確認

自動試験の合成マイクと、実マイク・聴感は別に確認します。VOICEVOXで生成済みの教材を選び、次だけを試します。

- [ ] ▶で10秒聴き、日本語の声を確認する。
- [ ] マイクを許可し、「入力マイク」で実機を明示選択する。
- [ ] 再生中に「メモする」→5秒話す→録音終了。教材停止と録音中の入力名を確認する。
- [ ] 「サーバー保存済み」後に自分の声を聴き、教材を再開する。
- [ ] 再読み込み後、「声のメモ」から試聴し、元の位置へ戻る。

失敗時は、操作順・表示された文・教材の位置を残します。保存未確認の録音がある間はタブを閉じず、再送またはダウンロードで保全します。本人録音を作った検証環境も、通常の`stop`で終了してvolumeを残してください。
