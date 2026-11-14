import { Icon } from "./Icons";

export default function HelpPanel() {
  return (
    <section className="help-panel panel" aria-labelledby="help-heading">
      <header className="help-heading">
        <h2 id="help-heading" tabIndex={-1}>
          使い方
        </h2>
      </header>
      <ol className="help-steps">
        <li className="help-step">
          <span className="help-step-icon">
            <Icon name="library" size={24} />
          </span>
          <div>
            <h3>
              <span aria-hidden="true">1</span> 資料を追加
            </h3>
            <p>テキスト / PDF</p>
          </div>
        </li>
        <li className="help-step">
          <span className="help-step-icon">
            <Icon name="mic" size={24} />
          </span>
          <div>
            <h3>
              <span aria-hidden="true">2</span> 聴く・録音する
            </h3>
            <p>再生 → メモする → 録音を終了</p>
          </div>
        </li>
        <li className="help-step">
          <span className="help-step-icon">
            <Icon name="note" size={24} />
          </span>
          <div>
            <h3>
              <span aria-hidden="true">3</span> メモを確認
            </h3>
            <p>録音を再生 · 元の位置へ戻る</p>
          </div>
        </li>
      </ol>
      <div className="help-details">
        <h2>詳しい使い方</h2>
        <details>
          <summary>録音や保存がうまくいかないとき</summary>
          <div>
            <p>
              マイクを使えない場合は、ブラウザのマイク許可と接続中の機器を確認してください。録音にはHTTPSの接続が必要です。「入力マイク」を選び、録音中の入力名を確認できます。音量表示は入力の目安です。
            </p>
            <p>
              「録音を終了しています…」の間は、最後の音声を受け取っています。タブを閉じずに待ってください。終了待ちの録音を明示的に破棄すると、元に戻せません。
            </p>
            <p>
              サーバー保存が未確認の録音は、そのまま残して「保存を再試行」を押します。同じ録音として確認するため、新しく録り直す必要はありません。必要なら録音をダウンロードできます。
            </p>
            <p>
              ログインし直す案内が出たら、このタブを残して元のアカウントで別タブにログインし、戻って明示的に再試行してください。
            </p>
          </div>
        </details>
        <details>
          <summary>「端末内」と「サーバー保存済み」の違い</summary>
          <div>
            <p>
              「サーバー保存済み」と表示された録音は、同じアカウントでログインして聴き直せます。保存結果が未確認の場合、サーバーに届いている可能性もあります。
            </p>
            <p>
              端末内の一時保存はバックアップではありません。ブラウザの保存領域が消去されると失われます。「このタブ内のみ」と表示された録音は、タブを閉じる前に再送するかダウンロードしてください。
            </p>
            <p>
              補足の文章も、保存状態を確認してから画面を閉じてください。別のアカウントでは、元のアカウントの未送信録音を再送できません。
            </p>
          </div>
        </details>
        <details>
          <summary>読み上げ音声・音声生成について</summary>
          <div>
            <p>
              音声生成を利用できるかどうかは、現在の設定によります。テスト用の人工音声や無音音声は、本文を読み上げた結果ではありません。
            </p>
            <p>
              生成の受付結果が分からないときは「同じ依頼を確認」を使います。新しい依頼を繰り返すと、設定によっては追加の生成費用が発生します。再生成前に表示される注意を確認してください。
            </p>
            <p>
              自動再開をブラウザが許可しない場合は、再生ボタンで教材を再開できます。本文の強調は区間単位で、単語ごとの同期ではありません。
            </p>
          </div>
        </details>
        <details>
          <summary>PDFを取り込むとき</summary>
          <div>
            <p>
              文字情報のあるPDFに対応しています。画像だけのPDFや、パスワード付きPDFには対応していません。
            </p>
            <p>
              段組み・脚注・表・数式は読み順や内容が変わる場合があります。抽出した本文を原本と照らし、修正してから確定してください。
            </p>
            <p>
              音声メモは、録音時の本文と音声の版に紐づきます。PDF原本だけの削除と、資料・録音全体の削除は別の操作です。
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
