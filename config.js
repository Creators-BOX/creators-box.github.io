// セットアップ後に3つの値を貼る（どれも公開されて問題ない値。APIキーは公開先のドメインとDrive APIだけに制限しておく）
export const CONFIG = {
  // Apps Script を「ウェブアプリ」として公開したときのURL（…/exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbz_SNVEAXTV6sRB38ssbaBh8NaKCwMVOvrk4Rp_M2wDOPMEuLmVjNhlI9XpJMZa6KUh/exec',
  // Google Cloud の「OAuth クライアント ID」（送信ページのログイン用）
  CLIENT_ID: '137254384899-tojcnu59fttvomb00jgmobfudp6oct59.apps.googleusercontent.com',
  // Google Cloud の「APIキー」（受け取りページが暗号化ファイルを読み出す用）
  API_KEY: 'AIzaSyAYOJkWKJU4-07hSn3_6jZFKEgLr_gWNbw',
  // 以下は検証用（通常は触らない）
  DRIVE_BASE: 'https://www.googleapis.com',
  DEV_TOKEN: '',
};
