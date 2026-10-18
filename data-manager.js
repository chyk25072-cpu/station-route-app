/* 画面・localStorage管理。既存の検索画面とはRailwayAppを介して接続する。 */
(function () {
  'use strict';
  const C=globalThis.RailwayCore, seed=globalThis.RailwaySeed;
  if(!C||!seed) {document.getElementById('source-notice').textContent='初期データを読み込めません。data/seed.jsを確認してください。';return;}
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const source=C.ingest(seed);
  const generated=['weekday','holiday'].flatMap(day=>C.generateSimulation(seed,day));
  const base=[...source.trains,...generated];
  let store=C.blankStore(), storage=null, writable=true, pendingImport=null, page=0, effectiveCache=null, queryReasons=[];
  function notice(text) {$('storage-notice').hidden=false;$('storage-notice').textContent=text;}
  try {storage=globalThis.localStorage;store=C.loadStore(storage);} catch(error) {writable=false;notice(`保存データを読み込めません。元の保存内容は変更せず、一時状態で動作します。${error.message}`);}
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
  const names=Object.entries(C.LINES).map(([value])=>({value,label:{keio:'京王線',takao:'高尾線',sagamihara:'相模原線',new:'京王新線'}[value]}));
  options($('filter-line'),names,'keio');
  function fillStations() {
    const previous=$('filter-station').value||'sakurajosui';
    options($('filter-station'),C.LINES[$('filter-line').value].map(name=>({value:C.stationId(name),label:name})),previous);
  }
  fillStations();
  options($('destination'),C.allStations.map(station=>({value:station.id,label:station.name+'駅'})),'sasazuka');
  for(const [id,selected]of [['candidate-a','sakurajosui'],['candidate-b','shimotakaido']]) options($(id),C.allStations.map(station=>({value:station.id,label:station.name+'駅'})),selected);
  for(const [choice,label,input]of [['candidate-a','walk-label-a','walk-sakurajosui'],['candidate-b','walk-label-b','walk-shimotakaido']]) $(choice).addEventListener('change',()=>{
    $(label).textContent=`${C.stationName($(choice).value)}駅までの所要時間`;$(input).value='';document.dispatchEvent(new Event('railwaychange'));
  });
  options($('filter-hour'),[{value:'all',label:'全時間帯'},...Array.from({length:28},(_,hour)=>({value:String(hour),label:`${hour}時台`}))],'all');
  options($('edit-type'),['各駅停車','快速','区間急行','急行','特急'].map(value=>({value,label:value})),'各駅停車');
  options($('edit-origin'),[{value:'',label:'不明・未入力'},...C.allStations.map(station=>({value:station.id,label:station.name}))],'');
  options($('walking-station'),C.allStations.map(station=>({value:station.id,label:station.name+'駅'})),store.walking.active?.stationId||'sakurajosui');
  syncSettings();
  function filters() {return {line:$('filter-line').value,stationId:$('filter-station').value,direction:$('filter-direction').value,serviceDay:$('filter-day').value};}
  function filtered() {
    const f=filters(), hour=$('filter-hour').value;
    return effective().flatMap(train=>{
      const stop=train.stops.find(stop=>stop.stationId===f.stationId&&stop.stop&&stop.departure!==null);
      if(train.line!==f.line||train.direction!==f.direction||train.serviceDay!==f.serviceDay||!stop||hour!=='all'&&Math.floor(stop.departure/60)!==Number(hour)) return [];
      return [{train,stop}];
    }).sort((a,b)=>a.stop.departure-b.stop.departure||a.train.id.localeCompare(b.train.id));
  }
  function renderTable() {
    const rows=filtered();page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(rows.length/50)-1)));
    $('table-count').textContent=`${rows.length}件`;
    $('table-page').textContent=`${page+1} / ${Math.max(1,Math.ceil(rows.length/50))}`;
    $('prev-page').disabled=page===0;$('next-page').disabled=(page+1)*50>=rows.length;
    $('timetable-rows').innerHTML=rows.slice(page*50,(page+1)*50).map(({train,stop})=>`<tr><td>${esc(C.serviceTime(stop.departure))}</td><td>${esc(train.type)}<small>${esc(train.destination)}</small></td><td><button type="button" data-edit="${esc(train.id)}">編集</button><button type="button" data-delete="${esc(train.id)}">削除</button></td></tr>`).join('')||'<tr><td colspan="3">この条件の列車はありません。</td></tr>';
  }
  function stopLines(train) {return train.stops.map(stop=>[C.stationName(stop.stationId),C.serviceTime(stop.arrival),C.serviceTime(stop.departure),stop.stop?'停車':'通過'].join(',')).join('\n');}
  function openEditor(id) {
    const train=id?effective().find(train=>train.id===id):null;
    $('edit-id').value=id||'';
    $('editor-title').textContent=train?'列車を編集':'列車を追加';
    $('edit-type').value=train?.type||'各駅停車';
    $('edit-origin').value=train?.origin||'';
    $('edit-destination').value=train?.destination||($('filter-direction').value==='inbound'?'新宿':C.LINES[$('filter-line').value].at(-1));
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
  $('table-filters').addEventListener('change',event=>{if(event.target===$('filter-line'))fillStations();page=0;renderTable();$('train-editor').hidden=true;});
  $('table-filters').addEventListener('submit',event=>event.preventDefault());
  $('prev-page').addEventListener('click',()=>{page--;renderTable();});
  $('next-page').addEventListener('click',()=>{page++;renderTable();});
  $('bulk-save').addEventListener('click',()=>{
    try {const result=C.bulkAdd(store,$('bulk-text').value,{...filters(),type:'各駅停車',destination:$('filter-direction').value==='inbound'?'新宿':C.LINES[$('filter-line').value].at(-1)},base);
      store=result.store;save();renderTable();$('bulk-message').textContent=`${result.added.length}件を登録しました。到着時刻は空欄のままです。`;}
    catch(error){$('bulk-message').textContent=error.message;}
  });
  function selectedProvidedTables() {const f=filters();return source.trains.filter(train=>train.anchorStationId===f.stationId&&train.serviceDay===f.serviceDay&&train.direction===f.direction&&train.line===f.line);}
  $('reset-table').addEventListener('click',()=>{
    if(!confirm('選択中の駅・曜日・方向・路線に関わる変更を初期状態へ戻します。複数駅を走る列車は列車全体が戻ります。よろしいですか？'))return;
    const f=filters(); const matches=train=>train.line===f.line&&train.serviceDay===f.serviceDay&&train.direction===f.direction&&train.stops.some(stop=>stop.stationId===f.stationId);
    const ids=new Set([...base,...store.additions,...Object.values(store.updates)].filter(matches).map(train=>train.id));
    for(const id of ids) delete store.updates[id];store.additions=store.additions.filter(train=>!ids.has(train.id));store.deleted=store.deleted.filter(id=>!ids.has(id));
    for(const tableId of new Set(selectedProvidedTables().map(train=>train.tableId)))delete store.confirmations[tableId];
    save();renderTable();$('train-editor').hidden=true;$('table-message').textContent='選択条件の変更を初期状態に戻しました。';
  });
  function renderSummary() {
    $('storage-summary').innerHTML=`<p>追加 ${store.additions.length}件 / 更新 ${Object.keys(store.updates).length}件 / 削除 ${store.deleted.length}件</p><p>徒歩記録 ${store.walking.history.length}件</p>`;
  }
  $('export-data').addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(store,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`station-route-${today()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  function validateImport(value) {
    const errors=C.validateStore(value);if(errors.length)throw Error(errors.join(' / '));
    const ids=new Set(base.map(train=>train.id)), tableIds=new Set(Object.keys(source.counts));
    if(Object.keys(value.updates).some(id=>!ids.has(id))||Object.keys(value.confirmations).some(id=>!tableIds.has(id)))throw Error('現在の初期データに存在しない列車・時刻表の参照があります');
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
      const value=JSON.parse(await file.text());validateImport(value);pendingImport=value;
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
    $('origin-name').value='日本大学文理学部';$('destination').value='sasazuka';$('walking-station').value='sakurajosui';
    $('candidate-a').value='sakurajosui';$('candidate-b').value='shimotakaido';$('walk-label-a').textContent='桜上水駅までの所要時間';$('walk-label-b').textContent='下高井戸駅までの所要時間';
    save();syncSettings();renderTable();renderWalking();$('train-editor').hidden=true;
  });
  function syncSettings() {
    $('service-day').value=store.settings.dayType;
    const saved=store.settings.search;
    if(saved) {
      if(typeof saved.origin==='string')$('origin-name').value=saved.origin;
      if(C.allStations.some(station=>station.id===saved.destination))$('destination').value=saved.destination;
      for(const [index,choice]of ['candidate-a','candidate-b'].entries())if(C.allStations.some(station=>station.id===saved.candidates?.[index]))$(choice).value=saved.candidates[index];
    }
  }
  function updateSearchNotice() { $('source-notice').hidden=true; }
  function saveSearch() {
    store.settings.search={origin:$('origin-name').value,destination:$('destination').value,candidates:[$('candidate-a').value,$('candidate-b').value]};
    save({dataChanged:false});
  }
  $('service-day').addEventListener('change',()=>{store.settings.dayType=$('service-day').value;save({dataChanged:false});});
  $('origin-name').addEventListener('change',saveSearch);
  $('destination').addEventListener('change',saveSearch);
  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('.page').forEach(section=>section.hidden=section.id!==`page-${button.dataset.page}`);
    document.querySelectorAll('[data-page]').forEach(item=>{if(item===button)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
    $('app-menu').open=false;
  }));
  // 徒歩計測は日時の差で求め、リロード中も開始日時を保持する。
  function renderWalking() {
    $('walking-controls').innerHTML=[$('walking-station').value].map(id=>{
      const rows=store.walking.history.filter(row=>row.stationId===id), average=rows.length?rows.reduce((sum,row)=>sum+row.seconds,0)/rows.length:null;
      const seconds=Math.round(average||0);
      return `<div class="walking-row"><h3>${C.stationName(id)}駅</h3><p>${rows.length}件 ${average===null?'記録なし':`平均 ${Math.floor(seconds/60)}分${seconds%60}秒`}</p><div class="actions"><button type="button" data-walk-start="${id}" ${store.walking.active?'disabled':''}>計測開始</button><button type="button" data-walk-end="${id}" ${store.walking.active?.stationId===id?'':'disabled'}>終了して保存</button><button type="button" data-walk-apply="${id}" ${average===null?'disabled':''}>平均を適用</button></div></div>`;
    }).join('')+'<p id="walking-elapsed" role="status"></p>';
    updateWalkingClock();
  }
  function updateWalkingClock() {
    const active=store.walking.active;if(!$('walking-elapsed'))return;
    const seconds=active?Math.max(0,Math.floor((Date.now()-active.startedAt)/1000)):0;
    $('walking-elapsed').textContent=active?`${C.stationName(active.stationId)}駅まで計測中：${Math.floor(seconds/60)}分${seconds%60}秒`:'';
  }
  $('walking-station').addEventListener('change',renderWalking);
  $('walking-controls').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.walkStart){store.walking.active={stationId:button.dataset.walkStart,startedAt:Date.now()};save({dataChanged:false});renderWalking();}
    if(button.dataset.walkEnd&&store.walking.active?.stationId===button.dataset.walkEnd){
      const seconds=Math.round((Date.now()-store.walking.active.startedAt)/1000);
      if(seconds<=0||seconds>7200){notice('計測は1秒〜120分で保存できます。今回の計測を終了しました。');}
      else store.walking.history.push({stationId:button.dataset.walkEnd,seconds,date:new Date().toISOString()});
      store.walking.active=null;save({dataChanged:false});renderWalking();
    }
    if(button.dataset.walkApply){const rows=store.walking.history.filter(row=>row.stationId===button.dataset.walkApply);
      if(!rows.length)return;const minutes=Math.ceil(rows.reduce((sum,row)=>sum+row.seconds,0)/rows.length/60);
      const id=button.dataset.walkApply, choice=$('candidate-b').value===id?'candidate-b':'candidate-a';
      const input=choice==='candidate-a'?$('walk-sakurajosui'):$('walk-shimotakaido');
      $(choice).value=id;input.value=minutes;store.walking.values[id]=minutes;
      $(choice==='candidate-a'?'walk-label-a':'walk-label-b').textContent=C.stationName(id)+'駅までの所要時間';saveSearch();
    }
  });
  function applyWalkingValues(){
    for(const [choice,input]of [['candidate-a','walk-sakurajosui'],['candidate-b','walk-shimotakaido']]) {
      const value=store.walking.values[$(choice).value];if(value!==undefined)$(input).value=value;
      $(choice==='candidate-a'?'walk-label-a':'walk-label-b').textContent=C.stationName($(choice).value)+'駅までの所要時間';
    }
  }
  for(const [choice,input]of [['candidate-a','walk-sakurajosui'],['candidate-b','walk-shimotakaido']]) {
    $(input).addEventListener('change',()=>{const value=Number($(input).value);if($(input).value!==''&&Number.isInteger(value)&&value>=0&&value<=120){store.walking.values[$(choice).value]=value;saveSearch();}});
    $(choice).addEventListener('change',()=>{applyWalkingValues();saveSearch();});
  }
  globalThis.RailwayApp={
    // 旧モードは保存形式互換のため残すが、検索可否には使わない。
    get settings(){return {dayType:store.settings.dayType,showSeconds:true};},
    originName:()=>$('origin-name').value.trim()||'出発地',
    destinationName:()=>$('destination').selectedOptions[0]?.textContent||'笹塚駅',
    candidates:()=>[$('candidate-a').value,$('candidate-b').value].map(id=>({id,name:C.stationName(id)+'駅'})),
    async getTrains({start,end}){
      const fromIds=[...new Set([$('candidate-a').value,$('candidate-b').value])];
      const result=C.query(effective(),seed,{start,end,fromIds,destinationId:$('destination').value,settings:{dayType:store.settings.dayType}});
      queryReasons=result.reasons;
      return result.trains;
    },
    diagnostics:()=>queryReasons,
    diagnosticsHTML(stationId){const name=C.stationName(stationId);const reasons=queryReasons.filter(reason=>reason.startsWith(name));return reasons.length?`<p class="hint">${esc(reasons.join(' / '))}</p>`:'';},
    reliabilityHTML(train){return train.simulation||train.source==='simulated'?'<p class="reliability">シミュレーション</p>':'';},
    transferHTML(train){
      if(!train.legs?.length||train.legs.length===1)return '';
      const time=value=>{const date=new Date(value),base=new Date(train.departure),pad=value=>String(value).padStart(2,'0');return (date.toDateString()!==base.toDateString()?'翌日 ':'')+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());};
      return '<details class="transfer-route"><summary>乗換 '+(train.legs.length-1)+'回</summary>'+train.legs.map(leg=>'<p>'+esc(C.stationName(leg.fromStationId))+' '+time(leg.departure)+'発 → '+esc(C.stationName(leg.toStationId))+' '+time(leg.arrival)+'着</p>').join('')+'</details>';
    }
  };
  applyWalkingValues();renderWalking();renderTable();renderSummary();updateSearchNotice();
  setInterval(updateWalkingClock,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)updateWalkingClock();});
})();
