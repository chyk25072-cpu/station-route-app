// jsdomでHTML・イベント・localStorageを統合検証。実ブラウザの描画検証ではない。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const C=require('../railway-core.js');
process.env.TZ='Asia/Tokyo';
const root=path.join(__dirname,'..');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function app(saved=null,{apiEnabled=false,failStatus=0,bareRails=false,stopCountDelta=0,nowAt='2026-10-19T18:00:00+09:00'}={}) {
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://station-route-app.test',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, intervals=[],errors=[];let now=new Date(nowAt).getTime(),hidden=false,blob;
  const ActualDate=w.Date;w.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  w.setInterval=callback=>{intervals.push(callback);return intervals.length;};
  w.confirm=()=>true;
  w.URL.createObjectURL=value=>{blob=value;return 'blob:test';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){};
  w.addEventListener('error',event=>errors.push(event.error||event.message));
  Object.defineProperty(w.document,'hidden',{get:()=>hidden});
  if(saved)w.localStorage.setItem(C.KEY,saved);
  w.localStorage.setItem('old-walking-key','preserved');
  const requests=[];
  w.fetch=async address=>{
    const url=new URL(address,'https://station-route-app.test');requests.push(url);
    if(!apiEnabled)return {ok:false,status:503,json:async()=>({error:{code:'MISSING_API_KEY',message:'Netlify Functionsに EKISPERT_API_KEY が未設定です。'}})};
    if(failStatus)return {ok:false,status:502,json:async()=>({error:{code:'UPSTREAM_AUTH_FAILED',message:'駅すぱあとAPIの認証に失敗しました（HTTP '+failStatus+'）。登録ドメイン制限を確認してください。'}})};
    if(url.searchParams.get('endpoint')==='diagnostics')return {ok:true,json:async()=>({ok:true,checkedAt:'2026-10-22T00:00:00Z',checks:[{endpoint:'rail',ok:true,upstreamStatus:200},{endpoint:'search/course/extreme',ok:true,upstreamStatus:200}]})};
    const types=['各駅停車','快速','区間急行','急行','特急'];
    const listedTypes=bareRails==='only-local'?['各駅停車']:types;
    if(url.searchParams.get('endpoint')==='rail')return {ok:true,json:async()=>({ResultSet:{max:String(listedTypes.length),Line:listedTypes.map(type=>({Name:bareRails&&type==='各駅停車'?'京王線':'京王線'+type,Type:'train'}))}})};
    const [from,to]=url.searchParams.get('viaList').split(':'),name=url.searchParams.get('fixedRailList');
    const path=C.findPath(C.stationId(from),C.stationId(to));
    const duration=bareRails?(path.length-1)*2:from==='桜上水'?5:4;
    return {ok:true,json:async()=>({ResultSet:{Course:{dataType:'plain',Route:{timeWalk:'0',timeOther:'99',transferCount:'0',Line:{Name:name,Type:'train',timeOnBoard:String(duration),stopStationCount:String(path.length-2+stopCountDelta)},Point:[{Station:{Name:from}},{Station:{Name:to}}]}}}})};
  };
  for(const file of ['data/seed.js','railway-core.js','api-config.js','ekispert-client.js','data-manager.js','script.js']){
    w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  }
  await flush();
  const $=id=>w.document.getElementById(id);
  return {w,$,errors,dom,intervals,requests,get blob(){return blob;},
    async set(id,value,event='change'){$(id).value=value;$(id).dispatchEvent(new w.Event(event,{bubbles:true}));await flush();},
    async click(id){$(id).click();await flush();},
    async check(id,checked){$(id).checked=checked;$(id).dispatchEvent(new w.Event('change',{bubbles:true}));await flush();},
    async tick(seconds){now+=seconds*1000;for(const callback of intervals)callback();await flush();},
    async resume(seconds){hidden=true;now+=seconds*1000;hidden=false;w.document.dispatchEvent(new w.Event('visibilitychange'));await flush();},
    async submit(){ $('train-editor').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();},
    store:()=>JSON.parse(w.localStorage.getItem(C.KEY)),
    close:()=>w.close()
  };
}

async function addTrain(a,departure='18:09:00',arrival='18:10:00'){
  await a.click('new-train');await a.set('edit-type','急行');
  await a.set('edit-stops','桜上水,,'+departure+',停車\n笹塚,'+arrival+',,停車');
  await a.submit();assert.match(a.$('editor-message').textContent,/保存し/);
  return a.store().additions.at(-1);
}
test('出発地・比較駅は固定、目的地は52駅から選択。メニュー機能を維持',async()=>{
  const a=await app();try{
    assert.deepEqual(a.errors,[]);assert.equal(a.$('destination').options.length,52);
    for(const id of ['origin-name','candidate-a','candidate-b','filter-line','usage-mode'])assert.equal(a.$(id),null);
    assert.equal(a.$('walking-station').options.length,2);assert.equal(a.$('filter-station').options.length,2);
    assert.match(a.$('page-search').textContent,/日本大学文理学部/);
    assert.ok(!/シミュレーション|仮データ/.test(a.w.document.body.textContent));
    for(const page of ['timetable','walking','storage','search']){a.w.document.querySelector('[data-page="'+page+'"]').click();assert.equal(a.$('page-'+page).hidden,false);}
    assert.ok(a.requests.length>0);assert.ok(a.requests.every(url=>url.pathname==='/.netlify/functions/ekispert'&&!url.searchParams.has('key')));assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('新12表の編集一覧と翌日・原文行先を維持',async()=>{
  const a=await app();try{
    const counts={sakurajosui:{weekday:[251,240],saturday:[226,223],sunday:[226,223]},shimotakaido:{weekday:[156,161],saturday:[155,157],sunday:[155,157]}};
    for(const [station,days]of Object.entries(counts))for(const [day,expected]of Object.entries(days))for(const [i,direction]of ['inbound','outbound'].entries()){
      await a.set('filter-station',station);await a.set('filter-day',day);await a.set('filter-direction',direction);
      assert.equal(a.$('table-count').textContent,expected[i]+'件');
    }
    await a.set('filter-hour','24');assert.equal(a.$('table-count').textContent,'7件');assert.match(a.$('timetable-rows').textContent,/翌日 00:52:00/);
    a.$('timetable-rows').querySelector('[data-edit]').click();await flush();
    const destination=a.$('edit-destination').value;await a.submit();
    assert.match(a.$('editor-message').textContent,/保存し/);assert.equal(Object.values(a.store().updates)[0].destination,destination);
  }finally{a.close();}
});
test('API契約に沿う応答を使って発車に乗車時間を加算し、待ち時間を重複加算しない',async()=>{
  const a=await app(null,{apiEnabled:true});try{
    const start=new Date('2026-10-19T18:00:00+09:00').getTime(),rows=await a.w.RailwayApp.getTrains({start,end:start+7200000});
    assert.ok(rows.length);assert.ok(rows.every(row=>row.arrival-row.departure===(row.stationId==='sakurajosui'?5:4)*60000));
    assert.match(a.$('recommendation-details').textContent,/推定到着/);assert.ok(a.requests.some(url=>url.searchParams.get('endpoint')==='rail'));
    assert.ok(a.requests.some(url=>url.searchParams.get('searchType')==='plain'&&url.searchParams.get('fixedRailList')));
    const count=a.requests.length;await a.w.RailwayApp.getTrains({start,end:start+7200000});assert.equal(a.requests.length,count);
  }finally{a.close();}
});
test('時刻表の追加・編集・削除と再読み込み・即時反映',async()=>{
  const a=await app(null,{apiEnabled:true});let b;try{
    await a.set('filter-hour','18');const train=await addTrain(a);
    assert.match(a.$('recommendation-details').textContent,/18:10:00/);
    a.w.document.querySelector('[data-edit="'+train.id+'"]').click();await flush();
    await a.set('edit-stops','桜上水,,18:09,停車\n笹塚,18:11,,停車');await a.submit();assert.match(a.$('recommendation-details').textContent,/18:11:00/);
    a.w.document.querySelector('[data-delete="'+train.id+'"]').click();await flush();
    const originalId=a.$('timetable-rows').querySelector('[data-delete^="provided:"]').dataset.delete;
    a.w.document.querySelector('[data-delete="'+originalId+'"]').click();await flush();
    b=await app(a.w.localStorage.getItem(C.KEY));await b.set('filter-hour','18');
    assert.ok(b.store().deleted.includes(originalId));assert.ok(!b.w.document.querySelector('[data-edit="'+originalId+'"]'));
  }finally{a.close();b?.close();}
});
test('秒更新・固定テスト日時・タブ復帰・左右の順序とカード/フォーカス保護',async()=>{
  const a=await app(null,{apiEnabled:true});try{
    await a.set('departure','2026-10-19T18:03:30','input');const input=a.$('departure').value;
    await a.tick(30);assert.equal(a.$('departure').value,input);await a.click('now');
    const card=a.w.document.querySelector('.hero-route'),panels=card.querySelectorAll('.countdowns>div');
    assert.match(panels[0].textContent,/電車の発車まで/);assert.match(panels[1].textContent,/大学を出るまで/);
    const before=panels[0].textContent;a.$('walk-sakurajosui').focus();await a.tick(1);
    assert.equal(a.w.document.activeElement,a.$('walk-sakurajosui'));assert.equal(a.w.document.querySelector('.hero-route'),card);assert.notEqual(panels[0].textContent,before);
    await a.resume(600);assert.match(a.$('clock').textContent,/18:10:31/);assert.deepEqual(a.errors,[]);
  }finally{a.close();}
});
test('2駅の徒歩履歴・日時・平均適用・個別削除・再読み込み・最後の削除',async()=>{
  const a=await app();let b;try{
    for(const seconds of [120,240]){
      a.w.document.querySelector('[data-walk-start="sakurajosui"]').click();await flush();await a.tick(seconds);
      a.w.document.querySelector('[data-walk-end="sakurajosui"]').click();await flush();
    }
    assert.equal(a.store().walking.history.length,2);assert.equal(a.$('walking-history').querySelectorAll('li').length,2);
    assert.match(a.$('walking-history').textContent,/桜上水駅/);assert.match(a.$('walking-history').textContent,/2026/);
    a.w.document.querySelector('[data-walk-apply="sakurajosui"]').click();await flush();assert.equal(a.$('walk-sakurajosui').value,'3');
    const id=a.store().walking.history[0].id;a.w.document.querySelector('[data-walk-delete="'+id+'"]').click();await flush();
    assert.equal(a.$('walk-sakurajosui').value,'4');assert.match(a.$('walking-controls').textContent,/平均 4分0秒/);
    b=await app(a.w.localStorage.getItem(C.KEY));assert.equal(b.$('walking-history').querySelectorAll('li').length,1);assert.equal(b.$('walk-sakurajosui').value,'4');
    b.$('walking-history').querySelector('button').click();await flush();assert.equal(b.store().walking.history.length,0);assert.equal(b.$('walk-sakurajosui').value,'9');assert.match(b.$('walking-controls').textContent,/記録なし/);
  }finally{a.close();b?.close();}
});
test('既存保存の他駅時刻表・旧設定を削除し、両駅の履歴と編集を保持',async()=>{
  const old=C.blankStore();old.settings.mode='simulation';old.settings.search={origin:'自宅',destination:'新宿',candidates:['明大前','代田橋']};
  const row=C.makeUserTrain({stationId:'sakurajosui',line:'keio',serviceDay:'weekday',direction:'inbound',type:'各駅停車',destination:'新宿',stops:C.parseStopLines('桜上水,,18:10,停車')});
  old.additions=[row,{...row,id:'user:other',anchorStationId:'明大前'}];old.walking.history=[{stationId:'sakurajosui',seconds:541,date:'2026-10-18T00:00:00Z'}];
  const a=await app(JSON.stringify(old));try{
    assert.equal(a.store().additions.length,1);assert.equal(a.store().additions[0].id,row.id);assert.equal(a.store().settings.mode,undefined);
    assert.equal(a.store().walking.history[0].seconds,541);assert.ok(a.store().walking.history[0].id);
    assert.equal(a.$('destination').value,'新宿');assert.match(a.$('page-search').textContent,/日本大学文理学部/);assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('一括登録・不正行ロールバック・バックアップ確認と復元・時刻表初期化',async()=>{
  const a=await app();try{
    await a.set('bulk-text','26:01\n26:02,急行,新宿');await a.click('bulk-save');assert.match(a.$('bulk-message').textContent,/2件/);
    await a.set('bulk-text','26:03\n18:99');await a.click('bulk-save');assert.equal(a.store().additions.length,2);
    await a.click('export-data');const text=await new Promise(resolve=>{const reader=new a.w.FileReader();reader.onload=()=>resolve(reader.result);reader.readAsText(a.blob);});
    const imported=JSON.parse(text);imported.settings.dayType='holiday';
    Object.defineProperty(a.$('import-file'),'files',{value:[{size:100,text:async()=>JSON.stringify(imported)}]});a.$('import-file').dispatchEvent(new a.w.Event('change'));await flush();
    assert.equal(a.$('import-confirm').hidden,false);assert.equal(a.store().settings.dayType,'auto');await a.click('import-confirm');assert.equal(a.store().settings.dayType,'sunday');
    await a.click('reset-data');assert.equal(a.store().additions.length,0);assert.equal(a.store().settings.dayType,'sunday');
  }finally{a.close();}
});
test('APIの403・キー未設定時は到着を捏造せず、秘密値を表示しない',async()=>{
  const a=await app(null,{apiEnabled:true,failStatus:403});try{
    assert.match(a.$('recommendation-details').textContent,/403/);assert.ok(!a.$('page-search').textContent.includes('TEST_KEY'));
    assert.ok(!/NaN|1970|Invalid Date/.test(a.$('page-search').textContent));assert.equal(a.$('error').hidden,true);
  }finally{a.close();}
});
test('公開環境向け接続確認の成功・未設定・認証失敗を表示し、ボタンを復帰',async()=>{
  for(const [options,pattern]of [[{apiEnabled:true},/両APIへの接続・認証に成功/],[{},/EKISPERT_API_KEY が未設定/],[{apiEnabled:true,failStatus:403},/HTTP 403/]]){
    const a=await app(null,options);try{
      await a.click('check-api');assert.match(a.$('api-check-result').textContent,pattern);
      assert.equal(a.$('check-api').disabled,false);assert.ok(a.requests.some(url=>url.searchParams.get('endpoint')==='diagnostics'));
      assert.ok(a.requests.every(url=>!url.searchParams.has('key')&&url.origin==='https://station-route-app.test'));
    }finally{a.close();}
  }
});
test('破損保存は上書きせず、明示リセットで復帰',async()=>{
  const broken='{"version":999}',a=await app(broken);try{
    assert.match(a.$('storage-notice').textContent,/元の保存内容は変更せず/);
    a.w.document.querySelector('[data-walk-start="sakurajosui"]').click();await flush();assert.equal(a.w.localStorage.getItem(C.KEY),broken);
    await a.click('reset-all');assert.equal(a.store().version,1);
  }finally{a.close();}
});

function customSchedule(rows,destination='sasazuka'){
  const store=C.blankStore();store.settings.search={destination};
  const seed={timetables:JSON.parse(fs.readFileSync(path.join(root,'data/keio_12_timetables.json'),'utf8')),network:{travelTimeProfiles:{}}};
  store.deleted=C.ingest(seed).trains.map(train=>train.id);
  for(const [station,direction,type,departure,arrival]of rows)store.additions.push(C.makeUserTrain({stationId:station,line:'keio',serviceDay:'weekday',direction,type,destination:C.stationName(destination),stops:C.parseStopLines(`${C.stationName(station)},,${departure},停車\n${C.stationName(destination)},${arrival},,停車`)}));
  return JSON.stringify(store);
}
test('指定された駅選択ルールをUIでも優先し、遅い場合に「早い」と表示しない',async()=>{
  for(const [rows,destination,title,comparison]of [
    [[['sakurajosui','outbound','各駅停車','18:09','18:30'],['shimotakaido','outbound','各駅停車','18:08','18:20']],'八幡山',/今は桜上水駅/,/下り方面は桜上水駅/],
    [[['sakurajosui','inbound','各駅停車','18:09','18:12'],['shimotakaido','inbound','各駅停車','18:08','18:14']],'sasazuka',/今は下高井戸駅/,/2分遅く/],
    [[['sakurajosui','inbound','急行','18:09','18:14'],['shimotakaido','inbound','快速','18:08','18:14']],'sasazuka',/どちらの駅でも笹塚への到着は同じ/,/両駅の列車/]
  ]){
    const a=await app(customSchedule(rows,destination));try{assert.match(a.$('recommendation-title').textContent,title);assert.match(a.$('recommendation-details').textContent,comparison);assert.ok(!a.$('recommendation-details').textContent.includes('0分早い'));}finally{a.close();}
  }
});
test('徒歩短縮の具体的提案と秒更新。提案があってもカードを描き直さない',async()=>{
  const saved=customSchedule([
    ['sakurajosui','inbound','急行','18:06','18:12'],['sakurajosui','inbound','急行','18:10','18:20'],
    ['shimotakaido','inbound','各駅停車','18:10','18:22']
  ]),a=await app(saved);try{
    const suggestion=a.w.document.querySelector('.walking-suggestion');assert.ok(suggestion);
    assert.match(suggestion.textContent,/通常より3分早く歩けば、目的地に8分早く到着できます/);
    const hero=a.w.document.querySelector('.hero-route');await a.tick(1);
    assert.equal(a.w.document.querySelector('.walking-suggestion'),suggestion);assert.equal(a.w.document.querySelector('.hero-route'),hero);
    assert.match(suggestion.textContent,/3分1秒/);
  }finally{a.close();}
});

test('京王八王子を含む下り各方面は無印路線の各停で到着を推定し、下高井戸を探索しない',async()=>{
  const a=await app(null,{apiEnabled:true,bareRails:true});try{
    await a.set('departure','2026-10-19T12:00:00','input');
    const queries=[],query=a.w.RailwayCore.query;
    a.w.RailwayCore.query=(trains,seed,request)=>{queries.push({trains,request});return query(trains,seed,request);};
    const initialRequests=a.requests.length;
    for(const destination of ['京王八王子','高幡不動','橋本','高尾山口','京王多摩センター','八幡山']){
      await a.set('destination',destination);
      const start=new Date('2026-10-19T12:00:00+09:00').getTime();
      const rows=await a.w.RailwayApp.getTrains({start,end:start+7200000});await flush();
      assert.ok(rows.length,destination);assert.ok(rows.every(row=>row.stationId==='sakurajosui'&&row.arrivalSource==='estimated'));
      assert.ok(rows.every(row=>row.arrival-row.departure===(C.findPath('sakurajosui',destination).length-1)*2*60000));
      assert.match(a.$('recommendation-title').textContent,/今は桜上水駅/);
      assert.match(a.$('recommendation-details').textContent,/推定到着/);
      assert.match(a.$('comparison').textContent,/推定到着/);assert.ok(!a.$('comparison').textContent.includes('下高井戸'));
    }
    assert.ok(queries.every(({trains,request})=>request.fromIds.length===1&&request.fromIds[0]==='sakurajosui'&&trains.every(train=>train.anchorStationId==='sakurajosui')));
    assert.ok(a.requests.slice(initialRequests).every(url=>![url.searchParams.get('from'),url.searchParams.get('viaList')?.split(':')[0]].includes('下高井戸')));
    assert.equal(a.$('result-walking-station').value,'sakurajosui');assert.deepEqual(a.errors,[]);
  }finally{a.close();}
});

test('停車パターン不一致・深夜の候補なしでは根拠のない駅案内を出さない',async()=>{
  const a=await app(null,{apiEnabled:true,bareRails:'only-local',stopCountDelta:-1});try{
    await a.set('departure','2026-10-19T12:00:00','input');
    await a.set('destination','京王八王子');
    assert.match(a.$('recommendation-title').textContent,/乗車可能な列車なし/);
    assert.ok(!a.$('recommendation-details').textContent.includes('おすすめします'));
    assert.match(a.$('recommendation-details').textContent,/平均路線・乗車時間/);
    assert.ok(!a.$('recommendation-details').textContent.includes('停車を確認できません'));
    await a.set('departure','2026-10-19T02:00:00','input');
    assert.ok(!a.$('recommendation-title').textContent.includes('向かう'));
    assert.equal(a.w.document.querySelector('.hero-route'),null);
  }finally{a.close();}
});

test('提供JSONの八・高八と曜日を保持し、直通便がない平日夕方は捏造しない',async()=>{
  const a=await app(null,{apiEnabled:true,bareRails:true});try{
    await a.set('destination','京王八王子');
    assert.match(a.$('recommendation-title').textContent,/乗車可能な列車なし/); // 平日18:00〜20:00に直通便なし。
    await a.set('departure','2026-10-19T05:40:00','input');
    const start=new Date('2026-10-19T05:40:00+09:00').getTime();
    const rows=await a.w.RailwayApp.getTrains({start,end:start+7200000});
    const eight=rows.find(row=>row.trainDestination==='八'&&row.type==='各駅停車'),high=rows.find(row=>row.trainDestination==='高八');
    assert.ok(eight&&high);assert.equal(eight.arrivalSource,'estimated');
    assert.equal(high.type,'急行');
    assert.deepEqual(JSON.parse(JSON.stringify(high.predictionSegments)),[{from:'sakurajosui',to:'高幡不動',type:'急行'},{from:'高幡不動',to:'京王八王子',type:'各駅停車'}]);
    assert.equal(high.arrival-high.departure,(C.findPath('sakurajosui','京王八王子').length-1)*2*60000);
    for(const [date,day]of [['2026-10-24','saturday'],['2026-10-25','sunday']]){
      await a.set('departure',date+'T18:00:00','input');const time=new Date(date+'T18:00:00+09:00').getTime();
      const weekend=await a.w.RailwayApp.getTrains({start:time,end:time+7200000});
      assert.ok(weekend.length);assert.ok(weekend.every(row=>row.serviceDay===day&&row.stationId==='sakurajosui'));
      assert.match(a.$('recommendation-title').textContent,/今は桜上水駅/);
    }
  }finally{a.close();}
});

test('結果からの徒歩計測はメニューと状態を共有し、手動選択・復帰・再起動後の日時差を維持',async()=>{
  const a=await app(null,{apiEnabled:true});let b,c;
  try{
    assert.equal(a.$('result-walking').hidden,false);assert.equal(a.$('result-walking-station').options.length,2);
    assert.equal(a.$('result-walking-station').value,'shimotakaido'); // 両駅各停の推奨ルール。
    await a.set('result-walking-station','sakurajosui');await a.tick(1);
    assert.equal(a.$('result-walking-station').value,'sakurajosui'); // 秒更新で選択を上書きしない。
    a.$('result-walking-start').focus();await a.click('result-walking-start');
    const startedAt=a.store().walking.active.startedAt;
    assert.equal(a.store().walking.active.stationId,'sakurajosui');
    assert.equal(a.$('result-walking-start').disabled,true);assert.equal(a.$('walking-station').disabled,true);
    assert.equal(a.w.document.querySelector('[data-walk-start]').disabled,true);
    await a.resume(127); // intervalを実行せず、バックグラウンドから復帰。
    assert.match(a.$('result-walking-elapsed').textContent,/2分7秒/);
    assert.equal(a.$('walking-elapsed').textContent,a.$('result-walking-elapsed').textContent);
    assert.equal(a.store().walking.active.startedAt,startedAt);assert.equal(a.store().walking.history.length,0);
    b=await app(a.w.localStorage.getItem(C.KEY),{apiEnabled:true,nowAt:new Date(startedAt+247000).toISOString()});
    a.close();
    assert.match(b.$('result-walking-elapsed').textContent,/4分7秒/);
    assert.equal(b.$('result-walking-station').value,'sakurajosui'); // 推奨が変わっても計測対象を維持。
    await b.resume(13);await b.click('result-walking-stop');
    assert.equal(b.store().walking.active,null);assert.equal(b.store().walking.history.length,1);
    assert.equal(b.store().walking.history[0].seconds,260);
    assert.equal(b.store().walking.history[0].date,new Date(startedAt+260000).toISOString());
    assert.match(b.$('walking-history').textContent,/4分20秒/);
    b.w.document.querySelector('[data-walk-apply="sakurajosui"]').click();await flush();
    assert.equal(b.$('walk-sakurajosui').value,'5');
    // メニューで開始し、結果側で停止しても重複記録を作らない。
    b.w.document.querySelector('[data-walk-start="sakurajosui"]').click();await flush();
    await b.resume(100);await b.click('result-walking-stop');
    assert.equal(b.store().walking.history.length,2);assert.equal(b.$('walk-sakurajosui').value,'3');
    const id=b.store().walking.history[0].id;b.w.document.querySelector('[data-walk-delete="'+id+'"]').click();await flush();
    assert.equal(b.store().walking.history.length,1);assert.equal(b.$('walk-sakurajosui').value,'2');
    c=await app(b.w.localStorage.getItem(C.KEY));assert.equal(c.store().walking.active,null);assert.equal(c.store().walking.history[0].seconds,100);
    assert.equal(c.$('walk-sakurajosui').value,'2');assert.equal(c.$('result-walking-stop').disabled,true);
    assert.deepEqual(b.errors,[]);
  }finally{a.close();b?.close();c?.close();}
});
