// NetlifyのRequest/Response形式でFunctionを直接呼ぶ。実キー・実APIは使用しない。
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const E=require('../ekispert-client.js');
const modulePromise=import(pathToFileURL(path.join(__dirname,'../netlify/functions/ekispert.mjs')).href);
const SECRET='test-private-API-key';
const rail={endpoint:'rail',from:'桜上水',to:'笹塚',date:'20261022',type:'train',offset:'1',limit:'100'};
const course={endpoint:'search/course/extreme',viaList:'桜上水:笹塚',date:'20261022',searchType:'plain',fixedRailList:'京王線各停',answerCount:'20',searchCount:'20'};
const request=(params=rail,method='GET')=>new Request('https://station-route-app.netlify.app/.netlify/functions/ekispert?'+new URLSearchParams(params),{method});
function data(endpoint){
  if(endpoint==='rail')return {ResultSet:{max:'1',Line:{Name:'京王線各停',Type:{text:'train'}}}};
  return {ResultSet:{Course:{dataType:'plain',SerializeData:SECRET,Route:{timeOther:'99',timeWalk:'0',transferCount:'0',Line:{Name:'京王線各停',Type:'train',timeOnBoard:'6'},Point:[{Station:{Name:'桜上水'}},{Station:{Name:'笹塚'}}]}}}};
}
async function handler(options={}){return (await modulePromise).createHandler({getKey:()=>SECRET,...options});}

test('実行時環境変数を読み、キーはFunctionからの上流リクエストだけに付加',async()=>{
  const old=process.env.EKISPERT_API_KEY,urls=[];
  try{
    const h=(await modulePromise).createHandler({fetch:async address=>{
      const url=new URL(address);urls.push(url);assert.equal(url.searchParams.get('key'),SECRET);
      return {ok:true,status:200,json:async()=>data(url.pathname.endsWith('/rail')?'rail':'course')};
    }});
    process.env.EKISPERT_API_KEY=SECRET;
    for(const params of [rail,course]){
      const response=await h(request(params));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      const text=await response.text();assert.ok(!text.includes(SECRET));assert.ok(!text.includes('SerializeData'));assert.ok(!text.includes('key='));
      if(params===course)assert.equal(E.readDuration(JSON.parse(text),{from:'桜上水',to:'笹塚',lineName:'京王線各停'}).minutes,6);
    }
    assert.deepEqual(urls.map(url=>url.pathname),['/v1/json/rail','/v1/json/search/course/extreme']);
  }finally{if(old===undefined)delete process.env.EKISPERT_API_KEY;else process.env.EKISPERT_API_KEY=old;}
});
test('キー未設定は503。上流へ接続せず、環境変数名と対処を返す',async()=>{
  let called=false;const h=await handler({getKey:()=>undefined,fetch:async()=>{called=true;}});
  const response=await h(request()),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.error.code,'MISSING_API_KEY');assert.match(body.error.message,/EKISPERT_API_KEY/);assert.equal(called,false);
});
test('用途外のAPI・パラメータ・キーの持込・重複・不正日付・メソッドを拒否',async()=>{
  let count=0;const h=await handler({fetch:async()=>{count++;}});
  for(const params of [{...rail,endpoint:'https://evil.test/'},{...rail,key:'client-key'},{...rail,url:'https://evil.test/'},{...rail,date:'20260230'},{...rail,from:'東京'},
    {...rail,limit:'10000'},{...course,searchType:'departure'},{...course,viaList:'桜上水:笹塚:新宿'},{...course,fixedRailList:'京王線:他社線'}])assert.equal((await h(request(params))).status,400);
  const duplicate=request();const duplicateURL=new URL(duplicate.url);duplicateURL.searchParams.append('endpoint','rail');
  assert.equal((await h(new Request(duplicateURL))).status,400);
  const post=await h(request(rail,'POST'));assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');assert.equal(count,0);
});
test('HTTP403は認証失敗として区別し、ドメイン制限の原因を断定しない',async()=>{
  const h=await handler({fetch:async()=>({ok:false,status:403,json:async()=>({error:SECRET})})});
  const response=await h(request()),body=await response.json();assert.equal(response.status,502);
  assert.equal(body.error.code,'UPSTREAM_AUTH_FAILED');assert.equal(body.error.upstreamStatus,403);
  assert.match(body.error.message,/キー・契約/);assert.match(body.error.message,/登録ドメイン制限/);assert.ok(!JSON.stringify(body).includes(SECRET));
});
test('通信失敗・API内部エラー・不正JSON・タイムアウトから秘密を返さない',async()=>{
  for(const [fetch,code,status]of [
    [async()=>{throw Error('https://api.ekispert.jp/?key='+SECRET);},'UPSTREAM_UNAVAILABLE',502],
    [async()=>{throw {code:'fake',status:502,message:SECRET};},'UPSTREAM_UNAVAILABLE',502],
    [async()=>({ok:true,status:200,json:async()=>({ResultSet:{Error:{Message:SECRET}}})}),'UPSTREAM_API_ERROR',502],
    [async()=>({ok:true,status:200,json:async()=>{throw Error(SECRET);}}),'INVALID_UPSTREAM_RESPONSE',502],
    [async(address,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error(SECRET)),{once:true})),'UPSTREAM_TIMEOUT',504]
  ]){
    const h=await handler({fetch,timeoutMs:5}),response=await h(request()),body=await response.json();
    assert.equal(response.status,status);assert.equal(body.error.code,code);assert.ok(!JSON.stringify(body).includes(SECRET));
  }
});
test('上流成功応答も必要項目だけに絞り、秘密値のエコーを除去',async()=>{
  const h=await handler({fetch:async()=>({ok:true,status:200,json:async()=>({ResultSet:{key:SECRET,RequestUrl:'?key='+SECRET,max:'1',Line:{Name:SECRET,Type:'train',key:SECRET}}})})});
  const response=await h(request()),text=await response.text();assert.equal(response.status,200);assert.ok(!text.includes(SECRET));assert.match(text,/redacted/);assert.ok(!text.includes('RequestUrl'));
});
test('接続診断が両APIを実際に呼び、JSTの日付・個別の認証結果を安全に返す',async()=>{
  const urls=[];const h=await handler({now:()=>new Date('2026-10-21T16:30:00Z'),fetch:async(address,options)=>{
    const url=new URL(address);urls.push(url);assert.equal(url.searchParams.get('key'),SECRET);assert.equal(url.searchParams.get('date'),'20261022');
    assert.equal(options.redirect,'error');assert.equal(options.headers.Referer,undefined);assert.equal(options.headers.Origin,undefined);
    return url.pathname.endsWith('/rail')?{ok:true,status:200,json:async()=>data('rail')}:{ok:false,status:403};
  }});
  const response=await h(request({endpoint:'diagnostics'})),body=await response.json();assert.equal(response.status,200);assert.equal(body.ok,false);assert.equal(urls.length,2);
  assert.equal(body.checks[0].ok,true);assert.equal(body.checks[1].code,'UPSTREAM_AUTH_FAILED');assert.equal(body.checks[1].upstreamStatus,403);assert.ok(!JSON.stringify(body).includes(SECRET));
});
test('ブラウザ→Function→上流の全経路で到着予測用の時間を維持',async()=>{
  const h=await handler({fetch:async address=>{const url=new URL(address);return {ok:true,status:200,json:async()=>data(url.pathname.endsWith('/rail')?'rail':'course')};}});
  const client=E.createClient({fetch:address=>{assert.ok(!address.includes(SECRET));return h(new Request(new URL(address,'https://station-route-app.netlify.app')));}});
  const result=await client.getAverageTime({from:'桜上水',to:'笹塚',type:'各駅停車',date:'20261022'});assert.equal(result.minutes,6);
  assert.equal((await client.checkConnection()).ok,true);
});
