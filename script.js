"use strict";

// 駅数が増えても同じ計算を使えるよう、駅を配列で管理する。
const stations = [
  { id: "sakurajosui", name: "桜上水駅", inputId: "walk-sakurajosui" },
  { id: "shimotakaido", name: "下高井戸駅", inputId: "walk-shimotakaido" }
];

// 動作確認専用の毎時繰り返す仮ダイヤ。実際の運行情報ではない。
// departureMinute は毎時の発車分、duration は笹塚までの所要分。
const mockTimetable = [
  { stationId: "sakurajosui", departureMinute: 0, type: "各駅停車", duration: 8 },
  { stationId: "sakurajosui", departureMinute: 15, type: "急行", duration: 5 },
  { stationId: "sakurajosui", departureMinute: 20, type: "急行", duration: 5 },
  { stationId: "sakurajosui", departureMinute: 35, type: "各駅停車", duration: 8 },
  { stationId: "sakurajosui", departureMinute: 50, type: "急行", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 3, type: "各駅停車", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 13, type: "各駅停車", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 23, type: "各駅停車", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 33, type: "各駅停車", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 43, type: "各駅停車", duration: 5 },
  { stationId: "shimotakaido", departureMinute: 53, type: "各駅停車", duration: 5 }
];

// 時刻は「当日0時からの分」で計算する。1440以上も保持し、翌日を扱う。
function parseTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}
function formatTime(minutes) {
  const day = Math.floor(minutes / 1440);
  const hour = Math.floor(minutes / 60) % 24;
  return `${day > 0 ? "翌日 " : ""}${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 1. ブラウザのローカル時刻を取得する。テスト用に入力欄で変更できる。
function setCurrentTime() {
  const now = new Date();
  document.getElementById("departure").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// データ取得と判断処理を分離。将来はこの関数をAPI取得に置き換える。
// 出力する電車には出発駅・発車時刻・種別・目的地到着時刻をすべて持たせる。
async function getTrains(departureTime) {
  const firstHour = Math.floor(departureTime / 60);
  const trains = [];
  for (let hour = firstHour; hour <= firstHour + 4; hour++) {
    for (const entry of mockTimetable) {
      const departure = hour * 60 + entry.departureMinute;
      trains.push({ stationId: entry.stationId,
        departureStation: stations.find(station => station.id === entry.stationId).name,
        departure, type: entry.type, destination: "笹塚駅", arrival: departure + entry.duration });
    }
  }
  return trains;
}

function calculateRoute(station, walkingMinutes, departureTime, trains) {
  // 2. 現在時刻に徒歩時間を加算して、駅への到着時刻を求める。
  const stationArrival = departureTime + walkingMinutes;
  // 3. 駅到着以降に発車する電車を、発車時刻順に探す。
  const train = trains.filter(train => train.stationId === station.id && train.departure >= stationArrival)
    .sort((a, b) => a.departure - b.departure)[0];
  return { station, walkingMinutes, stationArrival, train };
}

let latestRequest = 0;
async function updateResults() {
  const request = ++latestRequest;
  const form = document.getElementById("conditions");
  const error = document.getElementById("error");
  if (!form.checkValidity()) {
    error.textContent = "出発時刻と、0〜120の整数の徒歩時間を入力してください。";
    error.hidden = false;
    document.getElementById("result").innerHTML = '<h1 id="recommendation-title">出発の条件を確認してください</h1>';
    document.getElementById("comparison").replaceChildren();
    return;
  }
  error.hidden = true;
  const departureTime = parseTime(document.getElementById("departure").value);
  const walkingTimes = stations.map(station => Number(document.getElementById(station.inputId).value));
  const trains = await getTrains(departureTime);
  if (request !== latestRequest) return; // API化した際にも古い応答で画面を上書きしない。
  const routes = stations.map((station, index) => calculateRoute(station, walkingTimes[index], departureTime, trains));
  // 4. 各駅の「最初に乗れる電車」の最終到着時刻を比較する。
  const available = routes.filter(route => route.train).sort((a, b) => a.train.arrival - b.train.arrival);
  const best = available[0];
  const second = available[1];
  if (!best) {
    document.getElementById("result").innerHTML = '<h1 id="recommendation-title">乗車できる電車がありません</h1><p>時刻や徒歩時間を変更してください。</p>';
  } else {
    const difference = second ? second.train.arrival - best.train.arrival : null;
    const tied = difference === 0;
    document.getElementById("result").innerHTML = `
      <p class="eyebrow">${formatTime(departureTime)} に大学を出るなら</p>
      <h1 id="recommendation-title">${tied ? "どちらの駅でも同じ到着" : `今は${best.station.name}へ向かう`}</h1>
      <span class="advantage">${tied ? "笹塚への到着時刻は同じです" : difference === null ? "乗車可能な電車があるルートです" : `${second.station.name}より ${difference}分早い`}</span>
      <div class="train-summary"><div>${tied ? best.station.name + "を選ぶ場合" : "乗る電車"}<strong>${formatTime(best.train.departure)} 発 · ${best.train.type}</strong></div><div>笹塚駅に到着<strong>${formatTime(best.train.arrival)}</strong></div><div>駅に到着予定<strong>${formatTime(best.stationArrival)}</strong></div></div>`;
  }
  document.getElementById("comparison").innerHTML = routes.map(route => {
    const { station, walkingMinutes, stationArrival, train } = route;
    const isBest = best && train && train.arrival === best.train.arrival;
    return `<article class="route ${isBest ? "winner" : ""}">
      <div class="route-head"><h3>${station.name}</h3>${isBest ? `<span class="route-tag">${second && second.train.arrival === best.train.arrival ? "同着" : "おすすめ"}</span>` : ""}</div>
      <ol class="timeline">
        <li><time>${formatTime(departureTime)}</time><div>大学を出発<small>徒歩 ${walkingMinutes}分</small></div></li>
        <li><time>${formatTime(stationArrival)}</time><div>${station.name}に到着<small>${train ? `電車待ち ${train.departure - stationArrival}分` : "乗車可能な電車なし"}</small></div></li>
        ${train ? `<li><time>${formatTime(train.departure)}</time><div>${train.type}に乗車<small>笹塚駅まで ${train.arrival - train.departure}分</small></div></li><li><time>${formatTime(train.arrival)}</time><div>笹塚駅に到着</div></li>` : ""}
      </ol><p class="route-total">大学からの所要時間 ${train ? `<strong>${train.arrival - departureTime}分</strong>` : "—"}</p></article>`;
  }).join("");
}

document.getElementById("conditions").addEventListener("input", updateResults);
document.getElementById("conditions").addEventListener("submit", event => event.preventDefault());
document.getElementById("now").addEventListener("click", () => { setCurrentTime(); updateResults(); });
document.querySelectorAll("[data-time]").forEach(button => button.addEventListener("click", () => {
  document.getElementById("departure").value = button.dataset.time;
  stations.forEach((station, index) => { document.getElementById(station.inputId).value = [9, 8][index]; });
  updateResults();
}));
setCurrentTime();
updateResults();
