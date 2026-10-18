"use strict";

const MINUTE = 60 * 1000;
const SEARCH_DURATION = 120 * MINUTE;
const stations = [
  { id: "sakurajosui", name: "桜上水駅", inputId: "walk-sakurajosui", defaultMinutes: 9 },
  { id: "shimotakaido", name: "下高井戸駅", inputId: "walk-shimotakaido", defaultMinutes: 8 }
];

// 毎時繰り返す動作確認用データ。分単位の発車は必ず00秒にする。
// :25の各停（:45着）より、:30の急行（:35着）が早く着く仮のケース。
const mockTimetable = [
  { stationId: "sakurajosui", departureMinute: 0, type: "各駅停車", duration: 8 },
  { stationId: "sakurajosui", departureMinute: 9, type: "各駅停車", duration: 18 },
  { stationId: "sakurajosui", departureMinute: 15, type: "急行", duration: 5 },
  { stationId: "sakurajosui", departureMinute: 20, type: "急行", duration: 5 },
  { stationId: "sakurajosui", departureMinute: 25, type: "各駅停車", duration: 20 },
  { stationId: "sakurajosui", departureMinute: 30, type: "急行", duration: 5 },
  { stationId: "sakurajosui", departureMinute: 35, type: "各駅停車", duration: 8 },
  { stationId: "sakurajosui", departureMinute: 50, type: "急行", duration: 5 },
  ...[3, 13, 23, 33, 43, 53].map(departureMinute => ({
    stationId: "shimotakaido", departureMinute, type: "各駅停車", duration: 5
  }))
];

// 1. 現在日時をブラウザから秒単位で取得。計算は日時のミリ秒値で行う。
function currentTime() {
  return Math.floor(Date.now() / 1000) * 1000;
}
const pad = value => String(value).padStart(2, "0");
function datePart(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function timePart(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function inputDateTime(timestamp) {
  const date = new Date(timestamp);
  return `${datePart(date)}T${timePart(date)}`;
}
function parseDateTime(value) {
  // datetime-localはタイムゾーンを持たないため、ブラウザのローカル日時として読む。
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part || 0));
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  // 2/30などが自動補正されて別の日になるのを防ぐ。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return NaN;
  return date.getTime();
}
function formatTime(timestamp, reference) {
  const date = new Date(timestamp);
  const base = new Date(reference);
  // 暦の日付で比較するので、24時間未満の日付またぎも正しく表示する。
  const dayNumber = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  const days = dayNumber(date) - dayNumber(base);
  const prefix = days === 1 ? "翌日 " : days === 0 ? "" : `${datePart(date)} `;
  const time = timePart(date);
  return prefix + (globalThis.RailwayApp?.settings.showSeconds === false ? time.slice(0, 5) : time);
}
function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const remainder = seconds % 60;
  return `${Math.floor(seconds / 60)}分${remainder ? `${remainder}秒` : ""}`;
}
function countdown(target, reference) {
  // 毎秒1を引かず、対象日時との差を毎回求める。タブ復帰後もずれない。
  const remaining = Math.ceil((target - reference) / 1000);
  if (remaining < 0) return "期限を過ぎました";
  return `あと${Math.floor(remaining / 60)}分${remaining % 60}秒`;
}

// データ取得口。将来API化しても、判断処理には同じ形式の配列を渡せる。
// 各列車に出発駅・発車日時・種別・笹塚到着日時を持たせる。
const trainProvider = {
  async getTrains({ start, end }) {
    if (typeof window !== "undefined" && !globalThis.RailwayApp) {
      throw new Error("時刻表管理の初期化に失敗しました。初期データとスクリプトの読込を確認してください。");
    }
    // 検索は常に同じ取得口へ。旧配列は独立した回帰テストのみに残す。
    if (globalThis.RailwayApp) {
      return RailwayApp.getTrains({ start, end });
    }
    const trains = [];
    const hour = new Date(start);
    hour.setMinutes(0, 0, 0);
    while (hour.getTime() <= end) {
      for (const entry of mockTimetable) {
        const departure = hour.getTime() + entry.departureMinute * MINUTE;
        if (departure < start || departure > end) continue;
        trains.push({
          stationId: entry.stationId,
          departureStation: stations.find(station => station.id === entry.stationId).name,
          departure, type: entry.type, destination: "笹塚駅", arrival: departure + entry.duration * MINUTE
        });
      }
      hour.setHours(hour.getHours() + 1);
    }
    return trains;
  }
};

function earliestArrival(trains) {
  // 同じ到着なら先に発車する列車を選ぶ。元の配列を変更しない。
  return trains.filter(train => Number.isFinite(train.arrival)).sort((a, b) => a.arrival - b.arrival || a.departure - b.departure)[0] || null;
}
function calculateRoute(station, walkingMinutes, departureTime, trains) {
  // 2. 構内移動込みの所要時間だけを加算。余裕時間などは追加しない。
  const boardingTime = departureTime + walkingMinutes * MINUTE;
  const searchEnd = departureTime + SEARCH_DURATION;
  // 3. 最初の電車だけに限定せず、2時間以内の乗車可能な全列車を探索する。
  const candidates = trains.filter(train => train.stationId === station.id &&
    train.departure >= boardingTime && train.departure <= searchEnd)
    .sort((a, b) => a.departure - b.departure);
  const firstTrain = candidates[0] || null;
  const knownBest = earliestArrival(candidates);
  const train = knownBest || firstTrain;
  const unknownTrains = candidates.filter(candidate => !Number.isFinite(candidate.arrival));
  const deadline = train ? train.departure - walkingMinutes * MINUTE : null;
  // 乗り逃し候補は乗車場所にいる前提。大学からの時間を再加算しない。
  const later = train ? trains.filter(candidate => candidate.stationId === station.id &&
    candidate.departure > train.departure && candidate.departure <= searchEnd)
    .sort((a, b) => a.departure - b.departure) : [];
  return { station, walkingMinutes, boardingTime, firstTrain, train, deadline, unknownTrains,
    nextTrain: later[0] || null, missedBest: earliestArrival(later) };
}
function compareRoutes(routes) {
  // 4. 駅ごとの最早到着を比較。同着なら両駅を結果に残す。
  const available = routes.filter(route => route.train && Number.isFinite(route.train.arrival))
    .sort((a, b) => a.train.arrival - b.train.arrival);
  const bestArrival = available[0]?.train.arrival;
  const winners = available.filter(route => route.train.arrival === bestArrival);
  const other = available.find(route => route.train.arrival !== bestArrival);
  const uncertain = routes.some(route => route.unknownTrains.some(train => bestArrival === undefined || train.departure <= bestArrival));
  return { routes, winners, uncertain, difference: other ? other.train.arrival - bestArrival : null };
}

// ここから画面処理。計算関数はDOMに依存しないので、単体で検証できる。
const ui = {
  form: document.getElementById("conditions"), departure: document.getElementById("departure"),
  mode: document.getElementById("mode"), clock: document.getElementById("clock"),
  title: document.getElementById("recommendation-title"), details: document.getElementById("recommendation-details"),
  comparison: document.getElementById("comparison"), error: document.getElementById("error")
};
const state = { mode: "live", signature: "", request: 0 };
const destinationName = () => globalThis.RailwayApp?.destinationName() || "笹塚駅";
const originLabel = () => !globalThis.RailwayApp || RailwayApp.originName() === "日本大学文理学部" ? "大学" : "出発地";
function reliabilityHTML(train) {
  return globalThis.RailwayApp?.reliabilityHTML(train) || "";
}
function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}
function laterTrainReason(route, reference) {
  if (!route.firstTrain || !Number.isFinite(route.firstTrain.arrival) || !Number.isFinite(route.train.arrival) || route.firstTrain.departure >= route.train.departure || route.firstTrain.arrival <= route.train.arrival) return "";
  return `<p class="reason">先に出る電車より${destinationName().replace(/駅$/, "")}に${formatDuration(route.firstTrain.arrival - route.train.arrival)}早く到着<span>${formatTime(route.firstTrain.departure, reference)}発 ${route.firstTrain.type} → ${formatTime(route.firstTrain.arrival, reference)}着を見送ります。</span></p>`;
}
function heroRoute(route, reference) {
  return `<div class="hero-route"><h2>${route.station.name}から · ${formatTime(route.train.departure, reference)}発 ${route.train.type}</h2>
    ${reliabilityHTML(route.train)}
    ${globalThis.RailwayApp?.transferHTML(route.train) || ""}
    ${laterTrainReason(route, reference)}
    <div class="countdowns"><div><span>${originLabel()}を出るまで</span><strong data-countdown="${route.deadline}"></strong><small>${formatTime(route.deadline, reference)}までに出発</small></div>
    <div><span>電車の発車まで</span><strong data-countdown="${route.train.departure}"></strong><small>${formatTime(route.train.departure, reference)}発</small></div></div></div>`;
}
function missedTrainHTML(label, train, route, reference) {
  const comparable = Number.isFinite(train.arrival) && Number.isFinite(route.train.arrival);
  const difference = comparable ? train.arrival - route.train.arrival : null;
  const delay = !comparable ? "到着差は未計算" : difference === 0 ? "推奨列車と同じ到着" : `${route.unknownTrains.length ? "この列車より" : "推奨列車より"}${formatDuration(difference)}遅い`;
  return `<div class="missed-option"><h5>${label}</h5><p><strong>${formatTime(train.departure, reference)}発</strong> · ${train.type}</p><p>${destinationName()} ${Number.isFinite(train.arrival) ? formatTime(train.arrival, reference) + "着" : "到着未登録"}<span class="delay">${delay}</span></p>${reliabilityHTML(train)}${globalThis.RailwayApp?.transferHTML(train) || ""}</div>`;
}
function routeHTML(route, plan, reference) {
  const { station, walkingMinutes, train } = route;
  const isWinner = !plan.uncertain && plan.winners.includes(route);
  const hasArrival = train && Number.isFinite(train.arrival);
  const tag = isWinner ? (plan.winners.length > 1 ? "同着" : "おすすめ") : "";
  return `<article class="route ${isWinner ? "winner" : ""}">
    <div class="route-head"><h3>${station.name}</h3>${tag ? `<span class="route-tag">${tag}</span>` : ""}</div>
    <ol class="timeline">
      <li><time data-reference-time></time><div>${originLabel()}を出発<small>徒歩・構内移動 ${walkingMinutes}分</small></div></li>
      <li><time data-boarding-offset="${walkingMinutes * MINUTE}"></time><div>電車に乗れる場所に到着<small>${train ? `<span data-wait-until="${train.departure}" data-walk="${walkingMinutes * MINUTE}"></span>待ち` : "検索範囲内に乗車可能な列車なし"}</small></div></li>
      ${train ? `<li><time>${formatTime(train.departure, reference)}</time><div>${train.type}に乗車</div></li><li><time>${hasArrival ? formatTime(train.arrival, reference) : "未登録"}</time><div>${destinationName()} ${hasArrival ? "到着予定" : "到着時刻なし"}</div></li>` : ""}
    </ol>
    ${!train && globalThis.RailwayApp ? RailwayApp.diagnosticsHTML(station.id) : ""}
    ${train ? `${hasArrival ? `<p class="route-total">出発地から <strong data-total-until="${train.arrival}"></strong></p>` : '<p class="hint">発車時刻のみのデータです。到着は補完していません。</p>'}
      ${reliabilityHTML(train)}
      ${globalThis.RailwayApp?.transferHTML(train) || ""}
      <p class="route-deadline">${formatTime(route.deadline, reference)}までに${originLabel()}を出発<br><span data-countdown="${route.deadline}"></span></p>
      ${laterTrainReason(route, reference)}
      <div class="missed"><h4>乗り逃したら</h4><p class="hint">すでにこの駅の乗車場所にいる前提</p>
      ${route.nextTrain ? missedTrainHTML("次に発車する電車", route.nextTrain, route, reference) : '<p class="hint">検索範囲内に次の候補なし</p>'}
      ${route.missedBest && route.missedBest !== route.nextTrain ? missedTrainHTML(route.nextTrain && Number.isFinite(route.nextTrain.arrival) ? "乗り逃した場合の最早到着候補" : "到着が分かる次の候補", route.missedBest, route, reference) : ""}</div>` : ""}
    </article>`;
}
function renderPlan(plan, reference) {
  const best = plan.winners[0];
  if (!best) {
    const candidates = plan.routes.filter(route => route.train);
    setText(ui.title, candidates.length ? "発車候補が見つかりました" : "検索範囲内に乗車可能な列車なし");
    ui.details.innerHTML = candidates.length ? '<p>到着時刻が未登録のため、最適な駅は比較できません。</p>' + candidates.map(route => heroRoute(route, reference)).join("") : '<p>出発日時から2時間以内の電車がありません。日時や徒歩時間を変更してください。</p>';
    if (globalThis.RailwayApp && !candidates.length) {
      const reasons = document.createElement("p");
      reasons.className = "reliability";
      reasons.textContent = RailwayApp.diagnostics().join(" / ");
      ui.details.append(reasons);
    }
  } else {
    const tied = plan.winners.length > 1;
    setText(ui.title, plan.uncertain ? "到着が分かる候補を表示" : tied ? `どちらの駅でも${destinationName().replace(/駅$/, "")}への到着は同じ` : `今は${best.station.name}へ向かう`);
    const other = plan.routes.find(route => !plan.winners.includes(route) && route.train);
    const advantage = plan.uncertain ? "到着未登録の候補があるため、比較は未確定です" : tied ? "両駅の列車・出発期限を確認できます" : other ? `${other.station.name}より${formatDuration(plan.difference)}早い` : "他の駅には検索範囲内の乗車候補がありません";
    ui.details.innerHTML = `<div class="arrival-summary"><span>${destinationName()}への到着</span><strong>${formatTime(best.train.arrival, reference)}</strong><span class="advantage">${advantage}</span></div>
      <p class="countdown-context">${state.mode === "test" ? "指定時刻からの残り時間（時刻は固定）" : "現在時刻からの残り時間（毎秒更新）"}</p>
      ${plan.winners.map(route => heroRoute(route, reference)).join("")}`;
  }
  ui.comparison.innerHTML = plan.routes.map(route => routeHTML(route, plan, reference)).join("");
}
function refreshTimes(reference) {
  // 選ばれた列車が変わらない秒には、必要なテキストだけを更新する。
  // 入力欄やカードを毎秒作り直さず、フォーカス・入力操作を保つ。
  document.querySelectorAll("[data-countdown]").forEach(element => setText(element, countdown(Number(element.dataset.countdown), reference)));
  document.querySelectorAll("[data-reference-time]").forEach(element => setText(element, formatTime(reference, reference)));
  document.querySelectorAll("[data-boarding-offset]").forEach(element => setText(element, formatTime(reference + Number(element.dataset.boardingOffset), reference)));
  document.querySelectorAll("[data-wait-until]").forEach(element => setText(element, formatDuration(Number(element.dataset.waitUntil) - reference - Number(element.dataset.walk))));
  document.querySelectorAll("[data-total-until]").forEach(element => setText(element, formatDuration(Number(element.dataset.totalUntil) - reference)));
}
function showError(message) {
  setText(ui.error, message);
  ui.error.hidden = false;
  if (state.signature !== "invalid") {
    setText(ui.title, "出発の条件を確認してください");
    ui.details.replaceChildren();
    ui.comparison.replaceChildren();
    state.signature = "invalid";
  }
}
async function updateResults() {
  const request = ++state.request;
  const reference = state.mode === "live" ? currentTime() : parseDateTime(ui.departure.value);
  if (state.mode === "live" && document.activeElement !== ui.departure) ui.departure.value = inputDateTime(reference);
  setText(ui.mode, state.mode === "live" ? "現在時刻モード" : "テストモード · 固定日時");
  setText(ui.clock, Number.isFinite(reference) ? inputDateTime(reference).replace("T", " ") : "日時を入力してください");
  const walkingTimes = stations.map(station => Number(document.getElementById(station.inputId).value));
  const selectedCandidates = globalThis.RailwayApp?.candidates();
  if (selectedCandidates && new Set(selectedCandidates.map(station => station.id)).size !== selectedCandidates.length) {
    showError("比較する駅は異なる2駅を選択してください。");
    return;
  }
  if (!Number.isFinite(reference) || !ui.form.checkValidity() || walkingTimes.some(time => !Number.isInteger(time) || time < 0 || time > 120)) {
    showError("出発地・日時と、0〜120の整数の徒歩時間を入力してください。");
    return;
  }
  ui.error.hidden = true;
  try {
    const trains = await trainProvider.getTrains({ start: reference, end: reference + SEARCH_DURATION });
    if (request !== state.request) return; // 将来API化しても、古い応答で上書きしない。
    const candidates = selectedCandidates;
    const searchStations = stations.map((station, index) => ({...station, ...candidates?.[index]}));
    const plan = compareRoutes(searchStations.map((station, index) => calculateRoute(station, walkingTimes[index], reference, trains)));
    // 出発期限を過ぎた列車は探索から外れるため、自動で次の候補に切り替わる。
    const signature = JSON.stringify({ mode: state.mode, day: datePart(new Date(reference)), walkingTimes,
      settings: globalThis.RailwayApp?.settings, destination: destinationName(), reasons: globalThis.RailwayApp?.diagnostics(),
      origin: globalThis.RailwayApp?.originName(), uncertain: plan.uncertain,
      routes: plan.routes.map(route => [route.train, route.firstTrain, route.nextTrain, route.missedBest]) });
    if (signature !== state.signature) {
      renderPlan(plan, reference);
      state.signature = signature;
    }
    refreshTimes(reference);
  } catch (error) {
    if (request !== state.request) return;
    showError("列車データを取得できませんでした。もう一度日時を設定してください。");
    console.error(error);
  }
}
function enterTestMode() {
  state.mode = "test";
  updateResults();
}
function returnToCurrentTime() {
  state.mode = "live";
  ui.departure.value = inputDateTime(currentTime());
  updateResults();
}
// 日時欄にフォーカスした時点で固定し、編集中の値を毎秒上書きしない。
ui.departure.addEventListener("focus", enterTestMode);
ui.departure.addEventListener("input", enterTestMode);
ui.departure.addEventListener("change", enterTestMode);
ui.form.addEventListener("input", updateResults);
ui.form.addEventListener("submit", async event => { event.preventDefault(); await updateResults(); document.getElementById("result")?.scrollIntoView?.({behavior:"smooth",block:"start"}); });
document.getElementById("now").addEventListener("click", returnToCurrentTime);
document.querySelectorAll("[data-time]").forEach(button => button.addEventListener("click", () => {
  globalThis.RailwayApp?.useLegacyDemo();
  const base = Number.isFinite(parseDateTime(ui.departure.value)) ? parseDateTime(ui.departure.value) : currentTime();
  ui.departure.value = `${datePart(new Date(base))}T${button.dataset.time}`;
  stations.forEach(station => { document.getElementById(station.inputId).value = station.defaultMinutes; });
  enterTestMode();
}));
setInterval(() => { if (state.mode === "live") updateResults(); }, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateResults(); // バックグラウンドでタイマーが止まっても直ちに再計算。
});
document.addEventListener("railwaychange", updateResults);
returnToCurrentTime();
