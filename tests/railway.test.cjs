const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../railway-core.js');
process.env.TZ='Asia/Tokyo';
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../data',name),'utf8'));
const seed={timetables:read('keio_12_timetables.json'),network:read('keio_all_data.json')};
const base=C.ingest(seed).trains,start=new Date('2026-10-23T18:00:00+09:00').getTime();
require('../api-config.js');const aliases=globalThis.EkispertConfig.destinationAliases;
function user(departure=1090,arrival=1100,extra={}){return C.makeUserTrain({stationId:'sakurajosui',line:'keio',direction:'inbound',serviceDay:'weekday',type:'各駅停車',destination:'新宿',stops:C.parseStopLines(`桜上水,,${C.serviceTime(departure)},停車\n笹塚,${C.serviceTime(arrival)},,停車`),...extra});}
const query=(trains,settings={},destinationId='sasazuka')=>C.query(trains,seed,{start,end:start+7200000,fromIds:C.FOCUS_STATIONS,destinationId,settings}).trains;

test('元JSON・静的バンドル・SHA256と2駅限定の完全性',()=>{
  for(const item of read('manifest.json').files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../data',item.name))).digest('hex'),item.sha256);
  const context=require('node:vm').createContext({});require('node:vm').runInContext(fs.readFileSync(path.join(__dirname,'../data/seed.js'),'utf8'),context);
  assert.equal(JSON.stringify(context.RailwaySeed.timetables),JSON.stringify(seed.timetables));
  assert.equal(seed.network.timetables,undefined);assert.ok(base.every(t=>C.isFocusStation(t.anchorStationId)));
  assert.equal(C.generateSimulation,undefined);
});
test('駅間平均31区間を保持し、根拠のない種別・区間を補わない',()=>{
  assert.equal(seed.network.travelTimeProfiles['各駅停車'].segments.length,31);
  for(const [a,b]of [['sakurajosui','shimotakaido'],['shimotakaido','sakurajosui']])assert.equal(C.runningTime(seed.network,a,b,'各駅停車').minutes,1);
  assert.equal(C.runningTime(seed.network,'sakurajosui','sasazuka','急行'),null);
  assert.equal(C.runningTime(seed.network,'北野','高尾山口','各駅停車'),null);
});
test('API平均時間を発車に加算し、登録済み到着時刻を優先する',()=>{
  const initial=query(base),predictions={};
  for(const row of initial)predictions[C.predictionKey(row.stationId,'sasazuka',row.type,row.direction,row.operatingDate,row.predictionSegments)]={minutes:5,source:'ekispert'};
  const rows=query(base,{predictions});assert.ok(rows.length);
  assert.ok(rows.every(row=>row.arrival-row.departure===300000&&row.arrivalSource==='estimated'));
  const registered=user(1090,1100);assert.equal(query([registered],{predictions})[0].arrival-start,20*60000);
  const blocked=Object.fromEntries(Object.keys(predictions).map(key=>[key,{notServed:true}]));assert.equal(query(base,{predictions:blocked}).length,0);
});
test('行先・経由路線・種別変更を使い、終点越えや通過駅を除外',()=>{
  const high=C.clone(base.find(t=>t.destination==='高八'));assert.ok(high);
  assert.equal(C.terminalStation(high,aliases),'京王八王子');
  assert.deepEqual(C.predictionSegments(high,'sakurajosui','京王八王子',aliases),[{from:'sakurajosui',to:'高幡不動',type:high.type},{from:'高幡不動',to:'京王八王子',type:'各駅停車'}]);
  const bridge=base.find(t=>t.destination==='セ橋');
  assert.deepEqual(C.predictionSegments(bridge,'sakurajosui','橋本',aliases),[{from:'sakurajosui',to:'調布',type:bridge.type},{from:'調布',to:'京王多摩センター',type:bridge.type},{from:'京王多摩センター',to:'橋本',type:'各駅停車'}]);
  const short=C.clone(high);short.destination='高';short.raw.train.destination_raw='高';short.stops[0].departure=1090;
  assert.equal(query([short],{destinationAliases:aliases},'京王八王子').length,0);
  const wrongBranch=C.clone(high);wrongBranch.stops[0].departure=1090;
  assert.equal(query([wrongBranch],{destinationAliases:aliases},'橋本').length,0);
  const pass=user();pass.stops[1].stop=false;assert.equal(query([pass]).length,0);
});
test('追加・編集・削除・再読み込み・リセットを維持',()=>{
  const store=C.blankStore(),train=user();C.upsert(store,train,base);
  assert.ok(query(C.effectiveTrains(base,store)).some(t=>t.trainId===train.id));
  const original=base[0],edit={...C.clone(original),source:'user_entered'};edit.stops[0].departure+=1;C.upsert(store,edit,base);
  const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
  C.remove(store,original.id);C.saveStore(storage,store);
  assert.ok(!C.effectiveTrains(base,C.loadStore(storage,seed)).some(t=>t.id===original.id));
  assert.equal(C.effectiveTrains(base,C.blankStore()).length,2330);
});
test('一括登録・重複・不正時刻・逆転・登録駅の制限',()=>{
  const store=C.blankStore(),defaults={stationId:'sakurajosui',line:'keio',direction:'inbound',serviceDay:'weekday',type:'各駅停車',destination:'新宿'};
  assert.equal(C.bulkAdd(store,'26:01\n26:02,急行,新宿',defaults,base).added.length,2);
  assert.throws(()=>C.bulkAdd(store,'26:01\n26:01',defaults,base),/既に/);
  assert.throws(()=>C.bulkAdd(store,'26:03\n18:99',defaults,base));assert.equal(store.additions.length,0);
  assert.ok(C.validateTrain(user(1100,1090)).some(t=>t.includes('逆転')));
  assert.ok(C.validateTrain(user(1090,1100,{stationId:'明大前'})).length);
});
test('他駅の時刻表・旧設定を読み込み時に整理し、徒歩記録・両駅編集を保持',()=>{
  const store=C.blankStore();store.settings.mode='simulation';store.settings.search={origin:'自宅',candidates:['明大前','代田橋'],destination:'新宿'};
  store.additions=[user(),{...user(),id:'user:other',anchorStationId:'明大前'}];
  store.updates['sim:old']={...user(),id:'sim:old'};
  store.deleted=['provided:sasazuka_weekday_inbound:0','provided:sakurajosui_weekday_inbound:0'];
  store.walking.history=[{stationId:'sakurajosui',seconds:540,date:'2026-10-18'}];
  const storage={getItem:()=>JSON.stringify(store)},loaded=C.loadStore(storage,seed);
  assert.equal(loaded.additions.length,1);assert.deepEqual(loaded.updates,{});assert.equal(loaded.deleted.length,1);
  assert.equal(loaded.settings.mode,undefined);assert.deepEqual(loaded.settings.search,{destination:'新宿'});
  assert.equal(loaded.walking.history[0].seconds,540);assert.ok(loaded.walking.history[0].id);
  assert.equal(C.walkingAverage(loaded,'sakurajosui'),540);assert.deepEqual(C.validateStore(loaded),[]);
});
