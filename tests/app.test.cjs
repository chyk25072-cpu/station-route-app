// Node.js標準機能だけで実行: node --test tests/app.test.cjs
// 実ブラウザの代わりになるものではない。日時・判断・画面更新の回帰検証用。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
process.env.TZ = "Asia/Tokyo";
const source = fs.readFileSync(path.join(__dirname, "../script.js"), "utf8");
const at = time => new Date(`2026-10-05T${time}+09:00`).getTime();
const flush = () => new Promise(resolve => setImmediate(resolve));

// 小さなDOM代替でイベントとテキスト差分更新を検証する。
async function app(start = "18:03:00") {
  let now = at(start);
  let interval;
  const documentEvents = new Map();
  const elements = new Map();
  class Element {
    constructor(value = "") {
      this.value = value;
      this.textContent = "";
      this.dataset = {};
      this.children = [];
      this.events = new Map();
      this.hidden = true;
      this.writes = 0;
    }
    addEventListener(event, handler) { this.events.set(event, handler); }
    dispatch(event) { this.events.get(event)?.({ preventDefault() {} }); }
    set innerHTML(html) {
      this.html = html;
      this.writes++;
      this.children = [];
      for (const match of html.matchAll(/<(?:strong|span|time)\b([^>]*\bdata-[^>]*)>/g)) {
        const child = new Element();
        for (const attribute of match[1].matchAll(/data-([a-z-]+)(?:="([^"]*)")?/g)) {
          const key = attribute[1].replace(/-([a-z])/g, (_, character) => character.toUpperCase());
          child.dataset[key] = attribute[2] || "";
        }
        this.children.push(child);
      }
    }
    get innerHTML() { return this.html || ""; }
    replaceChildren() { this.innerHTML = ""; }
  }
  for (const id of ["conditions", "departure", "mode", "clock", "recommendation-title", "recommendation-details", "comparison", "error", "now", "walk-sakurajosui", "walk-shimotakaido"]) elements.set(id, new Element());
  elements.get("walk-sakurajosui").value = "9";
  elements.get("walk-shimotakaido").value = "8";
  elements.get("conditions").checkValidity = () => elements.get("departure").value !== "" &&
    ["walk-sakurajosui", "walk-shimotakaido"].every(id => elements.get(id).value !== "");
  const example = new Element();
  example.dataset.time = "18:16:00";
  const document = {
    activeElement: null, hidden: false,
    getElementById: id => elements.get(id),
    addEventListener: (event, handler) => documentEvents.set(event, handler),
    querySelectorAll(selector) {
      if (selector === "[data-time]") return [example];
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      return [...elements.values()].flatMap(element => element.children).filter(element => Object.hasOwn(element.dataset, key));
    }
  };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({ document, Date: ClockDate, console, setInterval(handler) { interval = handler; } });
  vm.runInContext(source, context);
  await flush();
  return {
    elements, document, context, example,
    run: code => vm.runInContext(code, context),
    setNow: time => { now = at(time); },
    async tick() { interval(); await flush(); },
    async resume() { document.hidden = false; documentEvents.get("visibilitychange")(); await flush(); },
    async manual(time) {
      const input = elements.get("departure");
      document.activeElement = input;
      input.dispatch("focus");
      input.value = `2026-10-05T${time}`;
      input.dispatch("input");
      await flush();
    },
    async plan(time, walks = [9, 8]) {
      context.reference = at(time);
      context.walks = walks;
      return await vm.runInContext(`trainProvider.getTrains({start: reference, end: reference + SEARCH_DURATION}).then(trains => compareRoutes(stations.map((station, index) => calculateRoute(station, walks[index], reference, trains))))`, context);
    }
  };
}

test("2駅の優位・同着・後発列車の最早到着", async () => {
  const a = await app();
  for (const [time, station, gap] of [["18:03:00", "shimotakaido", 2], ["18:07:00", "sakurajosui", 3], ["18:16:00", "sakurajosui", 3]]) {
    const plan = await a.plan(time);
    assert.equal(plan.winners[0].station.id, station);
    assert.equal(plan.difference, gap * 60000);
  }
  const tied = await a.plan("18:50:00");
  assert.equal(tied.winners.length, 2);
  assert.equal(tied.winners[0].train.arrival, tied.winners[1].train.arrival);
  await a.manual("18:50:00");
  assert.equal(a.elements.get("recommendation-title").textContent, "どちらの駅でも笹塚への到着は同じ");
  assert.ok(!a.elements.get("recommendation-details").innerHTML.includes("0分早い"));
  assert.equal(a.document.querySelectorAll("[data-countdown]").length, 6); // 上部2駅×2種類と比較2駅
  const later = await a.plan("18:16:00");
  assert.equal(later.winners[0].firstTrain.departure, at("18:25:00"));
  assert.equal(later.winners[0].train.departure, at("18:30:00"));
  assert.equal(later.winners[0].train.arrival, at("18:35:00"));
  await a.manual("18:16:00");
  assert.match(a.elements.get("recommendation-details").innerHTML, /先に出る電車より笹塚に10分早く到着/);
});

test("発車と乗車可能時刻の一致・1秒遅れ・大学の出発期限", async () => {
  const a = await app("18:06:00");
  const exact = await a.plan("18:06:00");
  assert.equal(exact.routes[0].boardingTime, at("18:15:00"));
  assert.equal(exact.routes[0].train.departure, at("18:15:00"));
  assert.equal(exact.routes[0].deadline, at("18:06:00"));
  const late = await a.plan("18:06:01");
  assert.equal(late.routes[0].train.departure, at("18:20:00"));
  a.setNow("18:06:01");
  await a.tick();
  assert.match(a.elements.get("recommendation-details").innerHTML, /18:20:00発/);
  assert.ok(!a.elements.get("recommendation-details").innerHTML.includes("18:15:00発"));
});

test("乗り逃し: 次の列車と後発の最早到着・重複なし・歩行再加算なし", async () => {
  const a = await app();
  const plan = await a.plan("18:07:00");
  const route = plan.routes[0];
  assert.equal(route.train.departure, at("18:20:00"));
  assert.equal(route.nextTrain.departure, at("18:25:00"));
  assert.equal(route.nextTrain.arrival - route.train.arrival, 20 * 60000);
  assert.equal(route.missedBest.departure, at("18:30:00"));
  assert.equal(route.missedBest.arrival - route.train.arrival, 10 * 60000);
  await a.manual("18:07:00");
  assert.match(a.elements.get("comparison").innerHTML, /推奨列車より20分遅い/);
  assert.match(a.elements.get("comparison").innerHTML, /推奨列車より10分遅い/);
  assert.equal((a.elements.get("comparison").innerHTML.match(/乗り逃した場合の最早到着候補/g) || []).length, 1);
  const longWalk = (await a.plan("18:07:00", [14, 8])).routes[0];
  assert.equal(longWalk.train.departure, at("18:30:00"));
  assert.equal(longWalk.nextTrain.departure, at("18:35:00"));
});

test("検索範囲2時間の境界と次候補なし", async () => {
  const a = await app();
  a.context.reference = at("18:00:00");
  const trains = await a.run("trainProvider.getTrains({start: reference, end: reference + SEARCH_DURATION})");
  assert.ok(trains.some(train => train.departure === at("20:00:00")));
  assert.ok(trains.every(train => train.departure <= at("20:00:00") && train.departure >= at("18:00:00")));
  a.context.trains = trains;
  const route = a.run("calculateRoute(stations[0], 120, reference, trains)");
  assert.equal(route.train.departure, at("20:00:00"));
  assert.equal(route.nextTrain, null);
  assert.equal(route.missedBest, null);
  const html = a.run("routeHTML(calculateRoute(stations[0],120,reference,trains),compareRoutes([calculateRoute(stations[0],120,reference,trains)]),reference)");
  assert.match(html, /検索範囲内に次の候補なし/);
  const none = await a.plan("18:00:01", [120, 120]);
  assert.equal(none.winners.length, 0);
});

test("日付・月・年またぎと翌日表示、秒省略と不正日時", async () => {
  const a = await app();
  const plan = await a.plan("23:58:00");
  assert.equal(plan.winners[0].train.arrival, new Date("2026-10-06T00:18:00+09:00").getTime());
  assert.equal(a.run("formatTime(parseDateTime('2026-10-06T00:13:00'),parseDateTime('2026-10-05T23:58:00'))"), "翌日 00:13:00");
  assert.equal(a.run("parseDateTime('2026-10-05T18:03')"), at("18:03:00"));
  assert.ok(Number.isNaN(a.run("parseDateTime('2026-02-30T18:03:00')")));
  assert.ok(Number.isNaN(a.run("parseDateTime('')")));
  assert.equal(a.run("formatTime(parseDateTime('2027-01-01T00:03:00'),parseDateTime('2026-12-31T23:58:00'))"), "翌日 00:03:00");
  await a.manual("23:58:00");
  assert.match(a.elements.get("comparison").innerHTML, /翌日/);
});

test("毎秒のカウントダウンは差分更新、カードを再生成しない", async () => {
  const a = await app();
  const details = a.elements.get("recommendation-details");
  const comparison = a.elements.get("comparison");
  const before = [details.writes, comparison.writes];
  const counts = a.document.querySelectorAll("[data-countdown]");
  assert.equal(counts[0].textContent, "あと2分0秒");
  assert.equal(counts[1].textContent, "あと10分0秒");
  const focus = a.elements.get("walk-sakurajosui");
  a.document.activeElement = focus;
  a.setNow("18:03:01");
  await a.tick();
  assert.equal(counts[0].textContent, "あと1分59秒");
  assert.equal(counts[1].textContent, "あと9分59秒");
  assert.deepEqual([details.writes, comparison.writes], before);
  assert.equal(a.document.activeElement, focus);
});

test("現在モードとテストモード、入力保護と現在時刻に戻す", async () => {
  const a = await app();
  await a.manual("18:03:30");
  assert.equal(a.run("state.mode"), "test");
  assert.match(a.elements.get("recommendation-details").innerHTML, /指定時刻からの残り時間/);
  assert.equal(a.document.querySelectorAll("[data-countdown]")[0].textContent, "あと1分30秒");
  a.setNow("19:00:00");
  await a.tick();
  assert.equal(a.elements.get("departure").value, "2026-10-05T18:03:30");
  assert.equal(a.document.querySelectorAll("[data-countdown]")[0].textContent, "あと1分30秒");
  a.elements.get("now").dispatch("click");
  await flush();
  assert.equal(a.run("state.mode"), "live");
  assert.equal(a.elements.get("departure").value, "2026-10-05T19:00:00");
  a.example.dispatch("click");
  await flush();
  assert.equal(a.run("state.mode"), "test");
  assert.match(a.elements.get("departure").value, /18:16:00$/);
});

test("タブ復帰は実時刻との差で再計算し、期限切れ列車を切り替える", async () => {
  const a = await app();
  a.document.hidden = true;
  a.setNow("18:05:30"); // タイマーが一度も呼ばれなかったと仮定。
  await a.resume();
  assert.equal(a.elements.get("recommendation-title").textContent, "今は桜上水駅へ向かう");
  assert.equal(a.document.querySelectorAll("[data-countdown]")[0].textContent, "あと0分30秒");
  assert.equal(a.document.querySelectorAll("[data-countdown]")[1].textContent, "あと9分30秒");
  await a.manual("18:03:30");
  a.setNow("20:00:00");
  await a.resume();
  assert.equal(a.elements.get("departure").value, "2026-10-05T18:03:30");
  assert.equal(a.document.querySelectorAll("[data-countdown]")[0].textContent, "あと1分30秒");
});

test("不正入力は古い結果を消去し、有効な入力で復帰", async () => {
  const a = await app();
  a.elements.get("walk-sakurajosui").value = "";
  await a.run("updateResults()");
  assert.equal(a.elements.get("error").hidden, false);
  assert.equal(a.elements.get("comparison").innerHTML, "");
  a.elements.get("walk-sakurajosui").value = "9.5";
  await a.run("updateResults()");
  assert.equal(a.elements.get("error").hidden, false);
  a.elements.get("walk-sakurajosui").value = "9";
  await a.run("updateResults()");
  assert.equal(a.elements.get("error").hidden, true);
  assert.match(a.elements.get("comparison").innerHTML, /桜上水駅/);
});
