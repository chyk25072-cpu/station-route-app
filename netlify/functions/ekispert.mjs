// APIキーはFunction実行時にだけ読む。ブラウザ向けビルドへは埋め込まない。
import C from '../../railway-core.js';

const API_BASE = 'https://api.ekispert.jp/v1/json/';
const STATIONS = new Set(C.allStations.map(station => station.name));
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
const number = value => typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
const headers = {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'};
const json = (body, status=200, extra={}) => new Response(JSON.stringify(body), {status, headers:{...headers,...extra}});
const failures = new WeakSet();
function fail(code, message, status, upstreamStatus) {
  const error={code,message,status,...(upstreamStatus ? {upstreamStatus} : {})};failures.add(error);return error;
}

function validate(params) {
  for(const key of new Set(params.keys()))if(params.getAll(key).length!==1)throw fail('INVALID_REQUEST','同じパラメータは複数指定できません。',400);
  const endpoint = params.get('endpoint');
  const allowed = endpoint==='rail' ? ['endpoint','from','to','date','type','offset','limit'] :
    endpoint==='search/course/extreme' ? ['endpoint','viaList','date','searchType','fixedRailList','answerCount','searchCount'] : endpoint==='diagnostics' ? ['endpoint'] : null;
  if(!allowed || [...params.keys()].some(key=>!allowed.includes(key)))throw fail('INVALID_REQUEST','許可されていないAPIまたはパラメータです。',400);
  if(endpoint==='diagnostics')return {endpoint,params:{}};
  const date=params.get('date')||'';
  const parsed=new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T00:00:00Z`);
  if(!/^\d{8}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10).replaceAll('-','')!==date)throw fail('INVALID_REQUEST','運行日は有効なYYYYMMDD形式で指定してください。',400);
  const pair=endpoint==='rail'?[params.get('from'),params.get('to')]:(params.get('viaList')||'').split(':');
  if(pair.length!==2||pair[0]===pair[1]||pair.some(station=>!STATIONS.has(station)))throw fail('INVALID_REQUEST','対応する出発駅と目的駅を指定してください。',400);
  if(endpoint==='rail') {
    const offset=params.get('offset')||'1';
    if(params.get('type')!=='train'||!/^[1-9]\d{0,3}$/.test(offset)||params.get('limit')!=='100')throw fail('INVALID_REQUEST','平均路線情報の取得条件が不正です。',400);
    return {endpoint,params:{from:pair[0],to:pair[1],date,type:'train',offset,limit:'100'}};
  }
  const name=params.get('fixedRailList')||'';
  if(params.get('searchType')!=='plain'||!name.includes('京王')||name.length>160||/[\x00-\x1f\x7f:]/.test(name)||params.get('answerCount')!=='20'||params.get('searchCount')!=='20')throw fail('INVALID_REQUEST','経路探索の取得条件が不正です。',400);
  return {endpoint,params:{viaList:pair.join(':'),date,searchType:'plain',fixedRailList:name,answerCount:'20',searchCount:'20'}};
}

// API応答全体を転送せず、既存の予測処理が必要とする項目だけを返す。
function publicResult(data, endpoint) {
  if(endpoint==='rail')return {ResultSet:{max:number(data.ResultSet.max),Line:asArray(data.ResultSet.Line).map(line=>({Name:text(line.Name),Type:text(line.Type)}))}};
  return {ResultSet:{Course:asArray(data.ResultSet.Course).map(course=>({dataType:text(course.dataType),Route:asArray(course.Route).map(route=>({
    transferCount:number(route.transferCount),timeWalk:number(route.timeWalk),
    Line:asArray(route.Line).map(line=>({Name:text(line.Name),TypicalName:text(line.TypicalName),Type:text(line.Type),timeOnBoard:number(line.timeOnBoard),stopStationCount:number(line.stopStationCount)})),
    Point:asArray(route.Point).map(point=>({Station:{Name:text(point.Station?.Name)}}))
  }))}))}};
}
function redact(value, key) {
  if(typeof value==='string')return [...new Set([key,encodeURIComponent(key)])].reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),value);
  if(Array.isArray(value))return value.map(item=>redact(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,redact(item,key)]));
  return value;
}
function jstDate(now) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('');
}

export function createHandler({fetch:fetcher=globalThis.fetch, getKey=()=>process.env.EKISPERT_API_KEY, now=()=>new Date(), timeoutMs=8000}={}) {
  async function upstream(endpoint, params, key) {
    const url=new URL(endpoint,API_BASE);url.searchParams.set('key',key);
    for(const [name,value]of Object.entries(params))url.searchParams.set(name,value);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      // Origin/Refererを偽装しない。登録ドメイン制限は公開環境で実際に確認する。
      const response=await fetcher(url.href.replace(/%3A/gi,':'),{headers:{Accept:'application/json'},signal:controller.signal,redirect:'error'});
      if(!response.ok) {
        if([401,403].includes(response.status))throw fail('UPSTREAM_AUTH_FAILED',`駅すぱあとAPIの認証に失敗しました（HTTP ${response.status}）。キー・契約・Netlify Functionsからの接続に対する登録ドメイン制限を確認してください。`,502,response.status);
        throw fail('UPSTREAM_HTTP_ERROR',`駅すぱあとAPIへの接続に失敗しました（HTTP ${response.status}）。`,502,response.status);
      }
      let data;
      try {data=await response.json();}catch {throw fail('INVALID_UPSTREAM_RESPONSE','駅すぱあとAPIの応答を読み取れません。',502);}
      if(!data?.ResultSet||data.ResultSet.Error)throw fail('UPSTREAM_API_ERROR','駅すぱあとAPIがエラーを返しました。',502);
      return {data,status:response.status};
    } catch(error) {
      if(controller.signal.aborted)throw fail('UPSTREAM_TIMEOUT','駅すぱあとAPIとの通信がタイムアウトしました。',504);
      if(failures.has(error))throw error;
      throw fail('UPSTREAM_UNAVAILABLE','駅すぱあとAPIとの通信に失敗しました。',502);
    } finally {clearTimeout(timer);}
  }
  return async request => {
    if(request.method!=='GET')return json({error:fail('METHOD_NOT_ALLOWED','GETでアクセスしてください。',405)},405,{Allow:'GET'});
    try {
      const {endpoint,params}=validate(new URL(request.url).searchParams);
      const key=getKey()?.trim();
      if(!key)return json({error:fail('MISSING_API_KEY','Netlify Functionsに EKISPERT_API_KEY が未設定です。環境変数のFunctionsスコープと再デプロイを確認してください。',503)},503);
      if(endpoint==='diagnostics') {
        const checkedAt=now(),date=jstDate(checkedAt);
        const tests=[['rail',{from:'桜上水',to:'笹塚',type:'train',date,offset:'1',limit:'100'}],
          ['search/course/extreme',{viaList:'桜上水:笹塚',searchType:'plain',date,answerCount:'1',searchCount:'1'}]];
        const checks=await Promise.all(tests.map(async([name,values])=>{
          try {const result=await upstream(name,values,key);return {endpoint:name,ok:true,upstreamStatus:result.status};}
          catch(error){return {endpoint:name,ok:false,code:error.code,message:error.message,...(error.upstreamStatus?{upstreamStatus:error.upstreamStatus}:{})};}
        }));
        return json({ok:checks.every(check=>check.ok),checkedAt:checkedAt.toISOString(),checks});
      }
      const result=await upstream(endpoint,params,key);
      return json(redact(publicResult(result.data,endpoint),key));
    } catch(error) {
      const safe=failures.has(error)?error:fail('FUNCTION_ERROR','API接続処理でエラーが発生しました。',500);
      return json({error:safe},safe.status);
    }
  };
}

export default createHandler();
