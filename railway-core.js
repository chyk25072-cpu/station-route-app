/* データ変換・推定・保存差分・検索。DOMに依存しない共通処理。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RailwayCore = api;
})(globalThis, function () {
  'use strict';
  const VERSION = 1;
  const KEY = 'station-route.timetables.v1';
  const MINUTE = 60000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const pad = value => String(value).padStart(2, '0');
  const SOURCES = ['developer_provided', 'user_entered', 'estimated'];
  const FOCUS_STATIONS = ['sakurajosui','shimotakaido'];
  const isFocusStation = id => FOCUS_STATIONS.includes(id);
  const LINES = {
    keio: ['新宿','笹塚','代田橋','明大前','下高井戸','桜上水','上北沢','八幡山','芦花公園','千歳烏山','仙川','つつじヶ丘','柴崎','国領','布田','調布','西調布','飛田給','武蔵野台','多磨霊園','東府中','府中','分倍河原','中河原','聖蹟桜ヶ丘','百草園','高幡不動','南平','平山城址公園','長沼','北野','京王八王子'],
    takao: ['北野','京王片倉','山田','めじろ台','狭間','高尾','高尾山口'],
    sagamihara: ['調布','京王多摩川','京王稲田堤','京王よみうりランド','稲城','若葉台','京王永山','京王多摩センター','京王堀之内','南大沢','多摩境','橋本'],
    new: ['新線新宿','初台','幡ヶ谷','笹塚']
  };
  const stationId = name => ({'桜上水':'sakurajosui','下高井戸':'shimotakaido','笹塚':'sasazuka'}[name] || name);
  const stationName = id => ({sakurajosui:'桜上水',shimotakaido:'下高井戸',sasazuka:'笹塚'}[id] || id);
  const allStations = [...new Set(Object.values(LINES).flat())].map(name => ({id: stationId(name), name}));
  function parseServiceTime(value, nextDay = false) {
    if (typeof value !== 'string' || !/^\d{1,2}:[0-5]\d(?::[0-5]\d)?$/.test(value)) throw Error('時刻はHH:MM[:SS]形式です');
    const [h,m,s=0] = value.split(':').map(Number);
    if (h > 47) throw Error('時は00〜47で入力してください');
    return h * 60 + m + s / 60 + (nextDay && h < 24 ? 1440 : 0);
  }
  function serviceTime(value) {
    if (value === null || value === undefined) return '';
    const seconds = Math.round(value * 60);
    return `${pad(Math.floor(seconds/3600))}:${pad(Math.floor(seconds/60)%60)}:${pad(seconds%60)}`;
  }
  function dayType(date, override = 'auto') {
    // 旧保存設定holidayは日曜ダイヤの指定として引き継ぐ。
    return override !== 'auto' ? (override==='holiday'?'sunday':override) :
      date.getDay()===6 ? 'saturday' : date.getDay()===0 ? 'sunday' : 'weekday';
  }
  function matchesDay(stored, selected) {
    return stored===selected || stored==='holiday'&&['saturday','sunday'].includes(selected);
  }
  function tableDay(seed, table) {
    // 以前の6表は土休日共通、新しい12表は土曜・日曜を独立管理。
    return seed.timetables.schemaVersion===3 ? table.dayType : table.dayType==='weekday'?'weekday':'holiday';
  }
  function tableDirection(table) {
    if(table.direction==='新宿方面')return 'inbound';
    if(table.direction==='京王八王子方面')return 'outbound';
    throw Error('時刻表の方向が不正です: '+table.direction);
  }
  function hasProvidedTimetable(seed, station, direction, serviceDay, line='keio') {
    return line==='keio'&&Object.values(seed.timetables.timetables).some(table=>
      table.stationId===station&&tableDirection(table)===direction&&matchesDay(tableDay(seed,table),serviceDay));
  }
  function blankStore() {
    return { version: VERSION, additions: [], updates: {}, deleted: [], confirmations: {},
      settings: {dayType:'auto', showSeconds:true, timetableRevision:3},
      walking: { history: [], active: null, values: {}, appliedAverages: {} } };
  }
  function normalizedDestination(row) {
    if (row.destination) return row.destination;
    const names = row.destination_raw?.match(/本八幡|大島|新線新宿|新宿/g);
    return names?.at(-1) || row.destination_raw || '不明';
  }
  function terminalStation(train, aliases={}) {
    // 表示用の行先は原文を保持する。略称の意味はJSONにないので推測しない。
    const original=train.raw?.train;
    if(original?.destination_is_abbreviation&&train.destination===original.destination_raw){
      const alias=aliases[train.destination];
      const name=typeof alias==='string'?alias:alias?.terminal;
      return typeof name==='string'&&allStations.some(station=>station.id===stationId(name))?stationId(name):null;
    }
    const name=normalizedDestination({destination_raw:train.destination}).replace(/行き$/, '');
    return stationId(['本八幡','大島'].includes(name)?'新線新宿':name);
  }
  function ingest(seed) {
    if (!seed?.timetables?.timetables || !seed.network?.travelTimeProfiles) throw Error('提供JSONの形式が不正です');
    const trains = [], counts = {}, issues = [];
    for (const [tableId,table] of Object.entries(seed.timetables.timetables)) {
      if (!Array.isArray(table.trains) || !['weekday','saturday','sunday'].includes(table.dayType)) throw Error(`時刻表形式・曜日が不正: ${tableId}`);
      if(!isFocusStation(table.stationId))continue;
      const direction=tableDirection(table);
      counts[tableId] = table.trains.length;
      table.trains.forEach((row,index) => {
        const departure = parseServiceTime(row.departure, row.nextDay ?? row.next_day);
        const rawNormalized = table.normalized_trains?.[index];
        const id = `provided:${tableId}:${index}`; // IDがないので駅間の同一列車を統合しない。
        const destination=row.destination_raw ?? rawNormalized?.destination_raw ?? row.destination;
        trains.push({ id, tableId, serviceDay:tableDay(seed,table), line:'keio',
          direction, type:row.type, origin:row.origin ? table.stationId : null,
          destination, destinationRaw:destination,
          anchorStationId:table.stationId, source:'developer_provided',
          verification:{status:'unconfirmed', checkedAt:null}, updatedAt:null,
          stops:[{stationId:table.stationId, arrival:null, departure, arrivalSource:null, departureSource:'developer_provided', stop:true}],
          raw:{tableId,index,train:clone(row),normalized:rawNormalized ? clone(rawNormalized):null, tableStatus:table.status, tableSource:table.source ?? null}
        });
      });
    }
    issues.push('提供時刻表は公式照合日と列車IDがなく、駅をまたぐ同一列車の統合は行いません。');
    issues.push('到着予測には列車種別に対応する駅間平均走行時間が必要です。');
    issues.push('快速・特急・区間急行・急行は停車駅対応未検証。自動到着計算の対象外です。');
    issues.push('土曜・日曜を自動選択します。祝日は「日曜」を手動選択してください。');
    return {trains, counts, issues};
  }
  function effectiveTrains(base, store) {
    const removed = new Set(store.deleted);
    return [...base.filter(train => !removed.has(train.id)).map(train => clone(store.updates[train.id] || train)),
      ...store.additions.filter(train => !removed.has(train.id)).map(clone)].map(train => {
      const confirmation = store.confirmations[train.tableId];
      if (train.source === 'developer_provided' && confirmation) train.verification = clone(confirmation);
      return train;
    });
  }
  function adaptStore(store, seed) {
    if(seed.timetables.schemaVersion!==3)return store;
    const result=clone(store);
    if(result.settings.dayType==='holiday')result.settings.dayType='sunday';
    if(result.settings.timetableRevision===3)return result;
    // 新旧で発車・種別・行先が一致している4表のIDを維持する。
    // 旧「土休日」の土曜表への編集・削除は、分離した日曜表にも引き継ぐ。
    const ids=new Set(ingest(seed).trains.map(train=>train.id));
    for(const [id,train]of Object.entries(result.updates)) {
      if(train.serviceDay!=='holiday'||!id.includes('_saturday_')||!ids.has(id))continue;
      const sundayId=id.replace('_saturday_','_sunday_');
      train.serviceDay='saturday';
      if(ids.has(sundayId)&&!result.updates[sundayId])result.updates[sundayId]={...clone(train),id:sundayId,
        tableId:train.tableId?.replace('_saturday_','_sunday_'),serviceDay:'sunday'};
    }
    for(const id of [...result.deleted]) {
      const sundayId=id.replace('_saturday_','_sunday_');
      if(id.includes('_saturday_')&&ids.has(id)&&ids.has(sundayId)&&!result.deleted.includes(sundayId))result.deleted.push(sundayId);
    }
    // 運行日を分離したことを保存し、二重移行を防ぐ。
    result.settings.timetableRevision=3;
    return result;
  }
  function findPath(from, to) {
    if (from === to) return [from];
    const graph = new Map();
    for (const line of Object.values(LINES)) for (let i=1;i<line.length;i++) {
      const a=stationId(line[i-1]), b=stationId(line[i]);
      if (!graph.has(a)) graph.set(a, []);
      if (!graph.has(b)) graph.set(b, []);
      graph.get(a).push(b); graph.get(b).push(a);
    }
    const queue=[[from]], visited=new Set([from]);
    while(queue.length) {
      const path=queue.shift();
      for(const neighbor of graph.get(path.at(-1)) || []) {
        if (neighbor===to) return [...path,neighbor];
        if (!visited.has(neighbor)) {visited.add(neighbor);queue.push([...path,neighbor]);}
      }
    }
    return null;
  }
  function edgeDirection(from,to) {
    for (const line of Object.values(LINES)) {
      const a=line.indexOf(stationName(from)), b=line.indexOf(stationName(to));
      if(a>=0&&b>=0&&Math.abs(a-b)===1) return b>a?'outbound':'inbound';
    }
    return null;
  }
  // 保存済みの駅間平均。対応する駅名が明記された区間だけを取得する。
  function runningTime(network, from, to, type) {
    const profile=network.travelTimeProfiles[type];
    if(profile?.segmentMapping!=='adjacent_stations')return null;
    const edge=profile.segments.find(item=>item.from===stationName(from)&&item.to===stationName(to)||item.from===stationName(to)&&item.to===stationName(from));
    return edge&&Number.isFinite(edge.minutes)&&edge.minutes>0 ? {minutes:edge.minutes,source:'estimated'} : null;
  }
  function walkingAverage(store, station) {
    const rows=store.walking.history.filter(row=>row.stationId===station);
    return rows.length?rows.reduce((sum,row)=>sum+row.seconds,0)/rows.length:null;
  }
  function pruneStore(store) {
    const result=clone(store);
    // 旧データは読み込み時に一度整理し、他駅の時刻表や旧生成列車を残さない。
    const keep=train=>isFocusStation(train?.anchorStationId)&&!train.id.startsWith('sim:');
    result.additions=result.additions.filter(keep);
    result.updates=Object.fromEntries(Object.entries(result.updates).filter(([,train])=>keep(train)));
    const users=new Set(result.additions.map(train=>train.id));
    result.deleted=result.deleted.filter(id=>typeof id==='string'&&(/^(provided):(sakurajosui|shimotakaido)_/.test(id)||users.has(id)));
    result.confirmations=Object.fromEntries(Object.entries(result.confirmations).filter(([id])=>/^(sakurajosui|shimotakaido)_/.test(id)));
    for(const key of ['mode','dataset','allowEstimated','allowReverse'])delete result.settings[key];
    const destination=result.settings.search?.destination;
    result.settings.search={destination:allStations.some(station=>station.id===destination)?destination:'sasazuka'};
    if(result.walking.active&&!isFocusStation(result.walking.active.stationId))result.walking.active=null;
    result.walking.appliedAverages ||= {};
    result.walking.history=result.walking.history.map(row=>({...row,id:row.id||'walk:'+(globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2))}));
    return result;
  }
  function validDate(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(value)||!Number.isFinite(Date.parse(value)))return false;
    const [year,month,day]=value.slice(0,10).split('-').map(Number), date=new Date(0);
    date.setUTCFullYear(year,month-1,day);
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
  }
  function validateTrain(train) {
    const errors=[];
    if (!train || typeof train!=='object') return ['列車データが不正です'];
    if(typeof train.id!=='string'||!train.id||train.id.length>300) errors.push('列車IDが不正です');
    if(!isFocusStation(train.anchorStationId))errors.push('時刻表の登録対象は桜上水・下高井戸です');
    if(!['weekday','saturday','sunday','holiday'].includes(train.serviceDay)||!['inbound','outbound'].includes(train.direction)||!Object.hasOwn(LINES,train.line)) errors.push('曜日・路線・方向が不正です');
    if(!['各駅停車','快速','区間急行','急行','特急'].includes(train.type)||typeof train.destination!=='string'||!train.destination||train.destination.length>200) errors.push('種別・行先が不正です');
    if(!SOURCES.includes(train.source)||!['confirmed','unconfirmed'].includes(train.verification?.status)) errors.push('出典・確認状態が不正です');
    if(train.origin!==null&&!allStations.some(station=>station.id===train.origin)) errors.push('始発駅が不正です（不明ならnull）');
    if(train.verification?.status==='confirmed'&&!validDate(train.verification.checkedAt)) errors.push('確認日が必要です');
    if(!Array.isArray(train.stops)||train.stops.length===0||train.stops.length>100) return [...errors,'停車駅が不正です'];
    const seen=new Set(); let previous=null;
    for(const stop of train.stops) {
      if(!allStations.some(station=>station.id===stop.stationId)||seen.has(stop.stationId)) errors.push('駅名が不正、または駅が重複しています');
      seen.add(stop.stationId);
      if(typeof stop.stop!=='boolean') errors.push('停車・通過の指定が必要です');
      for(const field of ['arrival','departure']) {
        if(stop[field]!==null && (!Number.isFinite(stop[field])||stop[field]<0||stop[field]>=2880)) errors.push('時刻は00:00〜47:59:59の範囲です');
        if(stop[field]!==null&&!SOURCES.includes(stop[`${field}Source`])) errors.push('時刻ごとの出典が必要です');
      }
      if(stop.arrival!==null&&stop.departure!==null&&stop.arrival>stop.departure) errors.push('到着時刻が発車時刻より後です');
      const first=stop.arrival??stop.departure;
      if(previous!==null&&first!==null&&first<previous) errors.push('駅間の時刻が逆転しています（翌日は24時表記）');
      previous=stop.departure??stop.arrival??previous;
    }
    for(let i=1;i<train.stops.length;i++) {
      const path=findPath(train.stops[i-1].stationId,train.stops[i].stationId);
      if(!path||path.some((id,j)=>j>0&&edgeDirection(path[j-1],id)!==train.direction)) errors.push('停車駅の順序が運行方向と一致しません');
    }
    const terminal=terminalStation(train);
    if(allStations.some(station=>station.id===terminal)) {
      const path=findPath(train.stops[0].stationId,terminal);
      if(!path||path.some((id,index)=>index>0&&edgeDirection(path[index-1],id)!==train.direction)||train.stops.some(stop=>!path.includes(stop.stationId))) errors.push('行先と運行方向・駅別経路が矛盾しています');
    }
    if(!train.stops.some(stop=>stop.stop&&stop.departure!==null)) errors.push('乗車可能な発車駅がありません');
    return [...new Set(errors)];
  }
  function validateStore(value) {
    const errors=[];
    if(!value||value.version!==VERSION) return ['保存形式のバージョンが未対応です'];
    if(!Array.isArray(value.additions)||!value.updates||typeof value.updates!=='object'||Array.isArray(value.updates)||!Array.isArray(value.deleted)||!value.confirmations||typeof value.confirmations!=='object') return ['追加・更新・削除・確認状態の形式が不正です'];
    const additions=new Set();
    for(const train of [...value.additions,...Object.values(value.updates)]) errors.push(...validateTrain(train));
    if(errors.length)return [...new Set(errors)];
    for(const train of value.additions) {if(additions.has(train.id)||!train.id.startsWith('user:')||train.source!=='user_entered') errors.push('追加列車ID・出典の重複または形式エラー');additions.add(train.id);}
    for(const [id,train]of Object.entries(value.updates)) if(id!==train.id||!id.startsWith('provided:')||train.source!=='user_entered') errors.push('更新列車ID・出典が不正です');
    if(value.deleted.some(id=>typeof id!=='string'||!['provided:','user:'].some(prefix=>id.startsWith(prefix)))||new Set(value.deleted).size!==value.deleted.length) errors.push('削除IDが不正です');
    for(const confirmation of Object.values(value.confirmations)) if(confirmation?.status!=='confirmed'||!validDate(confirmation.checkedAt)) errors.push('確認状態・確認日が不正です');
    const settings=value.settings;
    if(!settings||!['auto','weekday','saturday','sunday','holiday'].includes(settings.dayType)||typeof settings.showSeconds!=='boolean') errors.push('設定が不正です');
    const walking=value.walking;
    if(!walking||!Array.isArray(walking.history)||walking.history.some(row=>!row||!allStations.some(station=>station.id===row.stationId)||!Number.isFinite(row.seconds)||row.seconds<=0||row.seconds>7200||!validDate(row.date))) errors.push('徒歩記録が不正です');
    if(walking?.active && (!allStations.some(station=>station.id===walking.active.stationId)||!Number.isFinite(walking.active.startedAt))) errors.push('計測中データが不正です');
    if(!walking?.values||Object.values(walking.values).some(value=>!Number.isInteger(value)||value<0||value>120)) errors.push('徒歩時間設定が不正です');
    if(Array.isArray(walking?.history)&&(walking.history.some(row=>typeof row?.id!=='string'||!row.id||row.id.length>200)||new Set(walking.history.map(row=>row?.id)).size!==walking.history.length))errors.push('徒歩記録IDが不正、または重複しています');
    if(!walking?.appliedAverages||Array.isArray(walking.appliedAverages)||typeof walking.appliedAverages!=='object'||Object.entries(walking.appliedAverages).some(([id,value])=>!isFocusStation(id)||typeof value!=='boolean'))errors.push('平均徒歩時間の設定が不正です');
    return [...new Set(errors)];
  }
  function loadStore(storage, seed) {
    const raw=storage?.getItem(KEY);
    if(!raw) return blankStore();
    let value=JSON.parse(raw);
    if(value?.version===VERSION&&Array.isArray(value.additions)&&value.updates&&Array.isArray(value.deleted)&&value.confirmations&&value.settings&&Array.isArray(value.walking?.history))value=pruneStore(seed?adaptStore(value,seed):value);
    const errors=validateStore(value);
    if(errors.length) throw Error(errors.join(' / '));
    return value;
  }
  function saveStore(storage,store) {
    const errors=validateStore(store);
    if(errors.length) throw Error(errors.join(' / '));
    storage.setItem(KEY,JSON.stringify(store));
  }
  function upsert(store,train,base) {
    const errors=validateTrain(train);
    if(errors.length) throw Error(errors.join(' / '));
    const other=effectiveTrains(base,store).filter(item=>item.id!==train.id);
    const signature=item=>JSON.stringify([item.serviceDay,item.direction,item.type,item.destination,item.stops.filter(s=>s.stop&&s.departure!==null).map(s=>[s.stationId,s.departure])]);
    if(other.some(item=>signature(item)===signature(train))) throw Error('同じ駅・曜日・方向・種別・行先・発車時刻の列車が既にあります');
    if(base.some(item=>item.id===train.id)) store.updates[train.id]=clone(train);
    else {
      if(!train.id.startsWith('user:')) throw Error('追加列車IDはuser:で始めてください');
      const index=store.additions.findIndex(item=>item.id===train.id);
      if(index<0) store.additions.push(clone(train)); else store.additions[index]=clone(train);
    }
    store.deleted=store.deleted.filter(id=>id!==train.id);
  }
  function remove(store,id) {
    if(!store.deleted.includes(id)) store.deleted.push(id);
    store.additions=store.additions.filter(train=>train.id!==id);
    delete store.updates[id];
  }
  function makeUserTrain({id,stationId:anchor,line,serviceDay,direction,type,destination,stops,origin=null,confirmed=false,checkedAt=null}) {
    return {id:id||`user:${globalThis.crypto?.randomUUID?.() || Date.now()+'-'+Math.random().toString(36).slice(2)}`,line,serviceDay,direction,type,destination,origin,anchorStationId:anchor,
      stops,source:'user_entered',verification:{status:confirmed?'confirmed':'unconfirmed',checkedAt:confirmed?checkedAt:null},updatedAt:new Date().toISOString()};
  }
  function parseStopLines(text) {
    return text.trim().split(/\r?\n/).filter(line=>line.trim()).map(line=>{
      const [name,arrival='',departure='',status='停車']=line.split(',').map(part=>part.trim());
      if(!name||!['停車','通過'].includes(status)) throw Error('駅,到着,発車,停車（または通過）の形式で入力してください');
      return {stationId:stationId(name),arrival:arrival?parseServiceTime(arrival):null,departure:departure?parseServiceTime(departure):null,stop:status==='停車',arrivalSource:arrival?'user_entered':null,departureSource:departure?'user_entered':null};
    });
  }
  function bulkAdd(store,text,defaults,base) {
    const next=clone(store), added=[];
    for(const line of text.trim().split(/\r?\n/).filter(line=>line.trim())) {
      const [time,type=defaults.type,destination=defaults.destination,...extra]=line.split(',').map(part=>part.trim());
      if(extra.length) throw Error('一括登録は時刻,種別,行先の3項目までです');
      const departure=parseServiceTime(time);
      const train=makeUserTrain({...defaults,type,destination,stops:[{stationId:defaults.stationId,arrival:null,departure,stop:true,arrivalSource:null,departureSource:'user_entered'}]});
      upsert(next,train,base); added.push(train);
    }
    if(!added.length) throw Error('時刻を入力してください');
    return {store:next,added}; // 一行でも不正なら全件ロールバック。
  }
  function timestamp(date,minutes) {
    const midnight=new Date(date);midnight.setHours(0,0,0,0);
    return midnight.getTime()+Math.round(minutes*MINUTE);
  }
  function predictionSegments(train, from, to, aliases={}) {
    const path=findPath(from,to);if(!path||path.length<2)return [];
    const alias=train.destination===train.raw?.train?.destination_raw?aliases[train.destination]:null;
    const change=alias&&typeof alias==='object'?stationId(alias.changesAt):null;
    const edgeLine=(a,b)=>Object.entries(LINES).find(([,names])=>names.includes(stationName(a))&&names.includes(stationName(b)))?.[0];
    const segments=[];let start=from,type=train.type,line=edgeLine(path[0],path[1]);
    for(let i=1;i<path.length-1;i++) {
      const nextLine=edgeLine(path[i],path[i+1]);
      if(nextLine!==line||path[i]===change) {
        segments.push({from:start,to:path[i],type});start=path[i];line=nextLine;
        if(path[i]===change)type=alias.typeAfter;
      }
    }
    segments.push({from:start,to,type});return segments;
  }
  const predictionKey=(from,to,type,direction,date='',segments=[])=>[from,to,type,direction,date,JSON.stringify(segments)].join(':');
  function query(trains,seed,{start,end,fromIds=FOCUS_STATIONS,destinationId,settings={}}) {
    const departures=[],reasons=new Set();
    const firstDate=new Date(start);firstDate.setHours(0,0,0,0);firstDate.setDate(firstDate.getDate()-1);
    const lastDate=new Date(end);lastDate.setHours(0,0,0,0);
    for(const date=new Date(firstDate);date<=lastDate;date.setDate(date.getDate()+1)) {
      const serviceDay=dayType(date,settings.dayType||'auto');
      const key=date.getFullYear()+'-'+(date.getMonth()+1)+'-'+date.getDate();
      const operatingDate=String(date.getFullYear())+pad(date.getMonth()+1)+pad(date.getDate());
      for(const raw of trains) {
        if(!isFocusStation(raw.anchorStationId)||!SOURCES.includes(raw.source)||!matchesDay(raw.serviceDay,serviceDay))continue;
        for(const fromId of fromIds.filter(isFocusStation)) {
          const boarding=raw.stops.find(stop=>stop.stationId===fromId&&stop.stop&&stop.departure!==null);
          if(!boarding||fromId!==raw.anchorStationId||fromId===destinationId)continue;
          const departure=timestamp(date,boarding.departure);
          if(departure<start||departure>end)continue;
          const desired=findPath(fromId,destinationId);
          if(!desired||desired.length<2||edgeDirection(desired[0],desired[1])!==raw.direction)continue;
          const index=raw.stops.indexOf(boarding),target=raw.stops.slice(index+1).find(stop=>stop.stationId===destinationId);
          if(target&&!target.stop)continue;
          const terminal=terminalStation(raw,settings.destinationAliases),path=terminal?findPath(fromId,terminal):null;
          if(!target&&terminal!==null&&(!path||path.indexOf(destinationId)<=0))continue;
          let arrival=target?.arrival===null||target?.arrival===undefined?null:timestamp(date,target.arrival);
          let arrivalSource=arrival===null?null:target.arrivalSource;
          const segments=predictionSegments(raw,fromId,destinationId,settings.destinationAliases);
          const prediction=settings.predictions?.[predictionKey(fromId,destinationId,raw.type,raw.direction,operatingDate,segments)];
          if(arrival===null&&prediction?.notServed){reasons.add(stationName(fromId)+'：'+raw.type+'の目的駅への停車を確認できません');continue;}
          // 元の登録時刻を優先。行先の略称が不明な列車に架空の直通経路を与えない。
          const destinationUnverified=terminal===null&&!target;
          if(arrival===null&&!destinationUnverified&&prediction&&Number.isFinite(prediction.minutes)&&prediction.minutes>0) {
            arrival=departure+Math.round(prediction.minutes*MINUTE);arrivalSource='estimated';
          }
          if(arrival!==null&&arrival<departure) {reasons.add(stationName(fromId)+'：到着時刻が発車より前です');continue;}
          if(arrival===null)reasons.add(stationName(fromId)+(destinationUnverified?'：行先略称の対応情報がなく、目的駅までの運行を確認できません':'：到着予測に必要な平均走行時間を取得できません'));
          departures.push({id:raw.id+':'+key+':'+fromId,trainId:raw.id,stationId:fromId,departureStation:stationName(fromId),departure,arrival,
            type:raw.type,direction:raw.direction,operatingDate,destination:stationName(destinationId),trainDestination:raw.destination,destinationUnverified,
            source:raw.source,arrivalSource,serviceDay:raw.serviceDay,arrivalMissing:arrival===null,
            prediction:arrivalSource==='estimated'?prediction:null,predictionSegments:segments,legs:[]});
        }
      }
    }
    return {trains:departures.sort((a,b)=>a.departure-b.departure||a.id.localeCompare(b.id)),reasons:[...reasons]};
  }
  return {VERSION,KEY,MINUTE,LINES,FOCUS_STATIONS,isFocusStation,allStations,stationId,stationName,parseServiceTime,serviceTime,dayType,matchesDay,hasProvidedTimetable,blankStore,ingest,effectiveTrains,adaptStore,pruneStore,walkingAverage,findPath,edgeDirection,runningTime,terminalStation,predictionSegments,predictionKey,
    validateTrain,validateStore,loadStore,saveStore,upsert,remove,makeUserTrain,parseStopLines,bulkAdd,query,clone};
});
