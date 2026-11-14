# 第三者のライセンスと音声の利用条件

アプリ本体の [MIT License](LICENSE) と、下記のソフトウェア・音声の条件は別です。このリポジトリは依存パッケージ、VOICEVOX のエンジンやモデル、生成済みのキャラクター音声を同梱しません。依存は lockfile、エンジンは公式の配布先から取得します。

## 主な依存

| 依存 | ライセンス・公式の確認先 |
| --- | --- |
| React / React DOM | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| TypeScript | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| Vite | [MIT](https://github.com/vitejs/vite/blob/main/LICENSE) |
| Django | [BSD-3-Clause](https://github.com/django/django/blob/main/LICENSE) |
| Django REST Framework | [BSD](https://github.com/encode/django-rest-framework/blob/master/LICENSE.md) |
| Psycopg | [LGPL-3.0 with the project's exceptions](https://github.com/psycopg/psycopg/blob/master/LICENSE.txt) |
| boto3 | [Apache-2.0](https://github.com/boto/boto3/blob/develop/LICENSE) |
| pypdf | [BSD-3-Clause](https://github.com/py-pdf/pypdf/blob/main/LICENSE) |
| PostgreSQL | [PostgreSQL License](https://www.postgresql.org/about/licence/) |
| NGINX | [BSD-2-Clause](https://nginx.org/LICENSE) |
| FFmpeg | [構成によって LGPL / GPL](https://ffmpeg.org/legal.html) |
| Playwright | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |
| Vitest | [MIT](https://github.com/vitest-dev/vitest/blob/main/LICENSE) |

これは主要依存の索引です。全ての推移依存・OS パッケージのライセンス本文を集約したものではありません。正確なバージョンは `frontend/package-lock.json`、ルートの `package-lock.json`、`backend/requirements.lock` に固定しています。生成した bundle やコンテナを再配布する場合は、その中に含まれるパッケージのライセンス・notice・ソース提供義務を別途確認してください。

## VOICEVOX

- エンジンのソースコードは [LGPL v3 / 別契約のデュアルライセンス](https://github.com/VOICEVOX/voicevox_engine/blob/0.25.2/LICENSE) です。
- 配布エンジンと音声ライブラリには [エンジン利用規約](https://github.com/VOICEVOX/voicevox_resource/blob/0.25.2/engine/README.md) と各話者の条件があります。ソースコードのライセンスだけで音声利用を判断しません。
- [VOICEVOX の利用規約](https://voicevox.hiroshiba.jp/term/)に従い、生成音声の利用時にクレジットと各音声ライブラリの条件を確認してください。
- 開発で使用した話者は **VOICEVOX:冥鳴ひまり**、**VOICEVOX:ずんだもん**。条件は [冥鳴ひまり](https://www.meimeihimari.com/terms-of-use)、[ずんだもん等の音源利用規約](https://www.zunko.jp/con_ongen_kiyaku.html)を参照してください。
- アプリは音声版に話者・エンジン版・高さ・クレジットを保存し、画面へ表示します。他の話者を選ぶ場合、その話者の条件を利用者が確認してください。全話者の条件を監査済みとはしていません。

上記の VOICEVOX 公式条件は 2026-10-27 に確認しました。キャラクター画像・ロゴ・モデル・第三者の音声素材は、このリポジトリの配布対象に含めません。

## デモと登録データ

`backend/demo/sample.mp3` は `scripts/build-demo.py` で再生成できる人工の確認音です。TTS を使わず、音声再生・録音操作の確認用として同梱します。本文の読み上げを行った音源ではありません。

教材を登録する場合は、その教材を扱う権利を確認してください。利用者の教材、本人の録音、AWS の実データ、Private 版の旧デモ音声は公開版に含めません。
