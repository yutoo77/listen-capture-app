# 検証結果と保証範囲

実装、テストコード、テストの成功、本人の実機確認は別の証拠です。ローカル Docker、非公開 AWS、native 自動試験、本人の短い操作確認を分けて記録します。

以下は記載した日付・実行環境で得た結果です。新しい Initial Commit 上で全試験を再実行した結果ではありません。検証したコードと同梱コードの対応は、機械可読記録に列挙したファイルと SHA-256 で確認します。新規リポジトリ移行後のCIは[GitHub Actionsの実行状況](https://github.com/yutoo77/listen-capture-app/actions)で確認し、過去の検証結果と区別します。

## 1. 公開候補の Docker・実音声確認

確認日：2026-10-27。別のクリーンな環境で、同梱するアプリケーションの Docker 構成と中心操作を確認しました。検証対象144ファイルの build-input SHA-256 は `72150a3e70dc9138dc8f2ae19e42c83eb9d0e19c84036a094430570635958550`。対象一覧と算出方法は [Docker 受入記録](evidence/docker-acceptance.json) にあります。文書と Git 履歴の整理後も、この入力内容は変更していません。

公開候補のソースから別のクリーンな clone を作り、WSL Ubuntu の新しい専用 Docker daemon・Compose project・DB・media volume を使用しました。元の作業フォルダ、既存のアプリ用 DB・volume・仮想環境・未公開実装をアプリの起動に使っていません。ブラウザ側も別 clone で `npm ci` と Chromium の新規インストールを行っています。

| 確認 | 結果と範囲 |
| --- | --- |
| README の通常構成 | Docker 29 / Compose 5 で build・起動。Web、API、PostgreSQL、音声・PDF・Narration の各 Worker の接続を確認 |
| デモと実 PDF | 同梱確認音の認証付き取得・decode・再生、PDF のページ選択・worker 抽出・日本語修正・確定・再読込・原本 SHA・所有者限定配信、確定再送、画像だけの PDF の拒否を確認 |
| VOICEVOX overlay | 公式 CPU 0.25.2 の固定 digest を使用。7 services 起動・health、内部接続・非公開 engine port、Polly / fixture 無効を確認 |
| 実音声の生成 | 自作の日本語教材 370 字、2 区間、話者14・高さ `0.03`。`VOICEVOX:冥鳴ひまり` の profile / credit を保存。完成音声は 64.619 秒 |
| 生成中断 | 実行中に要求し、現在の区間完了後に `user_cancelled`。1 / 2 区間を保存。クリックから中断確定まで **68.848 秒** |
| 明示再開 | 同じ Job / profile を再開して 2 / 2 区間が完成。保存済み区間の attempt count は 1 のまま、残りの区間も attempt count 1 |
| UUID / profile | 同 UUID・同 profile の再送は 200 で同じ Job。異なる profile の指定は 409 |
| 実ブラウザ・合成マイク | 実音声 decode / 再生、Fake Audio Input の明示選択、教材停止、録音保存201、即時試聴、教材再開、再読み込み後の録音試聴・元位置復帰を確認。位置差は150 ms未満、page error 0 |
| 所有者認可 | 今回作った音声と録音で、匿名は403・別所有者は404 |
| 本人の短い確認 | 本人が「音声が聴こえた」「実マイクで録音し自分の声を試聴できた」「F5後も録音が残り、試聴と元位置復帰ができた」と回答。機種名は収集していない |
| 終了 | 全 writer / container を停止。volume を保持し、本人録音を含む DB / media を非公開領域へ退避。今回の世代を独立復元した結果ではない |

中断は実行中の一区間が終わるまで待つ方式です。68.848 秒は、この CPU 制限下で行った当回の測定で、一般的な生成性能や最大待ち時間の保証ではありません。即時停止とは扱いません。

保存済み区間は再開前に実ファイルの SHA-256 と DB の digest の一致を確認しました。完成後は一時 PCM を片付ける仕様のため、再利用は再開前の SHA、同じ Job / profile、区間の attempt count と完了状態で確認します。完成後の一時 PCM の hash 比較は `not_applicable` で、失敗や欠落と扱っていません。

生成したキャラクター音声、合成録音、本人の声、DB、Cookie、trace を公開物に追加していません。掲載画像は、公開整理時に取得した架空教材・合成マイクの3枚を維持しています。本人の回答を、全機器・全障害系・長時間利用の成功や、発音の網羅的な確認・音質の定量評価へ広げません。

表は所定の確認を完了した実行の結果です。失敗・未完了の補助実行は成功件数へ加えず、機械可読記録で区別しています。詳細な開発履歴や運用ログは、この公開リポジトリの配布対象に含めません。

## 2. Native 自動試験

確認日：2026-10-27。実データ・既存DBを使わない独立環境で実行しました。**この試験では Docker 実起動を行っていません**。上記の Docker 確認とは別の実行です。Backend・Frontend・記録した試験コードと補助ツールの対応は、[native 試験記録](evidence/validation.json)の対象ファイル・SHA-256で確認できます。

| 検証 | 結果 | 対象 |
| --- | --- | --- |
| Frontend lint / format / TypeScript / build | 成功 | Backend / Frontend の対象コード |
| Frontend unit tests | 168 成功 / 11 files | 音声操作・outbox・再生位置・生成依頼など |
| Backend lint / format | 成功 / 105 Python files | Migration の未反映差分なし |
| Backend tests | 284 成功・1 skip / 285 件 | 実 PostgreSQL 17.11、pypdf 6.21.2。skip は Windows 実音声の任意試験 |
| Browser E2E | 72 成功・5 skip / 77 件 | Chromium、合成マイク・生成 fixture。実マイク・実 engine 等の opt-in は通常試験から除外 |
| 更新後 PDF E2E | 11 成功・skip なし | pypdf 6.21.2 で import / draft / page selection を追試 |
| Backup / Restore | 成功 | 合成11 media / 4 memos を独立 PG17へ復元。別所有者26・匿名17操作拒否、UUID・版・profile・SHA・Range確認 |
| 制限 DB role | 成功 | 禁止操作10件拒否、runtime CRUD と制限 role での復元 |
| 補助スクリプト unit | Python22・Node5 成功 | Backup 整合性・role・E2E account 等 |
| 依存脆弱性 scanner | 検出0 | npm audit / pip-audit（固定 lock）。未知の脆弱性は保証しない |

実行環境は Windows、Python 3.12、Node.js 24、PostgreSQL 17.11、FFmpeg 9.0.2。通常の全 Browser suite は依存更新前の環境で行い、更新後の pypdf 6.21.2 では Backend 全件と PDF 関連 Browser11件を追試しました。二つの実行の重複ケースを合算しません。

PDF 本文抽出は pypdf 6.21.2 と別 process で行います。OCR は実装せず、原文と読み順の利用者確認が必要です。依存 scanner の結果は固定 lock に対する当日の確認で、将来の脆弱性がないという保証ではありません。

完了を確認できない実行は上表へ採用していません。Backend 補助実行の終了コード1・詳細未回収と、更新前の依存 scanner 検出3件は、成功・検出0と混同しない別の記録です。

## 3. 公開候補の非公開 AWS 確認

確認日：2026-10-28。同梱アプリケーションの Backend / Web image を、既存の非公開 AWS 環境へ配置しました。144 のアプリ build input のダイジェストはローカル確認時と同じ `72150a3e70dc9138dc8f2ae19e42c83eb9d0e19c84036a094430570635958550`。Secret・制限 DB role・保存先・SSM / TLS は外部の非公開運用設定で与え、未公開アプリコードは image へ混ぜていません。

| 確認 | 結果と範囲 |
| --- | --- |
| 配置・Schema | 既存の非公開 EC2 へ固定 image を配置。API・Web・DB・Worker・実 VOICEVOX の接続を確認。0010 / 0011 は適用済みで、pending Migration なし・今回の新規適用0件 |
| HTTPS・Session・CSRF | 通常の証明書検証を維持。実ブラウザのログイン、Secure / HttpOnly Cookie、CSRF 欠落403を確認 |
| 実音声 | 自作教材370字・2区間、話者14・高さ `0.03`、`VOICEVOX:冥鳴ひまり`。完成音声64.619秒を decode・再生。Polly / fixture は無効 |
| 中断・明示再開 | 1 / 2区間を残して中断し、同 Job を明示再開して完成。今回の中断確定待ちは **40.541秒**。測定値であり、即時停止や最大待ち時間の保証ではない |
| UUID / profile | 正しい HTTPS Origin / Referer・CSRF を備えた同 UUID の再送は200で同 Job、異なる profile は409。継続確認で音声を再生成していない |
| 合成マイク | 入力選択、教材停止、録音保存201、試聴、教材再開、再読込後の試聴・元位置復帰を確認。位置差150 ms未満、page error 0 |
| 非公開 media | 匿名403・別所有者404。今回の AWS 試験は実 engine + 合成マイクであり、本人の実マイク・聴感成功へ読み替えない |
| 更新前・更新後 Backup | writer 停止下の DB / media 対を別世代で取得し、暗号化して独立保管先へ退避・復号照合。元 DB / media へ上書きしない |
| 独立復元 | 新しいローカル PG17・別 media へ実復元。PREは44 media・33音声decode・11 PCM、POSTは46 media・35音声decode・11 PCMを検証 |
| 復元後の認可・receipt | PREは所有者許可 / 他所有者拒否 / 匿名拒否を各62操作、POSTは各67操作。receipt はPRE10件 / digest一致8件、POST11件 / digest一致9件。過去形式の2件はdigest再構成不能としてskipを保持 |
| 旧データ保全 | 本文版・音声版・録音・receipt等の対象7 tableでPRE由来の旧行を保全。各復元先の認可等の確認前後に28 tableのsnapshot不変、0011関連のsource projection一致を確認 |
| 終了処理 | writer・全container停止とsync後、当回の終了guardへ引継ぎ、Stopを1回実行。独立した読み取りでstoppedを確認。起動枠から停止確認まで約62.2分で、承認上限120分以内。本人側の一時CA削除、新しい復元用PG停止も確認 |

ローカルでの中断68.848秒（2026-10-27）とAWSでの40.541秒（2026-10-28）は異なる実行の測定です。性能比較・SLAとして一般化しません。本人の聴感・実マイク確認は第1節のローカル確認だけです。

完了した確認だけを成功として記録しています。証明書・接続・補助要求などで未完了となった実行は成功へ合算していません。中断後の確認は同じ生成済み音声を使って継続し、音声を再生成していません。HTTPS の Origin / Referer が欠ける要求の403は、保護を緩めて回避していません。

復元先の認可確認は認証状態を明示した試験で、Session / CSRF / TLS・UUIDのHTTP再送は別の実 AWS ブラウザで確認しています。独立したローカルPGへの復元を、別 AWS host の完全再構築、任意の過去 S3 versionからの復元、継続運用のRPO / RTO実証とは扱いません。録音、教材の実データ、DB、画像、Cookie、Secret、内部運用識別子は公開物へ追加していません。

## 4. この受け入れとは別の確認範囲

以下は元の Desktop v1 の非公開検証記録に基づく概要です。**今回の公開候補を AWS へ再配置した結果ではありません**。実録音・DB dump・内部接続先は公開物へ含めていません。

| 証拠 | 確認した範囲 | 限界 |
| --- | --- | --- |
| 原本の非公開 AWS 配置 | Migration、実 VOICEVOX / Polly 生成、認証付き音声配信、限定した API / ブラウザ操作 | 一般公開・常時運用・多数同時利用の実績ではない |
| 原本の本人 Desktop 操作 | 再生、マイク選択、録音・保存・試聴、再読込・元位置復帰、声と高さ、生成中断・再開 | 30〜60分連続利用・全障害系の本人確認は未実施 |
| 原本の暗号化 Backup / 独立復元 | writer 停止下の DB / media 対、外部退避と読み戻し、別 PG17 / media、所有者・版・位置・receipt 保持 | 別 AWS host 完全再構築・任意の過去 S3 version・継続 RPO / RTO は未実証 |

## 5. 検証入口

| 問題 | 代表的な検証入口 |
| --- | --- |
| 別所有者の UUID を指定したアクセス | [test_api.py](../backend/capture/tests/test_api.py)、[test_context.py](../backend/capture/tests/test_context.py) |
| 応答喪失・同 UUID の再送・同時保存 | [test_services.py](../backend/capture/tests/test_services.py)、[product-memo-response.spec.ts](../tests/e2e/product-memo-response.spec.ts) |
| アカウント変更時の誤送信 | [outbox.test.ts](../frontend/src/outbox.test.ts)、[product-reliability.spec.ts](../tests/e2e/product-reliability.spec.ts) |
| 古い本文・声・位置の保持 | [test_voicevox_migrations.py](../backend/capture/tests/test_voicevox_migrations.py)、[context-navigation.spec.ts](../tests/e2e/context-navigation.spec.ts) |
| 中断・再開、lease 切れ、遅い旧 Worker | [test_narration_cancel.py](../backend/capture/tests/test_narration_cancel.py) |
| Backup のファイル欠落・不整合 | [test_backup_integrity.py](../scripts/test_backup_integrity.py) |

コマンドと前提は [セットアップ](setup.md)、公開ファイル・履歴・画像・リンクの再監査は [公開前レビュー](publication.md) を参照してください。機械可読の記録は [Docker 受入](evidence/docker-acceptance.json)、[AWS 受入](evidence/aws-acceptance.json)、[native 試験](evidence/validation.json)を分けています。秘密値・個人データ・ブラウザ trace は含めません。文書と公開監査スクリプトの後続更新ではアプリのビルド入力が変わっていないことを、ダイジェストで照合します。

## 6. 未実施・対象外

- 公開候補の AWS 配置・HTTPS は上記の日付と対象で確認しました。受け入れ記録の作成時点では新規 GitHub Actions は未実施でした。移行後のCIと、リモートログ・成果物の公開監査は別工程です。CI 定義があることを CI 成功とは表記しません。
- スマートフォン正式対応、画面ロック、AirPods のボタン操作、一般公開サービス、24時間運用、大規模負荷・第三者侵入試験は対象外です。狭い画面の試験を iPhone 実機成功へ読み替えません。
- 保存枠・文字数・Job 制限は、任意教材の音声容量や全クラウド費用を保証しません。
