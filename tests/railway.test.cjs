const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const C=require('../railway-core.js');
process.env.TZ='Asia/Tokyo';
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../data',name),'utf8'));
const seed={timetables:read('all_six_timetables.json'),network:read('keio_all_data.json')};
const ingested=C.ingest(seed), base=ingested.trains;
const at=time=>new Date(`2026-10-19T${time}+09:00`).getTime();
const memory=()=>{const data=new Map();return{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};};
const settings=overrides=>({...C.blankStore().settings,...overrides});
function query(trains,options={}){return C.query(trains,seed,{start:at('18:00:00'),end:at('20:00:00'),fromIds:['sakurajosui','shimotakaido'],destinationId:'sasazuka',settings:settings({}),...options});}
function user(departure=1090,arrival=1100,extra={}){return C.makeUserTrain({stationId:'sakurajosui',line:'keio',direction:'inbound',serviceDay:'weekday',type:'各駅停車',destination:'新宿',confirmed:true,checkedAt:'2026-10-18',stops:[
  {stationId:'sakurajosui',arrival:null,departure,stop:true,arrivalSource:null,departureSource:'user_entered'},
  {stationId:'sasazuka',arrival,departure:null,stop:true,arrivalSource:'user_entered',departureSource:null}
],...extra});}

test('6種類・1328件を省略せず変換し、元の全フィールドを保持',()=>{
  assert.deepEqual(ingested.counts,{sakurajosui_saturday_inbound:226,sakurajosui_weekday_inbound:251,sasazuka_saturday_inbound:263,sasazuka_weekday_inbound:277,shimotakaido_saturday_inbound:155,shimotakaido_weekday_inbound:156});
  assert.equal(base.length,1328);assert.equal(new Set(base.map(train=>train.id)).size,1328);
  for(const train of base){const table=seed.timetables.timetables[train.tableId], row=table.trains[train.raw.index];
    assert.deepEqual(train.raw.train,row);assert.deepEqual(train.raw.normalized,table.normalized_trains[train.raw.index]);
    assert.equal(train.type,row.type);assert.equal(train.direction,'inbound');
    assert.equal(train.stops[0].departure,C.parseServiceTime(row.departure,row.nextDay??row.next_day));
    assert.equal(train.serviceDay,table.dayType==='weekday'?'weekday':'holiday');assert.equal(train.verification.status,'unconfirmed');
  }
  assert.deepEqual(seed.timetables.timetables,seed.network.timetables);
});
test('元JSONとバンドルの完全性・各ファイルのSHA256',()=>{
  for(const item of read('manifest.json').files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../data',item.name))).digest('hex'),item.sha256);
  const context=require('node:vm').createContext({});require('node:vm').runInContext(fs.readFileSync(path.join(__dirname,'../data/seed.js'),'utf8'),context);
  assert.equal(JSON.stringify(context.RailwaySeed.timetables),JSON.stringify(seed.timetables));
});
test('走行時間31区間・方向差・未対応種別を区別',()=>{
  assert.equal(seed.network.travelTimeProfiles['各駅停車'].segments.length,31);
  assert.equal(C.runningTime(seed.network,'shimotakaido','sakurajosui','各駅停車').minutes,1);
  assert.equal(C.runningTime(seed.network,'sakurajosui','shimotakaido','各駅停車').minutes,1);
  assert.equal(C.runningTime(seed.network,'sakurajosui','shimotakaido','各駅停車',{allowReverse:true}).minutes,1);
  for(const type of ['快速','特急','区間急行','急行'])assert.equal(C.runningTime(seed.network,'sakurajosui','sasazuka',type),null);
});
test('重点3駅の上りは走行時間を参照せず、元の発車と到着未登録を保持',()=>{
  const noRuntime={...seed,get network(){throw Error('走行時間が混入しました');}};
  const result=C.query(base,noRuntime,{start:at('18:00:00'),end:at('20:00:00'),fromIds:['sakurajosui','shimotakaido','sasazuka'],destinationId:'新宿'});
  assert.ok(result.trains.length>0);assert.ok(result.trains.every(train=>train.source==='developer_provided'&&train.arrival===null&&train.legs.length===0));
  const train=base.find(train=>train.type==='各駅停車');const expanded=C.expandTrain(train,noRuntime.networkSafe,{mode:'simulation',allowReverse:true});
  assert.deepEqual(expanded.stops,train.stops);
});
test('確認操作なしで提供発車を使用し、旧モード設定は検索を制限しない',()=>{
  const initial=query(base);assert.ok(initial.trains.length>0);assert.ok(initial.trains.every(train=>train.arrivalMissing));
  const old=query(base,{settings:settings({mode:'practical',allowEstimated:false,allowReverse:false})});
  assert.deepEqual(old.trains.map(train=>train.id),initial.trains.map(train=>train.id));
  const row=user(1090,1100,{confirmed:false});assert.ok(query([row]).trains.some(train=>Number.isFinite(train.arrival)));
});
test('曜日混在なし・下りへ上りの提供時刻を転用しない・笹塚からも検索',()=>{
  const monday=query(base);assert.ok(monday.trains.every(train=>train.serviceDay==='weekday'));
  const sunday=new Date('2026-10-18T18:00:00+09:00').getTime();
  assert.ok(query(base,{start:sunday,end:sunday+7200000}).trains.every(train=>train.serviceDay==='holiday'));
  assert.equal(query(base,{destinationId:'京王八王子'}).trains.length,0);
  assert.ok(query(base,{fromIds:['sasazuka'],destinationId:'新宿'}).trains.length>0);
});
test('同一列車の根拠がないデータを自動統合しない・通過駅で乗降しない',()=>{
  assert.equal(base.filter(train=>train.stops.length!==1).length,0);
  const train=user();train.stops.splice(1,0,{stationId:'shimotakaido',arrival:1091,departure:1091,stop:false,arrivalSource:'user_entered',departureSource:'user_entered'});
  assert.equal(query([train],{fromIds:['shimotakaido']}).trains.length,0);
  assert.equal(query([train],{destinationId:'shimotakaido'}).trains.length,0);
});
test('追加・編集・削除・再読み込み・優先順位・リセット',()=>{
  const storage=memory(),store=C.blankStore(),train=user();C.upsert(store,train,base);
  assert.ok(C.effectiveTrains(base,store).some(row=>row.id===train.id));
  const original=base[0],edit={...C.clone(original),source:'user_entered',updatedAt:'2026-10-18',verification:{status:'confirmed',checkedAt:'2026-10-18'}};edit.stops[0].departure+=1;edit.stops[0].departureSource='user_entered';
  C.upsert(store,edit,base);assert.equal(C.effectiveTrains(base,store).find(row=>row.id===original.id).stops[0].departure,original.stops[0].departure+1);
  C.remove(store,original.id);C.saveStore(storage,store);
  assert.ok(!C.effectiveTrains(base,C.loadStore(storage)).some(row=>row.id===original.id));
  assert.equal(C.effectiveTrains(base,C.blankStore()).length,1328);
  assert.equal(original.stops[0].departure,C.parseServiceTime(original.raw.train.departure,original.raw.train.next_day));
});
test('一括登録は重複・不正値・矛盾を拒否し全件ロールバック',()=>{
  const store=C.blankStore(),defaults={stationId:'sakurajosui',line:'keio',direction:'inbound',serviceDay:'weekday',type:'各駅停車',destination:'新宿'};
  const result=C.bulkAdd(store,'18:03\n18:12,急行,新宿',defaults,base);assert.equal(result.added.length,2);assert.equal(result.added[0].stops.length,1);assert.equal(result.added[0].verification.status,'unconfirmed');
  assert.throws(()=>C.bulkAdd(store,'18:03\n18:03',defaults,base),/既にあります/);assert.equal(store.additions.length,0);
  assert.throws(()=>C.bulkAdd(store,'18:03\n25:99',defaults,base));
  const invalid=user(1100,1090);assert.ok(C.validateTrain(invalid).some(message=>message.includes('逆転')));
  const wrongDirection=user();wrongDirection.direction='outbound';assert.ok(C.validateTrain(wrongDirection).some(message=>message.includes('方向')));
  const wrongDestination=user();wrongDestination.destination='京王八王子';assert.ok(C.validateTrain(wrongDestination).some(message=>message.includes('行先')));
});
test('保存形式の版・エクスポート再取込・既存キー保全・徒歩記録',()=>{
  const storage=memory();storage.setItem('other-existing-key','keep');
  const store=C.blankStore();store.walking.history=[{stationId:'sakurajosui',seconds:540,date:'2026-10-18T00:00:00Z'}];store.walking.values.sakurajosui=9;
  C.saveStore(storage,store);const exported=JSON.stringify(C.loadStore(storage));const imported=JSON.parse(exported);assert.deepEqual(C.validateStore(imported),[]);
  assert.equal(storage.getItem('other-existing-key'),'keep');assert.equal(imported.walking.history[0].seconds,540);
  assert.ok(C.validateStore({...imported,version:999}).length);
  assert.ok(C.validateStore({...imported,additions:[{...user(),verification:{status:'confirmed',checkedAt:null}}]}).length);
});
test('サービス日24時以降・翌日平日へ誤分類しない',()=>{
  assert.equal(C.parseServiceTime('00:16',true),1456);assert.ok(C.parseServiceTime('24:05')>C.parseServiceTime('23:58'));
  const train=user(1450,1460,{serviceDay:'holiday'});const midnight=new Date('2026-10-19T00:00:00+09:00').getTime();
  const result=query([train],{start:midnight,end:midnight+7200000});assert.equal(result.trains.length,1);assert.equal(result.trains[0].serviceDay,'holiday');
  assert.equal(result.trains[0].departure,new Date('2026-10-19T00:10:00+09:00').getTime());
});
test('本線・支線生成800本の連続時刻・曜日・方向・単一モードでの利用',()=>{
  const all=['weekday','holiday'].flatMap(day=>C.generateSimulation(seed,day));assert.equal(all.length,800);
  for(const train of all){assert.equal(train.source,'simulated');assert.deepEqual(C.validateTrain(train),[]);assert.ok(train.stops.every(stop=>stop.stop));}
  const result=query(all,{fromIds:['明大前']});assert.ok(result.trains.length>0);assert.ok(result.trains.every(train=>train.simulation));
  assert.ok(query(all,{fromIds:['明大前'],settings:settings({mode:'practical'})}).trains.length>0);
  const store=C.blankStore();C.remove(store,all[0].id);const storage=memory();C.saveStore(storage,store);assert.equal(C.effectiveTrains(all,C.loadStore(storage)).length,799);
});
test('全路線の各駅から隣駅へ上下両方向で検索できる',()=>{
  const all=[...base,...['weekday','holiday'].flatMap(day=>C.generateSimulation(seed,day))];
  for(const names of Object.values(C.LINES))for(let i=0;i<names.length;i++)for(const delta of [-1,1]){
    if(!names[i+delta])continue;
    const from=C.stationId(names[i]),to=C.stationId(names[i+delta]);
    const result=query(all,{fromIds:[from],destinationId:to});
    assert.ok(result.trains.length,`${names[i]}→${names[i+delta]}`);
    if(!['sakurajosui','shimotakaido','sasazuka'].includes(from)||delta===1)assert.ok(result.trains.some(train=>Number.isFinite(train.arrival)),`${names[i]}→${names[i+delta]}の到着`);
  }
});
test('支線から新宿・支線相互・新線も乗換で接続し時刻が整合する',()=>{
  const all=[...base,...['weekday','holiday'].flatMap(day=>C.generateSimulation(seed,day))];
  for(const [from,to]of [['高尾山口','新宿'],['橋本','高尾山口'],['新線新宿','橋本'],['初台','新宿'],['新宿','高尾山口']]){
    const result=query(all,{fromIds:[from],destinationId:to});assert.ok(result.trains.length,from+'→'+to);
    const train=result.trains[0];assert.equal(train.legs[0].fromStationId,from);assert.equal(train.legs.at(-1).toStationId,to);assert.equal(train.arrival,train.legs.at(-1).arrival);
    for(let i=1;i<train.legs.length;i++){assert.equal(train.legs[i-1].toStationId,train.legs[i].fromStationId);assert.ok(train.legs[i].departure-train.legs[i-1].arrival>=60000);}
    assert.ok(train.simulation);
  }
});
test('他駅の深夜・土休日検索も日付と方向が整合する',()=>{
  const all=[...base,...['weekday','holiday'].flatMap(day=>C.generateSimulation(seed,day))];
  const start=new Date('2026-10-18T23:58:00+09:00').getTime();
  const result=query(all,{start,end:start+7200000,fromIds:['明大前'],destinationId:'sasazuka'});
  assert.ok(result.trains.length);assert.ok(result.trains.some(train=>new Date(train.arrival).getDate()===19));assert.ok(result.trains.every(train=>train.serviceDay==='holiday'));
});
