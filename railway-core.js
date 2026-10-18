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
  const SOURCES = ['developer_provided', 'user_entered', 'estimated', 'simulated'];
  const LINES = {
    keio: ['新宿','笹塚','代田橋','明大前','下高井戸','桜上水','上北沢','八幡山','芦花公園','千歳烏山','仙川','つつじヶ丘','柴崎','国領','布田','調布','西調布','飛田給','武蔵野台','多磨霊園','東府中','府中','分倍河原','中河原','聖蹟桜ヶ丘','百草園','高幡不動','南平','平山城址公園','長沼','北野','京王八王子'],
    takao: ['北野','京王片倉','山田','めじろ台','狭間','高尾','高尾山口'],
    sagamihara: ['調布','京王多摩川','京王稲田堤','京王よみうりランド','稲城','若葉台','京王永山','京王多摩センター','京王堀之内','南大沢','多摩境','橋本'],
    new: ['新線新宿','初台','幡ヶ谷','笹塚']
  };
  const stationId = name => ({'桜上水':'sakurajosui','下高井戸':'shimotakaido','笹塚':'sasazuka'}[name] || name);
  const stationName = id => ({sakurajosui:'桜上水',shimotakaido:'下高井戸',sasazuka:'笹塚'}[id] || id);
  const allStations = [...new Set(Object.values(LINES).flat())].map(name => ({id: stationId(name), name}));
  // 以下は実ダイヤの再現ではなく、変更可能なシミュレーション設定。
  const ASSUMPTIONS = { dwellMinutes: 0.5, branchMinutes: 3, transferMinutes: 1,
    intervalWeekday: 20, intervalHoliday: 30,
    note: '停車30秒。支線の未提供区間3分。未対応種別は生成しない。運行間隔は平日20分・土休日30分の仮定。' };
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
    return override !== 'auto' ? override : [0,6].includes(date.getDay()) ? 'holiday' : 'weekday';
  }
  function blankStore() {
    return { version: VERSION, additions: [], updates: {}, deleted: [], confirmations: {},
      settings: {mode:'simulation', allowEstimated:true, allowReverse:false, dayType:'auto', showSeconds:true, dataset:'integrated'},
      walking: { history: [], active: null, values: {} } };
  }
  function normalizedDestination(row) {
    if (row.destination) return row.destination;
    const names = row.destination_raw?.match(/本八幡|大島|新線新宿|新宿/g);
    return names?.at(-1) || row.destination_raw || '不明';
  }
  function ingest(seed) {
    if (!seed?.timetables?.timetables || !seed.network?.travelTimeProfiles) throw Error('提供JSONの形式が不正です');
    const trains = [], counts = {}, issues = [];
    for (const [tableId,table] of Object.entries(seed.timetables.timetables)) {
      if (!Array.isArray(table.trains) || table.direction !== '新宿方面') throw Error(`時刻表形式・方向が不正: ${tableId}`);
      counts[tableId] = table.trains.length;
      table.trains.forEach((row,index) => {
        const departure = parseServiceTime(row.departure, row.nextDay ?? row.next_day);
        const rawNormalized = table.normalized_trains?.[index];
        const id = `provided:${tableId}:${index}`; // IDがないので駅間の同一列車を統合しない。
        trains.push({ id, tableId, serviceDay:table.dayType === 'weekday' ? 'weekday':'holiday', line:'keio',
          direction:'inbound', type:row.type, origin:row.origin ? table.stationId : null,
          destination:normalizedDestination(row), destinationRaw:row.destination_raw ?? rawNormalized?.destination_raw ?? row.destination,
          anchorStationId:table.stationId, source:'developer_provided',
          verification:{status:'unconfirmed', checkedAt:null}, updatedAt:null,
          stops:[{stationId:table.stationId, arrival:null, departure, arrivalSource:null, departureSource:'developer_provided', stop:true}],
          raw:{tableId,index,train:clone(row),normalized:rawNormalized ? clone(rawNormalized):null, tableStatus:table.status, tableSource:table.source ?? null}
        });
      });
    }
    issues.push('全6時刻表はprovisional。公式照合日と列車IDがなく、駅をまたぐ同一列車の統合は行いません。');
    issues.push('重点3駅の上り発車には走行時間を補完しません。他駅の仮ダイヤでは提供区間時間を両方向に使います。');
    issues.push('快速・特急・区間急行・急行は停車駅対応未検証。自動到着計算の対象外です。');
    issues.push('自動曜日選択は土日のみ。祝日は「土休日」を手動選択してください。');
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
  function runningTime(network, from, to, type, {allowReverse=false, simulation=false}={}) {
    const profile=network.travelTimeProfiles[type];
    const segments=profile?.segments || [];
    const direct=segments.find(edge=>edge.from===stationName(from)&&edge.to===stationName(to));
    if (direct && profile.segmentMapping==='adjacent_stations') return {minutes:direct.minutes, source:'estimated', assumption:false};
    const reverse=segments.find(edge=>edge.from===stationName(to)&&edge.to===stationName(from));
    if(reverse && profile.segmentMapping==='adjacent_stations') return {minutes:reverse.minutes,source:'estimated',assumption:true};
    if(simulation && type==='各駅停車') return {minutes:ASSUMPTIONS.branchMinutes,source:'simulated',assumption:true};
    return null;
  }
  function expandTrain(train, network, options) {
    const result=clone(train);
    result.diagnostics=[];
    if(train.source==='developer_provided'||(train.direction==='inbound'&&['sakurajosui','shimotakaido','sasazuka'].includes(train.anchorStationId))) {
      result.diagnostics.push('提供発車の到着時刻は未登録です。走行時間で補完しません');
      return result;
    }
    // 利用者が登録した複数駅の時刻はそのまま優先。上書きしない。
    if (result.stops.length>1 || train.type!=='各駅停車') {
      if (train.stops.length===1 && train.type!=='各駅停車') result.diagnostics.push('停車駅と走行区間の対応が未確認のため到着を算出できません');
      return result;
    }
    const terminal = ['本八幡','大島'].includes(train.destination) ? '新線新宿' : train.destination;
    const path=findPath(train.anchorStationId,stationId(terminal));
    if(!path) { result.diagnostics.push('行先までの接続データがありません'); return result; }
    if(path.length>1&&edgeDirection(path[0],path[1])!==train.direction) {result.diagnostics.push('方向と行先が一致しません');return result;}
    let time=result.stops[0].departure;
    for(let i=1;i<path.length;i++) {
      const edge=runningTime(network,path[i-1],path[i],train.type,{allowReverse:options.allowReverse,simulation:options.mode==='simulation'});
      if(!edge) {result.diagnostics.push(`${stationName(path[i-1])}→${stationName(path[i])}の${train.direction==='inbound'?'上り':'下り'}走行時間がありません`);break;}
      if(edge.source==='simulated' && train.source!=='simulated') {result.diagnostics.push('未提供区間の仮想走行時間は提供列車に付加しません');break;}
      time += edge.minutes;
      const arrival=time;
      time += i===path.length-1 ? 0:ASSUMPTIONS.dwellMinutes;
      result.stops.push({stationId:path[i],arrival,departure:time,stop:true,arrivalSource:'estimated',departureSource:'estimated',assumptions:[...(edge.assumption?['下り走行時間の反転利用']:[]), '停車時間30秒（仮定）']});
    }
    return result;
  }
  function generateSimulation(seed, serviceDay) {
    const tables=Object.values(seed.timetables.timetables).filter(table => (table.dayType==='weekday'?'weekday':'holiday')===serviceDay);
    const departures=tables.flatMap(t=>t.trains.map(row=>parseServiceTime(row.departure,row.nextDay??row.next_day)));
    const first=Math.floor(Math.min(...departures)), last=Math.ceil(Math.max(...departures));
    const types=[...new Set(tables.flatMap(t=>t.trains.map(row=>row.type)))].filter(type=>type==='各駅停車');
    const trains=[];
    for(const [line,names] of Object.entries(LINES)) for(const direction of ['inbound','outbound']) {
      const route=(direction==='inbound'?[...names].reverse():names).map(stationId);
      for(let departure=first;departure<=last;departure+=serviceDay==='weekday'?ASSUMPTIONS.intervalWeekday:ASSUMPTIONS.intervalHoliday) for(const type of types) {
        let time=departure; const stops=[];
        for(let i=0;i<route.length;i++) {
          if(i>0) time+=runningTime(seed.network,route[i-1],route[i],type,{simulation:true}).minutes;
          const arrival=i===0?null:time;
          if(i>0&&i<route.length-1) time+=ASSUMPTIONS.dwellMinutes;
          stops.push({stationId:route[i],arrival,departure:i===route.length-1?null:time,stop:true,arrivalSource:'simulated',departureSource:'simulated'});
        }
        trains.push({id:`sim:${serviceDay}:${line}:${direction}:${departure}:${type}`,serviceDay,line,direction,type,
          origin:route[0],destination:stationName(route.at(-1)),anchorStationId:route[0],stops,source:'simulated',
          verification:{status:'unconfirmed',checkedAt:null},updatedAt:null,assumptions:clone(ASSUMPTIONS)});
      }
    }
    return trains;
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
    if(!['weekday','holiday'].includes(train.serviceDay)||!['inbound','outbound'].includes(train.direction)||!Object.hasOwn(LINES,train.line)) errors.push('曜日・路線・方向が不正です');
    if(!['各駅停車','快速','区間急行','急行','特急'].includes(train.type)||typeof train.destination!=='string'||!train.destination||train.destination.length>200) errors.push('種別・行先が不正です');
    if(!SOURCES.includes(train.source)||!['confirmed','unconfirmed'].includes(train.verification?.status)) errors.push('出典・確認状態が不正です');
    if(train.origin!==null&&!allStations.some(station=>station.id===train.origin)) errors.push('始発駅が不正です（不明ならnull）');
    if(train.verification?.status==='confirmed'&&!validDate(train.verification.checkedAt)) errors.push('確認日が必要です');
    if(train.source==='simulated'&&train.verification?.status==='confirmed') errors.push('仮想列車は確認済みにできません。新しい利用者列車として登録してください');
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
    const terminal=['本八幡','大島'].includes(train.destination)?'新線新宿':train.destination;
    if(allStations.some(station=>station.id===stationId(terminal))) {
      const path=findPath(train.stops[0].stationId,stationId(terminal));
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
    for(const [id,train]of Object.entries(value.updates)) if(id!==train.id||!['provided:','sim:'].some(prefix=>id.startsWith(prefix))||train.source!=='user_entered') errors.push('更新列車ID・出典が不正です');
    if(value.deleted.some(id=>typeof id!=='string'||!['provided:','user:','sim:'].some(prefix=>id.startsWith(prefix)))||new Set(value.deleted).size!==value.deleted.length) errors.push('削除IDが不正です');
    for(const confirmation of Object.values(value.confirmations)) if(confirmation?.status!=='confirmed'||!validDate(confirmation.checkedAt)) errors.push('確認状態・確認日が不正です');
    const settings=value.settings;
    if(!settings||!['simulation','practical'].includes(settings.mode)||!['auto','weekday','holiday'].includes(settings.dayType)||typeof settings.allowEstimated!=='boolean'||typeof settings.allowReverse!=='boolean'||typeof settings.showSeconds!=='boolean'||!['integrated','legacy'].includes(settings.dataset)) errors.push('設定が不正です');
    const walking=value.walking;
    if(!walking||!Array.isArray(walking.history)||walking.history.some(row=>!row||!allStations.some(station=>station.id===row.stationId)||!Number.isFinite(row.seconds)||row.seconds<=0||row.seconds>7200||!validDate(row.date))) errors.push('徒歩記録が不正です');
    if(walking?.active && (!allStations.some(station=>station.id===walking.active.stationId)||!Number.isFinite(walking.active.startedAt))) errors.push('計測中データが不正です');
    if(!walking?.values||Object.values(walking.values).some(value=>!Number.isInteger(value)||value<0||value>120)) errors.push('徒歩時間設定が不正です');
    return [...new Set(errors)];
  }
  function loadStore(storage) {
    const raw=storage?.getItem(KEY);
    if(!raw) return blankStore();
    const value=JSON.parse(raw); const errors=validateStore(value);
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
  // 接続スキャン。最初に乗る列車を固定してから、乗換を含む最早到着を探す。
  // 乗り継げる列車と駅の最早到着を別管理し、途中で同じ列車に乗り続けられるようにする。
  function connectJourney(first, boarding, destinationId, connections) {
    const initialLeg = {tripId:first.id, trainId:first.raw.id, source:first.raw.source, type:first.raw.type,
      fromStationId:boarding.stationId, toStationId:boarding.stationId, departure:boarding.departure, arrival:boarding.departure};
    const onboard = new Map([[first.id,{arrival:boarding.departure,legs:[initialLeg]}]]);
    const labels = new Map();
    for (const edge of connections) {
      if (edge.departure < boarding.departure) continue;
      const best = labels.get(destinationId);
      if (best && edge.departure > best.arrival) break;
      let riding = onboard.get(edge.tripId);
      const waiting = labels.get(edge.from);
      if (!riding && waiting && waiting.arrival + ASSUMPTIONS.transferMinutes * MINUTE <= edge.departure && waiting.legs.length < 4) {
        riding = {arrival:edge.departure, legs:[...waiting.legs,
          {tripId:edge.tripId,trainId:edge.raw.id,source:edge.raw.source,type:edge.raw.type,
           fromStationId:edge.from,toStationId:edge.from,departure:edge.departure,arrival:edge.departure}]};
      }
      if (!riding || riding.arrival > edge.departure) continue;
      const legs = [...riding.legs];
      legs[legs.length-1] = {...legs.at(-1),toStationId:edge.to,arrival:edge.arrival};
      const reached = {arrival:edge.arrival,legs};
      onboard.set(edge.tripId,reached);
      const previous = labels.get(edge.to);
      if (!previous || reached.arrival < previous.arrival || reached.arrival === previous.arrival && legs.length < previous.legs.length) labels.set(edge.to,reached);
    }
    return labels.get(destinationId) || null;
  }
  function query(trains,seed,{start,end,fromIds,destinationId,settings={}}) {
    const departures=[], reasons=new Set(), trips=[], connections=[];
    const focus=new Set(['sakurajosui','shimotakaido','sasazuka']);
    const firstDate=new Date(start);firstDate.setHours(0,0,0,0);firstDate.setDate(firstDate.getDate()-1);
    // 最初の発車は2時間以内。乗換先の列車はその後4時間まで探索する。
    const travelEnd=end+4*60*MINUTE, lastDate=new Date(travelEnd);lastDate.setHours(0,0,0,0);
    for(const date=new Date(firstDate);date<=lastDate;date.setDate(date.getDate()+1)) {
      const serviceDay=dayType(date,settings.dayType||'auto');
      const key=date.getFullYear()+'-'+(date.getMonth()+1)+'-'+date.getDate();
      for(const raw of trains) {
        if(raw.serviceDay!==serviceDay)continue;
        // 確認状態は使用可否に使わない。提供・利用者時刻を補完しない。
        const stops=raw.stops.map(stop=>({...stop,
          arrival:stop.arrival===null?null:timestamp(date,stop.arrival),
          departure:stop.departure===null?null:timestamp(date,stop.departure)}));
        if(!stops.some(stop=>(stop.departure??stop.arrival)>=start&&(stop.departure??stop.arrival)<=travelEnd))continue;
        const trip={id:raw.id+':'+key,raw,stops,serviceDay};
        trips.push(trip);
        const boardingStops=stops.filter(stop=>stop.stop);
        for(let i=1;i<boardingStops.length;i++) {
          const a=boardingStops[i-1],b=boardingStops[i];
          if(a.departure===null||a.departure<start||a.departure>travelEnd||b.arrival===null||b.arrival<a.departure)continue;
          connections.push({tripId:trip.id,raw,from:a.stationId,to:b.stationId,departure:a.departure,arrival:b.arrival});
        }
      }
    }
    connections.sort((a,b)=>a.departure-b.departure||a.arrival-b.arrival);
    // 提供表の対象範囲は削除後も保持し、仮想発車で復活させない。
    // 他駅で利用者時刻がある方向・曜日はその編集を優先する。
    const userCoverage=new Set();
    for(const trip of trips) if(trip.raw.source==='user_entered') for(const stop of trip.stops)
      if(stop.stop&&stop.departure!==null&&stop.departure>=start&&stop.departure<=end)userCoverage.add([stop.stationId,trip.raw.direction,trip.serviceDay].join(':'));
    const pathConnections=new Map();
    for(const trip of trips) for(const fromId of fromIds) {
      const raw=trip.raw, boarding=trip.stops.find(stop=>stop.stationId===fromId&&stop.stop&&stop.departure!==null);
      if(!boarding||boarding.departure<start||boarding.departure>end||fromId===destinationId)continue;
      const desired=findPath(fromId,destinationId);
      if(!desired||desired.length<2||edgeDirection(desired[0],desired[1])!==raw.direction)continue;
      if(raw.source==='developer_provided'&&fromId!==raw.anchorStationId)continue;
      if(raw.source==='simulated'&&((focus.has(fromId)&&raw.direction==='inbound'&&raw.line!=='new')||userCoverage.has([fromId,raw.direction,trip.serviceDay].join(':'))))continue;
      const index=trip.stops.indexOf(boarding);
      const explicitTarget=trip.stops.slice(index+1).find(stop=>stop.stationId===destinationId);
      if(!pathConnections.has(fromId))pathConnections.set(fromId,connections.filter(edge=>desired.indexOf(edge.from)>=0&&desired.indexOf(edge.to)>desired.indexOf(edge.from)));
      const canRide=trip.stops.slice(index+1).some(stop=>stop.stop&&stop.arrival!==null);
      const result=canRide?connectJourney(trip,boarding,destinationId,pathConnections.get(fromId)):null;
      if(!result) {
        if(explicitTarget&&!explicitTarget.stop)continue;
        if(raw.source==='simulated')continue;
        const terminal=['本八幡','大島'].includes(raw.destination)?'新線新宿':raw.destination;
        const path=findPath(fromId,stationId(terminal));
        if(!path||path.indexOf(destinationId)<=0||path.length>1&&edgeDirection(path[0],path[1])!==raw.direction)continue;
        reasons.add(stationName(fromId)+'：到着時刻が未登録です');
      }
      const legs=result?.legs||[];
      const simulation=legs.some(leg=>leg.source==='simulated'||leg.trainId.startsWith('sim:'));
      departures.push({id:trip.id+':'+fromId,trainId:raw.id,stationId:fromId,departureStation:stationName(fromId),
        departure:boarding.departure,arrival:result?.arrival??null,type:raw.type,destination:stationName(destinationId),
        source:raw.source,arrivalSource:result?(simulation?'simulated':explicitTarget?.arrivalSource||'user_entered'):null,
        serviceDay:trip.serviceDay,legs,simulation,arrivalMissing:!result});
    }
    return {trains:departures,reasons:[...reasons]};
  }
  return {VERSION,KEY,MINUTE,LINES,ASSUMPTIONS,allStations,stationId,stationName,parseServiceTime,serviceTime,dayType,blankStore,ingest,effectiveTrains,findPath,edgeDirection,runningTime,expandTrain,generateSimulation,
    validateTrain,validateStore,loadStore,saveStore,upsert,remove,makeUserTrain,parseStopLines,bulkAdd,query,clone};
});
