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
async function app(saved=null) {
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://station-route-app.test',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, intervals=[],errors=[];let now=new Date('2026-10-19T18:00:00+09:00').getTime(),hidden=false,blob;
  const ActualDate=w.Date;w.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  w.setInterval=callback=>{intervals.push(callback);return intervals.length;};
  w.confirm=()=>true;
  w.URL.createObjectURL=value=>{blob=value;return 'blob:test';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){};
  w.addEventListener('error',event=>errors.push(event.error||event.message));
  Object.defineProperty(w.document,'hidden',{get:()=>hidden});
  if(saved)w.localStorage.setItem(C.KEY,saved);
  w.localStorage.setItem('old-walking-key','preserved');
  for(const file of ['data/seed.js','railway-core.js','data-manager.js','script.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  await flush();
  const $=id=>w.document.getElementById(id);
  return {w,$,errors,dom,intervals,get blob(){return blob;},
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
async function otherStations(a){
  await a.set('candidate-a','明大前');await a.set('candidate-b','代田橋');
  await a.set('walk-sakurajosui','0','input');await a.set('walk-shimotakaido','0','input');
}
test('シンプルな検索画面とメニュー。確認操作なしで提供発車を表示',async()=>{
  const a=await app();try{
    assert.deepEqual(a.errors,[]);
    assert.equal(a.$('candidate-a').options.length,52);assert.equal(a.$('destination').options.length,52);
    assert.match(a.$('recommendation-title').textContent,/発車候補/);
    assert.match(a.$('recommendation-details').textContent,/到着時刻が未登録/);
    assert.match(a.$('comparison').textContent,/未登録/);
    assert.equal(a.$('search-button').type,'submit');
    for(const id of ['usage-mode','allow-estimated','allow-reverse','edit-confirmed','edit-checked','data-audit'])assert.equal(a.$(id),null);
    assert.equal(a.$('page-search').querySelector('input[type=file]'),null);
    assert.equal(a.$('page-search').querySelector('#export-data'),null);
    for(const page of ['timetable','walking','storage','search']){
      a.w.document.querySelector('[data-page="'+page+'"]').click();assert.equal(a.$('page-'+page).hidden,false);assert.equal(a.$('app-menu').open,false);
    }
    assert.ok(!a.$('page-search').textContent.includes('確認済み'));
    assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('追加・編集を即時反映。到着不明を含む比較では駅を断定しない',async()=>{
  const a=await app();let b;try{
    await a.set('filter-hour','18');const train=await addTrain(a);
    assert.match(a.$('recommendation-details').textContent,/18:10:00/);
    assert.match(a.$('recommendation-details').textContent,/比較は未確定/);
    const edit=a.w.document.querySelector('[data-edit="'+train.id+'"]');assert.ok(edit);edit.click();await flush();
    await a.set('edit-stops','桜上水,,18:09,停車\n笹塚,18:11,,停車');await a.submit();
    assert.match(a.$('recommendation-details').textContent,/18:11:00/);
    a.w.document.querySelector('[data-delete="'+train.id+'"]').click();await flush();
    assert.match(a.$('recommendation-title').textContent,/発車候補/);
    const originalId=a.w.document.querySelector('[data-delete^="provided:"]').dataset.delete;
    a.w.document.querySelector('[data-delete="'+originalId+'"]').click();await flush();
    b=await app(a.w.localStorage.getItem(C.KEY));await b.set('filter-hour','18');
    assert.ok(b.store().deleted.includes(originalId));assert.ok(!b.w.document.querySelector('[data-edit="'+originalId+'"]'));
  }finally{a.close();b?.close();}
});
test('他駅の徒歩時間変更で推奨駅が変化し、同着・次発・遅延も表示',async()=>{
  const a=await app();try{
    await otherStations(a);assert.match(a.$('recommendation-title').textContent,/到着は同じ/);
    assert.match(a.$('recommendation-details').textContent,/シミュレーション/);
    await a.set('walk-shimotakaido','120','input');assert.match(a.$('recommendation-title').textContent,/今は明大前駅/);
    await a.set('walk-shimotakaido','0','input');await a.set('walk-sakurajosui','120','input');assert.match(a.$('recommendation-title').textContent,/今は代田橋駅/);
    assert.match(a.$('comparison').textContent,/次に発車する電車/);assert.match(a.$('comparison').textContent,/遅い/);
    assert.ok(!/NaN|1970|Invalid Date/.test(a.$('page-search').textContent));
  }finally{a.close();}
});
test('高尾・相模原・新線の駅を選択して検索。乗換案内も表示',async()=>{
  const a=await app();try{
    await a.set('candidate-a','高尾山口');await a.set('candidate-b','橋本');await a.set('destination','新宿');
    await a.set('walk-sakurajosui','0','input');await a.set('walk-shimotakaido','0','input');
    assert.match(a.$('recommendation-details').textContent,/新宿駅への到着/);
    assert.match(a.$('comparison').textContent,/高尾山口駅/);assert.match(a.$('comparison').textContent,/橋本駅/);
    assert.match(a.$('comparison').textContent,/乗換/);assert.match(a.$('comparison').textContent,/北野/);
    await a.set('candidate-a','新線新宿');await a.set('walk-sakurajosui','0','input');await a.set('destination','高尾山口');
    assert.match(a.$('comparison').textContent,/シミュレーション/);
    assert.equal(a.$('error').hidden,true);
  }finally{a.close();}
});
test('一括登録・不正行ロールバック・バックアップ復元確認',async()=>{
  const a=await app();try{
    await a.set('bulk-text','26:01\n26:02,急行,新宿');await a.click('bulk-save');assert.match(a.$('bulk-message').textContent,/2件/);
    const count=a.store().additions.length;
    await a.set('bulk-text','26:03\n18:99');await a.click('bulk-save');assert.equal(a.store().additions.length,count);
    await a.click('export-data');assert.ok(a.blob instanceof a.w.Blob);
    const text=await new Promise((resolve,reject)=>{const reader=new a.w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(a.blob);});
    const imported=JSON.parse(text);assert.equal(imported.additions.length,2);imported.settings.dayType='holiday';
    Object.defineProperty(a.$('import-file'),'files',{configurable:true,value:[{size:100,text:async()=>JSON.stringify(imported)}]});
    a.$('import-file').dispatchEvent(new a.w.Event('change'));await flush();
    assert.equal(a.$('import-confirm').hidden,false);assert.equal(a.store().settings.dayType,'auto');
    await a.click('import-confirm');assert.equal(a.store().settings.dayType,'holiday');assert.equal(a.$('service-day').value,'holiday');
    assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('全駅の徒歩計測・保存・平均適用・リロードと時刻表初期化',async()=>{
  const a=await app();let b;try{
    await a.set('walking-station','高尾山口');
    a.w.document.querySelector('[data-walk-start="高尾山口"]').click();await flush();await a.tick(541);
    assert.match(a.$('walking-elapsed').textContent,/9分1秒/);
    a.w.document.querySelector('[data-walk-end="高尾山口"]').click();await flush();assert.equal(a.store().walking.history[0].seconds,541);
    a.w.document.querySelector('[data-walk-apply="高尾山口"]').click();await flush();
    assert.equal(a.$('candidate-a').value,'高尾山口');assert.equal(a.$('walk-sakurajosui').value,'10');
    await a.click('reset-data');assert.equal(a.store().walking.history.length,1);
    b=await app(a.w.localStorage.getItem(C.KEY));assert.equal(b.$('candidate-a').value,'高尾山口');assert.equal(b.$('walk-sakurajosui').value,'10');
    await b.set('walking-station','高尾山口');assert.match(b.$('walking-controls').textContent,/平均 9分1秒/);
  }finally{a.close();b?.close();}
});
test('固定テスト日時・現在日時・秒更新・タブ復帰・カードとフォーカス保護',async()=>{
  const a=await app();try{
    await a.set('departure','2026-10-19T18:03:30','input');
    const datetime=a.$('departure').value;await a.tick(30);assert.equal(a.$('departure').value,datetime);
    await a.click('now');const card=a.w.document.querySelector('.hero-route');
    const before=a.w.document.querySelector('[data-countdown]').textContent;a.$('walk-sakurajosui').focus();await a.tick(1);
    assert.equal(a.w.document.activeElement,a.$('walk-sakurajosui'));assert.equal(a.w.document.querySelector('.hero-route'),card);
    assert.notEqual(a.w.document.querySelector('[data-countdown]').textContent,before);
    await a.resume(600);assert.match(a.$('clock').textContent,/18:10:31/);
    a.$('conditions').dispatchEvent(new a.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
    assert.equal(a.$('error').hidden,true);assert.ok(!/NaN|1970/.test(a.$('page-search').textContent));
  }finally{a.close();}
});
test('旧モード・確認状態・徒歩記録・削除状態を保持しモードを無視して検索',async()=>{
  const old=C.blankStore();old.settings.mode='practical';old.settings.dataset='legacy';old.settings.allowEstimated=false;
  old.confirmations.sakurajosui_weekday_inbound={status:'confirmed',checkedAt:'2026-10-18'};
  old.walking.history=[{stationId:'sakurajosui',seconds:541,date:'2026-10-18T00:00:00Z'}];old.walking.values.sakurajosui=10;
  old.deleted=['provided:sakurajosui_weekday_inbound:0'];
  const a=await app(JSON.stringify(old));try{
    assert.match(a.$('recommendation-title').textContent,/発車候補/);
    assert.equal(a.$('walk-sakurajosui').value,'10');
    await a.set('origin-name','自宅');
    const saved=a.store();assert.equal(saved.settings.mode,'practical');assert.equal(saved.settings.dataset,'legacy');
    assert.equal(saved.walking.history[0].seconds,541);assert.deepEqual(saved.deleted,old.deleted);assert.deepEqual(saved.confirmations,old.confirmations);
    assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('平日・土休日を手動指定し、目的駅と出発地も保存',async()=>{
  const a=await app();let b;try{
    await a.set('service-day','holiday');await a.set('origin-name','現在地');await a.set('destination','新宿');
    const start=new Date('2026-10-19T18:00:00+09:00').getTime();const result=await a.w.RailwayApp.getTrains({start,end:start+7200000});
    assert.ok(result.length);assert.ok(result.every(train=>train.serviceDay==='holiday'));
    b=await app(a.w.localStorage.getItem(C.KEY));assert.equal(b.$('origin-name').value,'現在地');assert.equal(b.$('destination').value,'新宿');assert.equal(b.$('service-day').value,'holiday');
  }finally{a.close();b?.close();}
});
test('破損保存データは自動上書きせず、明示リセットで復帰',async()=>{
  const broken='{"version":999}',a=await app(broken);try{
    assert.match(a.$('storage-notice').textContent,/元の保存内容は変更せず/);
    a.w.document.querySelector('[data-walk-start="sakurajosui"]').click();await flush();assert.equal(a.w.localStorage.getItem(C.KEY),broken);
    await a.click('reset-all');assert.equal(a.store().version,1);assert.equal(a.w.localStorage.getItem('old-walking-key'),'preserved');
  }finally{a.close();}
});
test('登録時刻表でも後発先着と乗り逃しの次発・最早候補を比較',async()=>{
  const saved=C.blankStore();saved.settings.search={origin:'日本大学文理学部',destination:'sasazuka',candidates:['明大前','代田橋']};saved.walking.values={'明大前':0,'代田橋':120};
  for(const [departure,arrival]of [[1085,1100],[1090,1092],[1093,1099],[1094,1096]])saved.additions.push(C.makeUserTrain({stationId:'明大前',line:'keio',direction:'inbound',serviceDay:'weekday',type:'各駅停車',destination:'笹塚',stops:[
    {stationId:'明大前',arrival:null,departure,stop:true,arrivalSource:null,departureSource:'user_entered'},
    {stationId:'sasazuka',arrival,departure:null,stop:true,arrivalSource:'user_entered',departureSource:null}
  ]}));
  const a=await app(JSON.stringify(saved));try{
    assert.match(a.$('recommendation-title').textContent,/今は明大前駅/);
    assert.match(a.$('recommendation-details').textContent,/18:10:00発/);assert.match(a.$('recommendation-details').textContent,/18:12:00/);
    assert.match(a.$('recommendation-details').textContent,/8分早く到着/);
    assert.match(a.$('comparison').textContent,/推奨列車より7分遅い/);assert.match(a.$('comparison').textContent,/推奨列車より4分遅い/);
  }finally{a.close();}
});

