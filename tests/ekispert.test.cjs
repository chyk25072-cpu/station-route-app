// 公式仕様のフィールドを使った契約テスト。実APIへの接続テストではない。
const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../ekispert-client.js');
const params={from:'桜上水',to:'笹塚',type:'各駅停車',date:'20261023'};
function response(extra={}){return {ResultSet:{Course:{dataType:'plain',Route:{timeOther:'99',timeWalk:'0',transferCount:'0',Line:{Name:'京王線各停',Type:{text:'train'},timeOnBoard:'6'},Point:[{Station:{Name:'桜上水'}},{Station:{Name:'笹塚'}}],...extra}}}};}
test('乗車時間のみを採用し、待ち時間は加算しない。単体・配列に対応',()=>{
  const request={from:'桜上水',to:'笹塚',lineName:'京王線各停'};
  assert.equal(E.readDuration(response(),request).minutes,6);
  const json=response();json.ResultSet.Course=[json.ResultSet.Course];json.ResultSet.Course[0].Route.Line=[json.ResultSet.Course[0].Route.Line];
  assert.equal(E.readDuration(json,request).minutes,6);
  for(const fields of [{transferCount:'1'},{timeWalk:'2'},{Point:[{Station:{Name:'新宿'}},{Station:{Name:'笹塚'}}]},{Line:{Name:'京王線急行',Type:'train',timeOnBoard:'6'}},{Line:{Name:'京王線各停',Type:'train',timeOnBoard:'-1'}}])assert.equal(E.readDuration(response(fields),request),null);
  assert.throws(()=>E.readDuration({ResultSet:{Error:{Message:'error'}}},request));
});
test('各停・区間急行・急行の分類を混同せず、無印路線を推測しない',()=>{
  assert.equal(E.lineType('京王線各停'),'各駅停車');assert.equal(E.lineType('京王線区間急行'),'区間急行');
  assert.equal(E.lineType('京王線急行'),'急行');assert.equal(E.lineType('京王線'),null);assert.equal(E.lineType('他社線快速'),null);
});
test('railで路線名を取得してからplain探索を固定し、同一取得をキャッシュ',async()=>{
  const requests=[];let now=0;
  const client=E.createClient({config:{functionPath:'/.netlify/functions/ekispert',apiKey:'OLD_KEY_MUST_NOT_BE_SENT'},now:()=>now,fetch:async address=>{
    const url=new URL(address,'https://station-route-app.test');requests.push(url);
    return {ok:true,json:async()=>url.searchParams.get('endpoint')==='rail'?{ResultSet:{max:'1',Line:{Name:'京王線各停',Type:'train'}}}:response()};
  }});
  const [a,b]=await Promise.all([client.getAverageTime(params),client.getAverageTime(params)]);
  assert.equal(a.minutes,6);assert.equal(b.minutes,6);assert.equal(requests.length,2);
  assert.equal(requests[0].searchParams.get('from'),'桜上水');assert.equal(requests[1].searchParams.get('viaList'),'桜上水:笹塚');
  assert.equal(requests[1].searchParams.get('searchType'),'plain');assert.equal(requests[1].searchParams.get('fixedRailList'),'京王線各停');
  assert.ok(requests.every(url=>url.pathname==='/.netlify/functions/ekispert'&&!url.searchParams.has('key')&&!url.href.includes('OLD_KEY_MUST_NOT_BE_SENT')));
  now=300001;await client.getAverageTime(params);assert.equal(requests.length,4);
});
test('空応答・キー未設定・HTTPエラー・通信失敗を処理し、URLやキーをエラーに含めない',async()=>{
  const client=E.createClient({fetch:async()=>({ok:false,status:503,json:async()=>({error:{code:'MISSING_API_KEY',message:'EKISPERT_API_KEY が未設定です'}})})});
  await assert.rejects(client.getAverageTime(params),/未設定/);
  for(const fetcher of [async()=>({ok:false,status:502,json:async()=>({error:{message:'駅すぱあとAPI認証失敗（HTTP 403）'}})}),async()=>{throw Error('https://api.ekispert.jp/?key=TEST_KEY');}]){
    const bad=E.createClient({fetch:fetcher});
    await assert.rejects(bad.getAverageTime(params),error=>!error.message.includes('TEST_KEY')&&!error.message.includes('https://'));
  }
  const empty=E.createClient({fetch:async()=>({ok:true,json:async()=>({ResultSet:{max:'0'}})})});
  assert.equal(await empty.getAverageTime(params),null);
});
test('接続確認はFunctionsへ明示リクエストし、診断の不正応答と未公開404を処理',async()=>{
  const client=E.createClient({fetch:async address=>{
    assert.equal(new URL(address,'https://app.test').searchParams.get('endpoint'),'diagnostics');
    return {ok:true,json:async()=>({ok:true,checks:[{endpoint:'rail',ok:true},{endpoint:'search/course/extreme',ok:true}]})};
  }});
  assert.equal((await client.checkConnection()).ok,true);
  const missing=E.createClient({fetch:async()=>({ok:false,status:404,json:async()=>{throw Error('not JSON');}})});
  await assert.rejects(missing.getAverageTime(params),/Functionが見つかりません/);
  const invalid=E.createClient({fetch:async()=>({ok:true,json:async()=>({ok:true})})});
  await assert.rejects(invalid.checkConnection(),/不正/);
});
