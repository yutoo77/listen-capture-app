# Security と利用範囲

この公開ソースは、本人用 Desktop Web アプリの実装を示すものです。公開ソースであることと、インターネット上で誰でも登録できるサービスの運用準備が完了していることは異なります。標準 Compose はローカル開発用です。

## 実装している境界

| 対象 | 対策 | コード |
| --- | --- | --- |
| 認証 | Django Session、パスワード検証、ログイン時を含む CSRF | [auth.py](../backend/capture/auth.py)、[settings.py](../backend/config/settings.py) |
| 認可 | 一覧・詳細・変更・削除・配信で所有者を検査。親の UUID を差し替えても他人の資料を使えない | [views.py](../backend/capture/views.py)、[services.py](../backend/capture/services.py) |
| アカウント切替 | outbox の利用者分離、送信前の Session 再確認、Backend の所有者確認 | [outbox.ts](../frontend/src/outbox.ts)、[App.tsx](../frontend/src/App.tsx) |
| 録音 upload | byte 上限、形式・長さ検査、FFprobe の時間・protocol 制限 | [audio.py](../backend/capture/audio.py) |
| PDF | 原本・ページ上限、時間と資源を制限した別 process で抽出、本文の確認後に確定 | [pdf_sandbox.py](../backend/capture/pdf_sandbox.py)、[pdf_parser.py](../backend/capture/pdf_parser.py) |
| 音声・PDF 配信 | 公開 media URL を作らず、API で所有者確認後に配信。private / no-store、Range 検証 | [storage.py](../backend/capture/storage.py)、[views.py](../backend/capture/views.py) |
| 重複と競合 | UUID receipt、payload digest、DB 一意制約・行ロック、Worker lease | [services.py](../backend/capture/services.py)、[narration.py](../backend/capture/narration.py) |
| 表示 | 利用者の本文・補足を React のテキストとして表示し、任意 HTML を実行しない | [frontend/src](../frontend/src) |

`DEBUG=0` では Secure Cookie・HTTPS redirect 等を有効にします。信頼する reverse proxy と HTTPS、正しい host / origin 設定が前提です。ローカルの `DEBUG=1` を公開環境へ流用しないでください。

## 非公開データとログ

`.env`、秘密鍵、Cookie、録音、PDF、DB dump、Backup は Git へ含めません。公開スクリーンショットと fixture は架空の内容・合成音声だけを使います。依存パッケージやエンジンをダウンロードすることと、利用者の教材を外部へ送ることは別です。

VOICEVOX は管理者が設定した内部接続先だけを使用します。本文が URL の query に入る API があるため、engine / proxy の access log を公開しません。エンジンの管理 API とポートをインターネットへ公開しない構成が必要です。

Polly と S3 の実通信は既定で無効です。使う場合は明示設定、認証情報、費用・教材の送信先の確認が必要です。VOICEVOX から Polly への自動 fallback はありません。文字数・同時 Job・保存枠の制限は、クラウド請求全体の上限を保証するものではありません。

## 現時点の限界

公開準備時の依存監査で、pypdf 6.21.1 に不正な PDF による処理時間増大の既知問題が見つかりました。公開版は修正版の **6.21.2** へ更新しています。[公式リリース](https://github.com/py-pdf/pypdf/releases/tag/6.21.2)を参照してください。scanner の検出ゼロは未知の脆弱性まで否定するものではありません。

- 同梱 NGINX はログインへの IP 単位の制限を worker 間で共有します。一方、Django の throttle は LocMem cache で、複数 process / host 全体の共有制限ではありません。公開サービスには全体の rate limit と総当たり対策の評価が必要です。
- 冪等 receipt は削除済みメモの復活防止にも使いますが、receipt 自体の件数上限・保持方針は未整備です。
- IndexedDB はブラウザの削除・容量制限の影響を受けます。未送信録音の永続保証や端末間同期ではありません。
- ファイル parser の制限は隔離の一部です。依存ソフトの脆弱性がないことを保証せず、継続した更新と監査が必要です。
- 端末に残る録音は、同じ OS / ブラウザ利用者からのアクセスを防ぐ暗号化保管庫ではありません。共有 PC での利用には別の運用が必要です。
- 第三者侵入試験、大規模負荷、一般公開・24 時間運用、継続的 RPO / RTO は検証していません。

公開サービス化する場合は、上記に加えて招待・退会・データ削除、TLS / Secret 管理、監視、Backup の定期取得と復元、費用制御を設計する必要があります。

## 問題を見つけた場合

公開 Issue に実データ、認証情報、Cookie、録音や詳細な攻撃手順を添付しないでください。一般的な不具合は合成データで再現条件を示し、機密を含む Security 報告は公開前に用意する非公開窓口へ送ってください。公開前の監査と残件は [検証記録](verification.md) に区別して記載します。
