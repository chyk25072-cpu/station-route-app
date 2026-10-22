/* 公式APIの平均路線名を取得し、その路線の乗車時間だけを使う。
 * /rail は走行時間を返さないため、/search/course/extreme の plain 探索を併用する。
 * 仕様・利用するフィールドは API_INTEGRATION.md を参照。
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.EkispertClient=api;
})(globalThis,function(){
  'use strict';
  const array=value=>value===undefined||value===null?[]:Array.isArray(value)?value:[value];
  const text=value=>typeof value==='string'?value:typeof value?.text==='string'?value.text:'';
  const normalize=value=>text(value).normalize('NFKC').replace(/\s/g,'');
  class ConnectionError extends Error {}
  function lineType(name){
    const n=normalize(name);
    if(!n.includes('京王'))return null;
    for(const type of ['区間急行','特急','急行','快速'])if(n.includes(type))return type;
    return /各駅停車|各停|普通/.test(n)?'各駅停車':null;
  }
  // 無印の京王路線は、名前だけでは各停と決めない。区間内の全駅に
  // 停車する数と一致するAPI応答が得られたときだけ、各停に利用する。
  const isUnnamedLocal=name=>['京王線','京王高尾線','京王相模原線','京王新線'].includes(normalize(name));
  function readDuration(json,{from,to,lineName,type,stations}){
    const result=json?.ResultSet;
    if(!result||result.Error)throw Error('平均走行時間APIがエラーを返しました');
    const candidates=[];
    for(const course of array(result.Course))for(const route of array(course.Route)){
      if(course.dataType!=='plain')continue;
      const lines=array(route.Line),points=array(route.Point);
      if(lines.length!==1||points.length!==2||Number(route.transferCount)!==0||Number(route.timeWalk)!==0)continue;
      if(normalize(points[0]?.Station?.Name)!==normalize(from)||normalize(points[1]?.Station?.Name)!==normalize(to))continue;
      const line=lines[0],minutes=Number(line.timeOnBoard);
      if(text(line.Type)!=='train'||!Number.isFinite(minutes)||minutes<=0||minutes>720)continue;
      if(![line.Name,line.TypicalName].some(name=>normalize(name)===normalize(lineName)))continue;
      const namedTypes=[line.Name,line.TypicalName].map(lineType).filter(Boolean);
      if(type&&namedTypes.some(named=>named!==type))continue;
      if(isUnnamedLocal(lineName)){
        // stopStationCountは両端を除く途中停車駅数。別経路・急行等へ流用しない。
        if(type!=='各駅停車'||!Array.isArray(stations)||stations.length<2||
          normalize(stations[0])!==normalize(from)||normalize(stations.at(-1))!==normalize(to)||
          line.stopStationCount===undefined||line.stopStationCount===null||line.stopStationCount===''||
          Number(line.stopStationCount)!==stations.length-2)continue;
      }
      candidates.push({minutes,lineName:text(line.Name),source:'ekispert'});
    }
    return candidates.sort((a,b)=>a.minutes-b.minutes)[0]||null;
  }
  function createClient({config,fetch:fetcher,now=()=>Date.now(),setTimeout:schedule=globalThis.setTimeout,clearTimeout:cancel=globalThis.clearTimeout}={}){
    const cache=new Map();
    function memo(key,task){
      const old=cache.get(key);if(old&&old.expires>now())return old.promise;
      const item={expires:now()+5*60*1000};
      item.promise=Promise.resolve().then(task).catch(error=>{item.expires=now()+30000;throw error;});
      cache.set(key,item);return item.promise;
    }
    async function request(path,params){
      const c=typeof config==='function'?config():config;
      const functionPath=c?.functionPath||'/.netlify/functions/ekispert';
      if(!/^\/\.netlify\/functions\/[a-zA-Z0-9_-]+$/.test(functionPath))throw Error('Netlify Functionsの接続先設定が不正です');
      const query=new URLSearchParams({endpoint:path,...params});
      const address=functionPath+'?'+query.toString();
      const controller=new AbortController(),timer=schedule(()=>controller.abort(),12000);
      try{
        const response=await fetcher(address,{signal:controller.signal,headers:{Accept:'application/json'}});
        let json;
        try {json=await response.json();}catch {throw new ConnectionError(response.status===404?'Netlify Functionが見つかりません。Functionsを含むデプロイを確認してください。':'Netlify Functionの応答を読み取れません。');}
        if(!response.ok)throw new ConnectionError(typeof json?.error?.message==='string'?json.error.message:'Netlify Functionへの接続に失敗しました（HTTP '+response.status+'）');
        if(path!=='diagnostics'&&(!json?.ResultSet||json.ResultSet.Error))throw new ConnectionError('Netlify Functionから正しいAPI応答を取得できません');
        return json;
      }catch(error){
        if(controller.signal.aborted)throw Error('Netlify Functionとの通信がタイムアウトしました。');
        // 通信例外に含まれるURLを画面・ログへ流さない。
        if(error instanceof ConnectionError)throw error;
        throw Error('Netlify Functionとの通信に失敗しました。Netlifyの公開環境またはローカル開発サーバーで確認してください。');
      }finally{cancel(timer);}
    }
    async function getAverageTime({from,to,type,date,stations}){
      const key=JSON.stringify([from,to,type,date,stations]);
      return memo(key,async()=>{
        const rails=await memo('rails:'+from+':'+to+':'+date,async()=>{
          const all=[];let offset=1;
          for(let page=0;page<10;page++){
            const json=await request('rail',{from,to,type:'train',date,offset,limit:100});
            const rows=array(json.ResultSet.Line);all.push(...rows);
            const max=Number(json.ResultSet.max);
            if(!Number.isFinite(max)||max<0)throw Error('平均走行時間APIの路線件数を確認できません');
            if(offset+rows.length>max)return all;
            if(!rows.length)throw Error('平均走行時間APIの路線一覧が不完全です');
            offset+=rows.length;
          }
          throw Error('平均走行時間APIの路線一覧が多すぎます');
        });
        const matches=[...new Set(rails.filter(line=>text(line.Type)==='train'&&
          (lineType(line.Name)===type||type==='各駅停車'&&isUnnamedLocal(line.Name))).map(line=>text(line.Name)))];
        const results=[];
        for(const lineName of matches){
          const json=await request('search/course/extreme',{viaList:from+':'+to,searchType:'plain',fixedRailList:lineName,date,answerCount:20,searchCount:20});
          const duration=readDuration(json,{from,to,lineName,type,stations});if(duration)results.push(duration);
        }
        return results.sort((a,b)=>a.minutes-b.minutes)[0]||null;
      });
    }
    async function checkConnection(){
      const result=await request('diagnostics',{});
      if(typeof result?.ok!=='boolean'||!Array.isArray(result.checks)||result.checks.length!==2||result.checks.some(check=>typeof check.ok!=='boolean'||!['rail','search/course/extreme'].includes(check.endpoint)))throw Error('API接続確認の応答が不正です。');
      if(result.ok)cache.clear();
      return result;
    }
    return {getAverageTime,checkConnection};
  }
  return {array,text,lineType,readDuration,createClient};
});
