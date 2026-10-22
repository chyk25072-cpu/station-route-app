// 公開可能な接続設定だけを置く。APIキーはNetlify Functionsの環境変数で管理する。
globalThis.EkispertConfig = {
  functionPath: '/.netlify/functions/ekispert',
  // 下り行先の略称に対して、確認できた正式駅名だけを登録します。
  destinationAliases: {
    'つ':'つつじヶ丘','八':'京王八王子','山':'高尾山口','橋':'橋本','調':'調布',
    '高':'高幡不動','セ':'京王多摩センター','若':'若葉台','尾':'高尾','桜':'桜上水',
    '高八':{terminal:'京王八王子',changesAt:'高幡不動',typeAfter:'各駅停車'},
    'セ橋':{terminal:'橋本',changesAt:'京王多摩センター',typeAfter:'各駅停車'}
  }
};
