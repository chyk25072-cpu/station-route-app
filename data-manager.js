/* 画面・localStorage管理。既存の検索画面とはRailwayAppを介して接続する。 */
(function () {
  'use strict';
  const C=globalThis.RailwayCore, seed=globalThis.RailwaySeed;
  if(!C||!seed) {document.getElementById('source-notice').textContent='初期データを読み込めません。data/seed.jsを確認してください。';return;}
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const source=C.ingest(seed);
  const base=source.trains;
  const api=globalThis.EkispertClient.createClient({config:()=>globalThis.EkispertConfig,fetch:(...args)=>globalThis.fetch(...args)});
  let store=C.blankStore(), storage=null, writable=true, pendingImport=null, page=0, effectiveCache=null, queryReasons=[], querySequence=0;
  function notice(text) {$('storage-notice').hidden=false;$('storage-notice').textContent=text;}
  try {storage=globalThis.localStorage;store=C.loadStore(storage,seed);if(storage.getItem(C.KEY)&&storage.getItem(C.KEY)!==JSON.stringify(store))C.saveStore(storage,store);} catch(error) {writable=false;notice(`保存データを読み込めません。元の保存内容は変更せず、一時状態で動作します。${error.message}`);}
  const today=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
  function effective() {return effectiveCache||(effectiveCache=C.effectiveTrains(base,store));}
  function save({dataChanged=true}={}) {
    if(dataChanged) effectiveCache=null;
    try {if(!writable||!storage) throw Error('永続保存が利用できません');C.saveStore(storage,store);}
    catch(error) {notice(`変更はこの画面には反映しましたが保存できません。JSONをエクスポートして保管してください。${error.message}`);}
    renderSummary(); updateSearchNotice();
    document.dispatchEvent(new Event('railwaychange'));
  }
  function options(select,values,selected) {
    select.innerHTML=values.map(item=>`<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('');
    if(values.some(item=>item.value===selected)) select.value=selected;
  }
  options($('filter-station'),C.FOCUS_STATIONS.map(id=>({value:id,label:C.stationName(id)})),'sakurajosui');
  options($('destination'),C.allStations.map(station=>({value:station.id,label:station.name+'駅'})),'sasazuka');
  options($('filter-hour'),[{value:'all',label:'全時間帯'},...Array.from({length:28},(_,hour)=>({value:String(hour),label:hour<24?`${hour}時台`:`翌日${hour-24}時台`}))],'all');
  options($('edit-type'),['各駅停車','快速','区間急行','急行','特急'].map(value=>({value,label:value})),'各駅停車');
  options($('edit-origin'),[{value:'',label:'不明・未入力'},...C.allStations.map(station=>({value:station.id,label:station.name}))],'');
  options($('walking-station'),C.FOCUS_STATIONS.map(id=>({value:id,label:C.stationName(id)+'駅'})),store.walking.active?.stationId||'sakurajosui');
  options($('result-walking-station'),C.FOCUS_STATIONS.map(id=>({value:id,label:C.stationName(id)+'駅'})),store.walking.active?.stationId||'sakurajosui');
  syncSettings();
  function filters() {return {line:'keio',stationId:$('filter-station').value,direction:$('filter-direction').value,serviceDay:$('filter-day').value};}
  function filtered() {
    const f=filters(), hour=$('filter-hour').value;
    return effective().flatMap(train=>{
      const stop=train.stops.find(stop=>stop.stationId===f.stationId&&stop.stop&&stop.departure!==null);
      if(train.line!==f.line||train.direction!==f.direction||!C.matchesDay(train.serviceDay,f.serviceDay)||!stop||hour!=='all'&&Math.floor(stop.departure/60)!==Number(hour)) return [];
      return [{train,stop}];
    }).sort((a,b)=>a.stop.departure-b.stop.departure||a.train.id.localeCompare(b.train.id));
  }
  function renderTable() {
    const rows=filtered();page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(rows.length/50)-1)));
    $('table-count').textContent=`${rows.length}件`;
    $('table-page').textContent=`${page+1} / ${Math.max(1,Math.ceil(rows.length/50))}`;
    $('prev-page').disabled=page===0;$('next-page').disabled=(page+1)*50>=rows.length;
    const time=value=>value>=1440&&value<2880?'翌日 '+C.serviceTime(value-1440):C.serviceTime(value);
    $('timetable-rows').innerHTML=rows.slice(page*50,(page+1)*50).map(({train,stop})=>`<tr><td>${esc(time(stop.departure))}</td><td>${esc(train.type)}<small>${esc(train.destination)}</small></td><td><button type="button" data-edit="${esc(train.id)}">編集</button><button type="button" data-delete="${esc(train.id)}">削除</button></td></tr>`).join('')||'<tr><td colspan="3">この条件の列車はありません。</td></tr>';
  }
  function stopLines(train) {return train.stops.map(stop=>[C.stationName(stop.stationId),C.serviceTime(stop.arrival),C.serviceTime(stop.departure),stop.stop?'停車':'通過'].join(',')).join('\n');}
  function openEditor(id) {
    const train=id?effective().find(train=>train.id===id):null;
    $('edit-id').value=id||'';
    $('editor-title').textContent=train?'列車を編集':'列車を追加';
    $('edit-type').value=train?.type||'各駅停車';
    $('edit-origin').value=train?.origin||'';
    $('edit-destination').value=train?.destination||($('filter-direction').value==='inbound'?'新宿':'京王八王子');
    $('edit-stops').value=train?stopLines(train):`${C.stationName($('filter-station').value)},,18:00:00,停車`;
    $('editor-message').textContent='';$('train-editor').hidden=false;
    $('edit-stops').focus();
  }
  $('new-train').addEventListener('click',()=>openEditor());
  $('cancel-edit').addEventListener('click',()=>{$('train-editor').hidden=true;});
  $('train-editor').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      const previous=effective().find(train=>train.id===$('edit-id').value);
      const train={...previous,...C.makeUserTrain({...filters(),id:previous?.id,type:$('edit-type').value,destination:$('edit-destination').value.trim(),
        stops:C.parseStopLines($('edit-stops').value),origin:$('edit-origin').value||null})};
      if(previous) train.verification=previous.verification;
      // 編集中にフィルターが変わっても、既存列車の曜日・方向を意図せず変更しない。
      if(previous) for(const field of ['line','direction','serviceDay','anchorStationId']) train[field]=previous[field];
      C.upsert(store,train,base);save();renderTable();$('editor-message').textContent='保存し、検索へ反映しました。';
    }catch(error){$('editor-message').textContent=error.message;}
  });
  $('timetable-rows').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.edit) openEditor(button.dataset.edit);
    if(button.dataset.delete&&confirm('この列車を削除します。元データの列車は削除状態として保存されます。よろしいですか？')) {
      C.remove(store,button.dataset.delete);save();renderTable();$('train-editor').hidden=true;
    }
  });
  $('table-filters').addEventListener('change',()=>{page=0;renderTable();$('train-editor').hidden=true;});
  $('table-filters').addEventListener('submit',event=>event.preventDefault());
  $('prev-page').addEventListener('click',()=>{page--;renderTable();});
  $('next-page').addEventListener('click',()=>{page++;renderTable();});
  $('bulk-save').addEventListener('click',()=>{
    try {const result=C.bulkAdd(store,$('bulk-text').value,{...filters(),type:'各駅停車',destination:$('filter-direction').value==='inbound'?'新宿':'京王八王子'},base);
      store=result.store;save();renderTable();$('bulk-message').textContent=`${result.added.length}件を登録しました。到着時刻は空欄のままです。`;}
    catch(error){$('bulk-message').textContent=error.message;}
  });
  function selectedProvidedTables() {const f=filters();return source.trains.filter(train=>train.anchorStationId===f.stationId&&train.serviceDay===f.serviceDay&&train.direction===f.direction&&train.line===f.line);}
  $('reset-table').addEventListener('click',()=>{
    if(!confirm('選択中の駅・曜日・方向・路線に関わる変更を初期状態へ戻します。複数駅を走る列車は列車全体が戻ります。よろしいですか？'))return;
    const f=filters(); const matches=train=>train.line===f.line&&C.matchesDay(train.serviceDay,f.serviceDay)&&train.direction===f.direction&&train.stops.some(stop=>stop.stationId===f.stationId);
    const ids=new Set([...base,...store.additions,...Object.values(store.updates)].filter(matches).map(train=>train.id));
    for(const id of ids) delete store.updates[id];store.additions=store.additions.filter(train=>!ids.has(train.id));store.deleted=store.deleted.filter(id=>!ids.has(id));
    for(const tableId of new Set(selectedProvidedTables().map(train=>train.tableId)))delete store.confirmations[tableId];
    save();renderTable();$('train-editor').hidden=true;$('table-message').textContent='選択条件の変更を初期状態に戻しました。';
  });
  function renderSummary() {
    $('storage-summary').innerHTML=`<p>追加 ${store.additions.length}件 / 更新 ${Object.keys(store.updates).length}件 / 削除 ${store.deleted.length}件</p><p>徒歩記録 ${store.walking.history.filter(row=>C.isFocusStation(row.stationId)).length}件</p>`;
  }
  $('export-data').addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(store,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`station-route-${today()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('check-api').addEventListener('click',async()=>{
    $('check-api').disabled=true;$('api-check-result').textContent='API接続を確認しています…';
    try {
      const result=await api.checkConnection();
      $('api-check-result').textContent=(result.ok?'Netlify Functionsから両APIへの接続・認証に成功しました。':'API接続に失敗しました。')+' '+
        result.checks.map(check=>check.endpoint+'：'+(check.ok?'成功（HTTP '+check.upstreamStatus+'）':check.message)).join(' / ');
      if(result.ok)document.dispatchEvent(new Event('railwaychange'));
    }catch(error){$('api-check-result').textContent=error.message;}
    finally{$('check-api').disabled=false;}
  });
  function validateImport(value) {
    const errors=C.validateStore(value);if(errors.length)throw Error(errors.join(' / '));
    // 登録・編集の対象は大学から向かう2駅だけにする。
    const all=C.effectiveTrains(base,value); // 重複した追加・更新はインポートでも拒否。
    const seen=new Set();
    for(const train of all.filter(train=>train.source==='user_entered')) {
      const key=JSON.stringify([train.serviceDay,train.direction,train.type,train.destination,train.stops.map(stop=>[stop.stationId,stop.departure])]);
      if(seen.has(key))throw Error('登録列車に重複があります');seen.add(key);
    }
  }
  $('import-file').addEventListener('change',async()=>{
    pendingImport=null;$('import-confirm').hidden=true;$('import-preview').hidden=true;
    try {const file=$('import-file').files[0];if(!file)return;if(file.size>10*1024*1024)throw Error('10MB以下のJSONを選んでください');
      let value=JSON.parse(await file.text());
      if(value?.version===C.VERSION&&Array.isArray(value.additions)&&value.updates&&Array.isArray(value.deleted)&&value.confirmations&&value.settings&&Array.isArray(value.walking?.history))value=C.pruneStore(C.adaptStore(value,seed));
      validateImport(value);pendingImport=value;
      $('import-preview').textContent=`形式 v${value.version}\n追加 ${value.additions.length} / 更新 ${Object.keys(value.updates).length} / 削除 ${value.deleted.length}\n徒歩記録 ${value.walking.history.length}件\n現在の編集・設定・徒歩記録をこの内容に置き換えます。`;
      $('import-preview').hidden=false;$('import-confirm').hidden=false;$('import-message').textContent='形式を検証しました。内容を確認して確定してください。';
    }catch(error){$('import-message').textContent=error.message;}
  });
  $('import-confirm').addEventListener('click',()=>{
    if(!pendingImport||!confirm('プレビューの内容で現在の保存データを置き換えますか？'))return;
    store=C.clone(pendingImport);pendingImport=null;writable=Boolean(storage);syncSettings();applyWalkingValues();renderWalking();save();renderTable();$('import-confirm').hidden=true;$('import-preview').hidden=true;$('import-message').textContent='インポートしました。';
  });
  $('reset-data').addEventListener('click',()=>{
    if(!confirm('時刻表の変更を初期化します。徒歩記録と検索条件は保持します。よろしいですか？'))return;
    const next=C.blankStore();next.walking=store.walking;next.settings=store.settings;store=next;writable=Boolean(storage);save();renderTable();$('train-editor').hidden=true;
  });
  $('reset-all').addEventListener('click',()=>{
    if(!confirm('このアプリの時刻表変更・徒歩記録・設定をすべて初期化します。他の保存キーには触れません。よろしいですか？'))return;
    store=C.blankStore();writable=Boolean(storage);$('walk-sakurajosui').value=9;$('walk-shimotakaido').value=8;
    $('destination').value='sasazuka';$('walking-station').value='sakurajosui';
    save();syncSettings();renderTable();renderWalking();$('train-editor').hidden=true;
  });
  function syncSettings() {
    $('service-day').value=store.settings.dayType;
    const destination=store.settings.search?.destination;
    if(C.allStations.some(station=>station.id===destination))$('destination').value=destination;
  }
  function updateSearchNotice() { $('source-notice').hidden=true; }
  function saveSearch() {
    store.settings.search={destination:$('destination').value};
    save({dataChanged:false});
  }
  $('service-day').addEventListener('change',()=>{store.settings.dayType=$('service-day').value;save({dataChanged:false});});
  $('destination').addEventListener('change',saveSearch);
  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('.page').forEach(section=>section.hidden=section.id!==`page-${button.dataset.page}`);
    document.querySelectorAll('[data-page]').forEach(item=>{if(item===button)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
    $('app-menu').open=false;
  }));
  // 2画面とも同じactiveを使う。計測状態は開始時点で永続化する。
  let lastRecommendation=null, walkingMessage='';
  function selectWalkingStation(id){
    if(!C.isFocusStation(id)||store.walking.active)return;
    $('walking-station').value=id;$('result-walking-station').value=id;
  }
  function renderWalking() {
    const active=store.walking.active;
    if(active){$('walking-station').value=active.stationId;$('result-walking-station').value=active.stationId;$('result-walking').hidden=false;}
    else $('result-walking-station').value=$('walking-station').value;
    $('walking-station').disabled=!!active;$('result-walking-station').disabled=!!active;
    $('result-walking-start').disabled=!!active;$('result-walking-stop').disabled=!active;
    $('walking-controls').innerHTML=[$('walking-station').value].map(id=>{
      const rows=store.walking.history.filter(row=>row.stationId===id), average=rows.length?rows.reduce((sum,row)=>sum+row.seconds,0)/rows.length:null;
      const seconds=Math.round(average||0);
      return `<div class="walking-row"><h3>${C.stationName(id)}駅</h3><p>${rows.length}件 ${average===null?'記録なし':`平均 ${Math.floor(seconds/60)}分${seconds%60}秒`}</p><div class="actions"><button type="button" data-walk-start="${id}" ${store.walking.active?'disabled':''}>計測開始</button><button type="button" data-walk-end="${id}" ${store.walking.active?.stationId===id?'':'disabled'}>終了して保存</button><button type="button" data-walk-apply="${id}" ${average===null?'disabled':''}>平均を適用</button></div></div>`;
    }).join('')+'<p id="walking-elapsed" role="status"></p>';
    const history=store.walking.history.filter(row=>C.isFocusStation(row.stationId)).slice().sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    $('walking-history').innerHTML=history.length?'<ul>'+history.map(row=>'<li><div><strong>'+esc(C.stationName(row.stationId))+'駅 · '+Math.floor(row.seconds/60)+'分'+row.seconds%60+'秒</strong><time datetime="'+esc(row.date)+'">'+esc(new Date(row.date).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}))+'</time></div><button type="button" data-walk-delete="'+esc(row.id)+'" aria-label="'+esc(C.stationName(row.stationId))+'駅の計測記録を削除">削除</button></li>').join('')+'</ul>':'<p class="hint">計測履歴はまだありません。</p>';
    updateWalkingClock();
  }
  function refreshAppliedAverage(id){
    if(!store.walking.appliedAverages[id])return;
    const average=C.walkingAverage(store,id),input=$(id==='sakurajosui'?'walk-sakurajosui':'walk-shimotakaido');
    const minutes=average===null?(id==='sakurajosui'?9:8):Math.ceil(average/60);
    input.value=minutes;store.walking.values[id]=minutes;
    if(average===null)delete store.walking.appliedAverages[id];
  }
  $('walking-history').addEventListener('click',event=>{
    const button=event.target.closest('[data-walk-delete]');if(!button)return;
    const record=store.walking.history.find(row=>row.id===button.dataset.walkDelete&&C.isFocusStation(row.stationId));if(!record)return;
    store.walking.history=store.walking.history.filter(row=>row.id!==record.id);
    refreshAppliedAverage(record.stationId);save({dataChanged:false});renderWalking();
  });
  function updateWalkingClock() {
    const active=store.walking.active;
    // setIntervalの実行回数は使わない。非表示・スリープ・リロード後も日時差で復元する。
    const seconds=active?Math.max(0,Math.floor((Date.now()-active.startedAt)/1000)):0;
    const elapsed=active?`${C.stationName(active.stationId)}駅まで計測中：${Math.floor(seconds/60)}分${seconds%60}秒`:walkingMessage;
    for(const id of ['walking-elapsed','result-walking-elapsed'])if($(id)&&$(id).textContent!==elapsed)$(id).textContent=elapsed;
  }
  function startWalking(id){
    if(store.walking.active||!C.isFocusStation(id))return;
    store.walking.active={stationId:id,startedAt:Date.now()};walkingMessage='';
    save({dataChanged:false});renderWalking();
  }
  function stopWalking(){
    const active=store.walking.active;if(!active)return;
    const stoppedAt=Date.now(),seconds=Math.round((stoppedAt-active.startedAt)/1000);
    if(seconds<=0||seconds>7200){walkingMessage='計測は1秒〜120分で保存できます。今回の計測を終了しました。';notice(walkingMessage);}
    else {
      store.walking.history.push({id:'walk:'+crypto.randomUUID(),stationId:active.stationId,seconds,date:new Date(stoppedAt).toISOString()});
      refreshAppliedAverage(active.stationId);
      walkingMessage=`${C.stationName(active.stationId)}駅まで ${Math.floor(seconds/60)}分${seconds%60}秒を保存しました。`;
    }
    store.walking.active=null;save({dataChanged:false});renderWalking();
  }
  for(const id of ['walking-station','result-walking-station'])$(id).addEventListener('change',()=>{selectWalkingStation($(id).value);renderWalking();});
  $('result-walking-start').addEventListener('click',()=>startWalking($('result-walking-station').value));
  $('result-walking-stop').addEventListener('click',stopWalking);
  $('walking-controls').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.walkStart)startWalking(button.dataset.walkStart);
    if(button.dataset.walkEnd&&store.walking.active?.stationId===button.dataset.walkEnd)stopWalking();
    if(button.dataset.walkApply){
      const id=button.dataset.walkApply,average=C.walkingAverage(store,id);if(average===null)return;
      store.walking.appliedAverages[id]=true;refreshAppliedAverage(id);saveSearch();
    }
  });
  function applyWalkingValues(){
    for(const id of C.FOCUS_STATIONS){
      const value=store.walking.values[id];if(value!==undefined)$(id==='sakurajosui'?'walk-sakurajosui':'walk-shimotakaido').value=value;
    }
  }
  for(const id of C.FOCUS_STATIONS){
    const input=$(id==='sakurajosui'?'walk-sakurajosui':'walk-shimotakaido');
    input.addEventListener('change',()=>{const value=Number(input.value);if(input.value!==''&&Number.isInteger(value)&&value>=0&&value<=120){store.walking.values[id]=value;delete store.walking.appliedAverages[id];saveSearch();}});
  }
  function searchDirection(){
    for(const from of C.FOCUS_STATIONS){const path=C.findPath(from,$('destination').value);if(path?.length>1)return C.edgeDirection(path[0],path[1]);}
    return null;
  }
  const candidateIds=()=>searchDirection()==='outbound'?['sakurajosui']:C.FOCUS_STATIONS;
  globalThis.RailwayApp={
    updateResultWalking(recommended){
      $('result-walking').hidden=false;
      // 同じ検索結果の秒更新で、利用者が選び直した駅を上書きしない。
      if(recommended&&recommended!==lastRecommendation){selectWalkingStation(recommended);renderWalking();}
      lastRecommendation=recommended||null;
    },
    get settings(){return {dayType:store.settings.dayType,showSeconds:true};},
    originName:()=>'日本大学文理学部',
    destinationId:()=>$('destination').value,
    direction:searchDirection,
    destinationName:()=>$('destination').selectedOptions[0]?.textContent||'笹塚駅',
    candidates:()=>candidateIds().map(id=>({id,name:C.stationName(id)+'駅'})),
    async getTrains({start,end}){
      const sequence=++querySequence;
      const destinationId=$('destination').value;
      const settings={dayType:store.settings.dayType,destinationAliases:globalThis.EkispertConfig?.destinationAliases||{}};
      const fromIds=candidateIds();
      // 下りは下高井戸の列車を、停車駅判定・API問い合わせより前に除外する。
      const trains=effective().filter(train=>fromIds.includes(train.anchorStationId));
      const request={start,end,fromIds,destinationId,settings};
      const initial=C.query(trains,seed,request),predictions={},issues=new Set();
      const groups=new Map();
      for(const train of initial.trains.filter(train=>train.arrivalMissing&&!train.destinationUnverified)){
        const key=C.predictionKey(train.stationId,destinationId,train.type,train.direction,train.operatingDate,train.predictionSegments);
        groups.set(key,{segments:train.predictionSegments,date:train.operatingDate});
      }
      const results=await Promise.allSettled([...groups].map(async([key,params])=>{
        const durations=await Promise.all(params.segments.map(segment=>api.getAverageTime({from:C.stationName(segment.from),to:C.stationName(segment.to),type:segment.type,date:params.date,
          stations:C.findPath(segment.from,segment.to)?.map(C.stationName)})));
        if(durations.every(Boolean))predictions[key]={minutes:durations.reduce((sum,item)=>sum+item.minutes,0),source:'ekispert'};
        else predictions[key]={unavailable:true};
      }));
      for(const result of results)if(result.status==='rejected')issues.add(result.reason.message);
      const result=C.query(trains,seed,{...request,settings:{...settings,predictions}});
      if(sequence===querySequence)queryReasons=[...issues,...result.reasons];
      return result.trains;
    },
    diagnostics:()=>queryReasons,
    diagnosticsHTML(stationId){const name=C.stationName(stationId);const reasons=queryReasons.filter(reason=>reason.startsWith(name));return reasons.length?`<p class="hint">${esc(reasons.join(' / '))}</p>`:'';},
    transferHTML(train){
      if(!train.legs?.length||train.legs.length===1)return '';
      const time=value=>{const date=new Date(value),base=new Date(train.departure),pad=value=>String(value).padStart(2,'0');return (date.toDateString()!==base.toDateString()?'翌日 ':'')+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());};
      return '<details class="transfer-route"><summary>乗換 '+(train.legs.length-1)+'回</summary>'+train.legs.map(leg=>'<p>'+esc(C.stationName(leg.fromStationId))+' '+time(leg.departure)+'発 → '+esc(C.stationName(leg.toStationId))+' '+time(leg.arrival)+'着</p>').join('')+'</details>';
    }
  };
  applyWalkingValues();renderWalking();renderTable();renderSummary();updateSearchNotice();
  setInterval(updateWalkingClock,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateWalkingClock();});
  globalThis.addEventListener('pageshow',updateWalkingClock);
})();
