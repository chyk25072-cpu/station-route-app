// 新しい12表の完全性・曜日・方向・翌日フラグと、旧保存形式の引継ぎを検証する。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const C=require('../railway-core.js');
process.env.TZ='Asia/Tokyo';
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'../data',name),'utf8'));
const seed={timetables:read('keio_12_timetables.json'),network:read('keio_all_data.json')};
const base=C.ingest(seed).trains;
const at=value=>new Date(value+'+09:00').getTime();
function query(trains,start,from,destination,end=start+7200000,settings={}) {
  return C.query(trains,seed,{start,end,fromIds:[from],destinationId:destination,settings}).trains;
}

test('12表・2330件と元の発車・種別・行先・全フィールドを保持',()=>{
  assert.equal(base.length,2330);assert.equal(new Set(base.map(t=>t.id)).size,2330);
  assert.equal(Object.keys(seed.timetables.timetables).length,12);
  const expected=[251,240,226,223,226,223,156,161,155,157,155,157];
  assert.deepEqual(Object.values(seed.timetables.timetables).map(t=>t.trains.length),expected);
  for(const train of base) {
    const table=seed.timetables.timetables[train.tableId],row=table.trains[train.raw.index];
    assert.equal(table.count,table.trains.length);assert.deepEqual(train.raw.train,row);
    assert.equal(train.type,row.type);assert.equal(train.destination,row.destination_raw);
    assert.equal(train.destinationRaw,row.destination_raw);assert.equal(train.serviceDay,table.dayType);
    assert.equal(train.direction,table.direction==='新宿方面'?'inbound':'outbound');
    assert.equal(train.stops[0].departure,C.parseServiceTime(row.departure,row.next_day));
    assert.equal(train.stops[0].arrival,null);assert.equal(train.stops.length,1);
    assert.deepEqual(C.validateTrain(train),[]);
  }
  // 添付原本のSHA256。元JSONのバイトを変更していないことも確認する。
  const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../data/keio_12_timetables.json'))).digest('hex');
  assert.equal(hash,'6344938f7f7c95426565b55d56e3cebe40c8a61ddd92db174142aa8a66b1428a');
  assert.equal(base.filter(t=>t.anchorStationId==='sasazuka').length,0);
});

test('上下線×平日・土曜・日曜の全発車を確認操作なしで検索',()=>{
  const dates={weekday:'2026-10-23',saturday:'2026-10-24',sunday:'2026-10-25'};
  for(const [id,table]of Object.entries(seed.timetables.timetables)) {
    const start=at(dates[table.dayType]+'T04:00:00'),end=start+21*60*C.MINUTE;
    const inbound=table.direction==='新宿方面';
    const rows=query(base,start,table.stationId,inbound?'sasazuka':'八幡山',end);
    assert.equal(rows.length,table.trains.length,id);
    assert.ok(rows.every(row=>row.trainId.startsWith('provided:'+id+':')&&row.serviceDay===table.dayType));
    for(const result of rows) {
      const train=base.find(t=>t.id===result.trainId);
      assert.equal(result.type,train.raw.train.type);assert.equal(result.trainDestination,train.raw.train.destination_raw);
      assert.equal(result.arrival,null);assert.equal('simulation' in result,false);
      assert.equal(result.destinationUnverified,!inbound);
    }
  }
});

test('2駅の発車を維持し、削除後も復活しない。API結果なしでは予測を捏造しない',()=>{
  const all=base;
  for(const date of ['2026-10-23','2026-10-24','2026-10-25'])for(const from of ['sakurajosui','shimotakaido'])for(const to of ['sasazuka','八幡山']) {
    const start=at(date+'T18:00:00'),rows=query(all,start,from,to);
    assert.ok(rows.length);assert.ok(rows.every(t=>t.source==='developer_provided'&&t.arrival===null));
    const store=C.blankStore();for(const row of rows)C.remove(store,row.trainId);
    assert.equal(query(C.effectiveTrains(all,store),start,from,to).length,0);
  }
  const noRuntime={...seed,get network(){throw Error('到着計算への走行時間混入');}};
  const start=at('2026-10-23T18:00:00');
  const rows=C.query(base,noRuntime,{start,end:start+7200000,fromIds:['sakurajosui','shimotakaido'],destinationId:'八幡山'}).trains;
  assert.ok(rows.length);assert.ok(rows.every(t=>t.arrival===null&&t.destinationUnverified));
  const sasazuka=query(all,start,'sasazuka','新宿');
  assert.equal(sasazuka.length,0);
});

test('00時台は前営業日の平日・土曜・日曜を使い、発車一致は可・1秒後は不可',()=>{
  for(const [date,day,departure]of [['2026-10-24','weekday','00:18:00'],['2026-10-25','saturday','00:17:00'],['2026-10-26','sunday','00:17:00']]) {
    const start=at(date+'T00:00:00');const rows=query(base,start,'shimotakaido','sasazuka');
    assert.equal(rows.length,1);assert.equal(rows[0].serviceDay,day);
    assert.equal(rows[0].departure,at(date+'T'+departure));
    assert.equal(query(base,rows[0].departure,'shimotakaido','sasazuka').length,1);
    assert.equal(query(base,rows[0].departure+1000,'shimotakaido','sasazuka').length,0);
    const outbound=query(base,start,'shimotakaido','八幡山');
    assert.equal(outbound.length,7);assert.ok(outbound.every(t=>t.serviceDay===day));
    assert.equal(outbound.at(-1).departure,at(date+'T00:52:00'));
  }
  const start=at('2026-10-23T23:55:00');
  assert.ok(query(base,start,'sakurajosui','八幡山').some(t=>t.departure===at('2026-10-24T00:31:00')));
});

test('曜日の自動・手動選択。旧土休日の利用者入力も両週末に使用',()=>{
  assert.equal(C.dayType(new Date(at('2026-10-23T12:00:00'))),'weekday');
  assert.equal(C.dayType(new Date(at('2026-10-24T12:00:00'))),'saturday');
  assert.equal(C.dayType(new Date(at('2026-10-25T12:00:00'))),'sunday');
  const start=at('2026-10-23T18:00:00');
  for(const day of ['saturday','sunday'])assert.ok(query(base,start,'sakurajosui','sasazuka',start+7200000,{dayType:day}).every(t=>t.serviceDay===day));
  const user=C.makeUserTrain({stationId:'sakurajosui',line:'keio',serviceDay:'holiday',direction:'inbound',type:'各駅停車',destination:'笹塚',stops:C.parseStopLines('桜上水,,18:01,停車\n笹塚,18:05,,停車')});
  for(const date of ['2026-10-24','2026-10-25']) {
    const rows=query([user],at(date+'T18:00:00'),'sakurajosui','sasazuka');
    assert.equal(rows.length,1);assert.equal(rows[0].trainId,user.id);
  }
});

test('旧4表の参照先は同じ列車。土休日の編集・削除を両日に継承し徒歩保存を保持',()=>{
  const old=C.blankStore();delete old.settings.timetableRevision;old.settings.dayType='holiday';
  const train=C.clone(base.find(t=>t.tableId==='sakurajosui_saturday_inbound'));train.serviceDay='holiday';
  const edit={...C.clone(train),source:'user_entered'};edit.stops[0].departure+=1;
  old.updates[edit.id]=edit;old.deleted=['provided:shimotakaido_saturday_inbound:0'];
  old.walking.history=[{id:'walk:old',stationId:'sakurajosui',seconds:540,date:'2026-10-18'}];
  const migrated=C.adaptStore(old,seed),effective=C.effectiveTrains(base,migrated);
  assert.equal(migrated.settings.dayType,'sunday');assert.equal(migrated.settings.timetableRevision,3);
  for(const day of ['saturday','sunday']) {
    const id=edit.id.replace('saturday',day),row=effective.find(t=>t.id===id);
    assert.equal(row.serviceDay,day);assert.equal(row.stops[0].departure,edit.stops[0].departure);
    assert.ok(!effective.some(t=>t.id==='provided:shimotakaido_'+day+'_inbound:0'));
  }
  assert.deepEqual(migrated.walking,old.walking);assert.deepEqual(C.validateStore(migrated),[]);
  assert.deepEqual(C.adaptStore(migrated,seed),migrated);
  // 移行後の土曜だけの削除は日曜には波及しない。
  const current=C.blankStore();current.deleted=['provided:shimotakaido_saturday_inbound:0'];
  assert.deepEqual(C.adaptStore(current,seed).deleted,current.deleted);
});

