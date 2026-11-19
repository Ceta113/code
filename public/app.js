"use strict";

// ============================================================ 기본 도구
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); return true; } catch { return false; } },
};
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function makeToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
let token = store.get("pc-token");
if (!token || !/^[a-f0-9]{32}$/.test(token)) {
  token = makeToken();
  store.set("pc-token", token);
}

// 이름마다 고정 색 (밤/낮 둘 다에서 읽히는 차분한 색)
const PALETTE = ["#7fa8e0", "#5fc0b5", "#d4a35f", "#a993d9", "#e08f8f", "#8fbf6f", "#6cc0e0", "#d9a3c7"];
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// 이야기 본문: "대사"는 진하게, *지문*은 기울여서
const STORY_RE = /("[^"\n]{1,400}"|“[^”\n]{1,400}”|「[^」\n]{1,400}」|『[^』\n]{1,400}』|\*[^*\n]{1,400}\*)/g;
function storyNodes(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(STORY_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    frag.append(tok.startsWith("*") ? el("span", "em", tok.slice(1, -1)) : el("span", "dlg", tok));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// ============================================================ 상태
let ws = null;
let joinInfo = null;
let joined = false;
let stopped = false;
let reconnectDelay = 1000;
let state = null;
let log = [];
let roomKey = null;
let pending = null; // { inputs, comp: {id,name,text}|null, text, kind }
let pendingRestore = null;
let prevDraft = null;
let settingsDirty = false;
let editingN = null;
let sideTab = "party";
let builtOptions = false;
let lastHostView = null;
let lastSubmitted = store.get("pc-last") || "";

const me = () => state?.members.find((m) => m.id === state.you);
const isHost = () => Boolean(state && state.hostId === state.you);
const firstPart = (s) => String(s).split(" · ")[0].trim();
const modelLabel = (m) => (m === "mock" ? "테스트" : String(m || "").replace("claude-", "").replace(/-(\d+)-(\d+)$/, " $1.$2"));

// ============================================================ 테마
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const light = document.documentElement.dataset.theme === "light";
  $("theme-icon").setAttribute("href", light ? "#i-moon" : "#i-sun");
  document.querySelector('meta[name="theme-color"]').content = light ? "#eef1f6" : "#0e1320";
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set("pc-theme", next);
  applyTheme(next);
}
applyTheme(document.documentElement.dataset.theme);
$("theme-btn").onclick = toggleTheme;

// ============================================================ 입장
const WORDS_A = ["달빛", "안개", "모래", "새벽", "구름", "바람", "서리", "등불", "은빛", "들꽃"];
const WORDS_B = ["여우", "수달", "까마귀", "고래", "사슴", "부엉이", "고양이", "늑대", "참새", "두더지"];
const pick = (arr) => arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];
const randomCode = () => `${pick(WORDS_A)}${pick(WORDS_B)}-${String(crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000)}`;

const joinForm = $("join-form");
const presetOf = () => joinForm.elements.namedItem("preset").value;
$("j-name").value = store.get("pc-name") || "";
$("j-persona").value = store.get("pc-persona") || "";
$("j-access").value = store.get("pc-access", sessionStorage) || "";
const savedRoom = store.get("pc-room", sessionStorage);
if (savedRoom) {
  joinForm.elements.namedItem("preset").value = "join";
  $("j-room").value = savedRoom;
}
function syncJoinMode() {
  const joining = presetOf() === "join";
  $("room-label").replaceChildren("방 코드 ", el("small", null, joining ? "친구에게 받은 코드" : "친구에게 알려 줄 코드"));
  $("room-random").hidden = joining;
  $("join-btn").textContent = joining ? "들어가기" : presetOf() === "solo" ? "혼자 시작하기" : "방 만들기";
  $("j-room").placeholder = joining ? "예: 달빛여우-4821" : "";
  if (!joining && !$("j-room").value) $("j-room").value = randomCode();
}
joinForm.addEventListener("change", (e) => {
  if (e.target.name !== "preset") return;
  if (e.target.value === "join") $("j-room").value = savedRoom || "";
  else if (!$("j-room").value || $("j-room").value === savedRoom) $("j-room").value = randomCode();
  syncJoinMode();
});
$("room-random").onclick = () => ($("j-room").value = randomCode());
syncJoinMode();

fetch("config")
  .then((r) => r.json())
  .then((cfg) => {
    $("access-field").hidden = !cfg.needsAccess;
    $("mock-note").hidden = !cfg.mock;
  })
  .catch(() => {});

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const preset = presetOf();
  joinInfo = {
    access: $("j-access").value,
    room: $("j-room").value.trim(),
    name: $("j-name").value.trim(),
    persona: $("j-persona").value.trim(),
    preset: preset === "join" ? undefined : preset,
  };
  $("join-error").textContent = "";
  $("join-btn").disabled = true;
  store.set("pc-name", joinInfo.name);
  store.set("pc-persona", joinInfo.persona);
  stopped = false;
  connect();
});

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = location.pathname.replace(/[^/]*$/, "");
  ws = new WebSocket(`${proto}//${location.host}${base}ws`);
  ws.onopen = () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ t: "join", token, ...joinInfo }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    if (stopped || !joined) {
      $("join-btn").disabled = false;
      return;
    }
    setStatus("연결이 끊겼어요. 다시 잇는 중…");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}
function sendMsg(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else toast("연결이 끊겨 있어요. 잠시 후 다시 해 주세요.", true);
}
function leave(message) {
  stopped = true;
  joined = false;
  ws?.close();
  $("app").hidden = true;
  $("join-screen").hidden = false;
  state = null;
  log = [];
  pending = null;
  builtOptions = false;
  lastHostView = null;
  if (message) $("join-error").textContent = message;
}

// ============================================================ 서버 메시지
function handle(msg) {
  switch (msg.t) {
    case "join_error":
      if (joined) leave(msg.text);
      else {
        $("join-error").textContent = msg.text;
        $("join-btn").disabled = false;
        stopped = true;
        ws.close();
      }
      break;
    case "joined":
      if (!joined && joinInfo.preset && !msg.created) toast("이미 있는 방 코드라서 그 방으로 들어갔어요.");
      joined = true;
      roomKey = msg.roomKey;
      joinInfo.preset = undefined; // 재접속 때는 유형을 다시 보내지 않는다
      store.set("pc-room", joinInfo.room, sessionStorage);
      store.set("pc-access", joinInfo.access, sessionStorage);
      $("invite-code").textContent = joinInfo.room;
      $("join-screen").hidden = true;
      $("app").hidden = false;
      $("join-btn").disabled = false;
      if (msg.isNewRoom) {
        const backup = readBackup();
        pendingRestore = backup?.log?.some((e) => e.type === "turn") ? backup : null;
      }
      break;
    case "state":
      state = msg;
      renderState();
      break;
    case "log":
      log = msg.log || [];
      if (log.some((e) => e.type === "turn")) {
        pendingRestore = null;
        writeBackup();
      }
      renderFeed();
      renderState();
      break;
    case "gen_start":
      pending = { inputs: (msg.inputs || []).slice(), comp: null, text: "", kind: msg.kind, resumed: msg.resumed };
      renderFeed(true);
      renderLive();
      break;
    case "comp_start":
      if (!pending) break;
      pending.comp = { id: msg.id, name: msg.name, text: "" };
      renderFeed();
      renderLive();
      break;
    case "comp_delta":
      if (!pending?.comp) break;
      pending.comp.text += msg.text;
      updateLive("live-comp", pending.comp.text, false);
      break;
    case "comp_end":
      if (!pending) break;
      pending.inputs.push({ name: msg.name, text: msg.text, ai: true });
      pending.comp = null;
      renderFeed();
      renderLive();
      break;
    case "delta":
      if (!pending) break;
      pending.text += msg.text;
      updateLive("live-story", pending.text, true);
      break;
    case "gen_end":
      pending = null;
      renderFeed();
      renderLive();
      break;
    case "notice":
      toast(msg.text, msg.kind === "error");
      addOoc({ system: true, text: msg.text, kind: msg.kind, at: Date.now() }, true);
      break;
    case "error":
      toast(msg.text, true);
      break;
    case "ooc":
      addOoc(msg.entry);
      break;
    case "ooc_history":
      $("ooc-list").replaceChildren();
      (msg.entries || []).forEach((e) => addOoc(e, true));
      if (!msg.entries?.length) $("ooc-list").append(el("p", "ooc-empty", "진행자는 못 보는 우리끼리 대화방이에요."));
      break;
    case "roll_result":
      attachToInput(msg.text);
      toast(`주사위 ${msg.total} — 행동 끝에 붙여 뒀어요.`);
      break;
    case "kicked":
      leave("방장이 방에서 내보냈어요.");
      break;
    case "replaced":
      leave("다른 탭에서 같은 방에 들어가서 이 탭은 연결을 끊었어요.");
      break;
  }
}

// ============================================================ 상단 · 파티 · 상태
function statusOf(m) {
  if (!m.connected) return { cls: "off", label: "자리 비움" };
  if (m.submitted) return m.passed ? { cls: "passed", label: "지켜봄" } : { cls: "done", label: "냈음" };
  return { cls: "", label: "쓰는 중" };
}

function renderState() {
  if (!state) return;
  const s = state.settings;
  const host = isHost();
  const gen = Boolean(state.generating);
  const active = state.members.filter((m) => m.connected);
  const done = active.filter((m) => m.submitted).length;
  const hasTurn = log.some((e) => e.type === "turn");
  if (lastHostView !== host) {
    lastHostView = host;
    renderFeed();
  }

  document.title = `${s.title} · 파티챗`;
  $("room-title").textContent = s.title;
  $("room-sub").textContent = `${state.turn}턴째 · ${firstPart(state.options.models[s.model] || s.model)}`;
  renderLive();

  // 입력창 위 현황
  const roster = $("roster");
  roster.replaceChildren();
  for (const m of state.members) {
    const st = statusOf(m);
    const span = el("span", st.cls, m.name);
    if (m.id === state.you) span.append(el("em", null, " (나)"));
    span.title = st.label;
    roster.append(span);
  }
  for (const c of s.companions) roster.append(el("span", "ai", `${c.name} · AI`));

  renderPeople();

  // 방장 도구
  $("host-line").hidden = !host;
  $("advance-btn").disabled = gen;
  $("regen-btn").disabled = gen || !hasTurn;
  $("undo-btn").disabled = gen || !hasTurn;
  $("stop-btn").hidden = !gen;
  $("advance-btn").hidden = gen;
  $("advance-btn").textContent = s.mode === "host" ? "다음 장면으로" : "기다리지 않고 진행";

  // 내 입력
  const draft = state.yourDraft;
  const input = $("action-input");
  if (draft !== prevDraft) {
    if (draft === null && prevDraft !== null && !input.value.startsWith("/")) input.value = "";
    else if (draft && document.activeElement !== input) input.value = draft;
    prevDraft = draft;
  }
  input.disabled = gen;
  $("action-form").classList.toggle("locked", gen);
  $("submit-btn").disabled = gen;
  $("pass-btn").disabled = gen;
  $("submit-btn").textContent = draft ? "고쳐 내기" : "내기";
  $("unsubmit-btn").hidden = draft === null || gen;

  if (gen) setStatus(liveText());
  else if (draft !== null) {
    const waiting = s.mode === "all" ? `다른 사람을 기다리는 중 · ${done}/${active.length}` : `방장이 넘기면 이어져요 · ${done}/${active.length}`;
    setStatus(`${draft ? "냈어요" : "이번엔 지켜봐요"}. ${waiting}`);
  } else if (active.length === 1 && s.companions.length) {
    setStatus(`내면 ${s.companions.map((c) => c.name).join(", ")}이(가) 이어서 움직여요.`);
  } else {
    setStatus(s.mode === "all" ? `모두 내면 다음 장면이 나와요 · ${done}/${active.length}` : `방장이 넘기면 다음 장면이 나와요 · ${done}/${active.length}`);
  }

  $("restore-banner").hidden = !(host && pendingRestore && !hasTurn);
  document.querySelectorAll(".host-only").forEach((n) => (n.hidden = !host));
  renderSnips();
  renderSettings();
  syncDockHeight();
}

function liveText() {
  if (!pending && !state?.generating) return "";
  if (pending?.comp) return `${pending.comp.name}이(가) 생각하는 중`;
  return pending?.kind === "regen" ? "진행자가 다시 쓰는 중" : "진행자가 쓰는 중";
}
function renderLive() {
  const on = Boolean(state?.generating || pending);
  $("live").classList.toggle("on", on);
  $("live-text").textContent = on ? liveText() : "대기 중";
  if (on) setStatus(liveText() + "…");
}

function renderPeople() {
  const list = $("people");
  list.replaceChildren();
  const host = isHost();
  for (const m of state.members) {
    const st = statusOf(m);
    const li = el("li", "person" + (m.connected ? "" : " off"));
    const ini = el("span", "initial", [...m.name][0]);
    ini.style.setProperty("--c", colorOf(m.name));
    li.append(ini);
    const body = el("div", "body");
    const top = el("div", "top");
    top.append(el("span", "name", m.name));
    if (m.id === state.hostId) top.append(el("span", "tag", "방장"));
    if (m.id === state.you) top.append(el("span", "tag", "나"));
    top.append(el("span", "state " + st.cls, st.label));
    body.append(top);
    if (m.persona) body.append(el("div", "persona", m.persona));
    if (host && m.id !== state.you) {
      const tools = el("div", "tools");
      const tr = el("button", "link", "방장 넘기기");
      tr.disabled = !m.connected;
      tr.onclick = () => confirm(`${m.name}님에게 방장을 넘길까요?`) && sendMsg({ t: "transfer", id: m.id });
      const kick = el("button", "link danger", "내보내기");
      kick.onclick = () => confirm(`${m.name}님을 내보낼까요? 이 방에 다시 들어올 수 없어요.`) && sendMsg({ t: "kick", id: m.id });
      tools.append(tr, kick);
      body.append(tools);
    }
    li.append(body);
    list.append(li);
  }
  for (const c of state.settings.companions) {
    const li = el("li", "person");
    const ini = el("span", "initial ai", [...c.name][0]);
    ini.style.setProperty("--c", colorOf(c.name));
    li.append(ini);
    const body = el("div", "body");
    const top = el("div", "top");
    top.append(el("span", "name", c.name), el("span", "tag ai", "AI 동료"));
    body.append(top);
    if (c.persona) body.append(el("div", "persona", c.persona));
    li.append(body);
    list.append(li);
  }
  for (let i = state.members.length; i < state.settings.maxPlayers; i++) {
    list.append(el("li", "slot", "빈자리 · 방 코드로 초대할 수 있어요"));
  }
}

function setStatus(text) {
  $("status").textContent = text;
}
function syncDockHeight() {
  document.documentElement.style.setProperty("--dock-h", $("dock").offsetHeight + "px");
}
new ResizeObserver(syncDockHeight).observe($("dock"));

$("copy-invite").onclick = async () => {
  const text = `파티챗에서 같이 해요!\n주소: ${location.origin}${location.pathname}\n방 코드: ${joinInfo?.room}\n"친구 방에 들어가기"를 고르고 방 코드를 넣으면 돼요.`;
  try {
    await navigator.clipboard.writeText(text);
    toast("초대 문구를 복사했어요.");
  } catch {
    prompt("아래 문구를 복사해서 보내 주세요.", text);
  }
};

// ============================================================ 이야기
const feed = $("feed");
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
  $("jump-btn").hidden = true;
}
feed.addEventListener("scroll", () => nearBottom() && ($("jump-btn").hidden = true));
$("jump-btn").onclick = scrollToBottom;

function actsBlock(inputs, liveComp) {
  const wrap = el("div", "acts");
  const myName = me()?.name;
  const add = (i, live) => {
    const row = el("div", "act" + (i.text || live ? "" : " passed") + (live ? " streaming" : ""));
    row.style.setProperty("--c", colorOf(i.name));
    const who = el("div", "who", i.name);
    if (i.ai) who.append(el("span", "tag ai", "AI"));
    if (!i.ai && i.name === myName) who.append(el("span", "me", "나"));
    const said = el("div", "said" + (live ? " caret" : ""), live ? i.text : i.text || "지켜봤다");
    if (live) said.id = "live-comp";
    row.append(who, said);
    wrap.append(row);
  };
  inputs.forEach((i) => add(i, false));
  if (liveComp) add({ name: liveComp.name, text: liveComp.text, ai: true }, true);
  return wrap;
}

function sceneBlock({ text, model, n, live, isLast }) {
  const art = el("article", "scene");
  if (!live && editingN === n) {
    const ta = el("textarea", "story-edit");
    ta.value = text;
    const actions = el("div", "edit-actions");
    const cancel = el("button", "btn sm", "취소");
    const save = el("button", "btn sm primary", "저장");
    cancel.onclick = () => { editingN = null; renderFeed(); };
    save.onclick = () => { sendMsg({ t: "editStory", n, text: ta.value }); editingN = null; };
    actions.append(cancel, save);
    art.append(ta, actions);
    return art;
  }
  if (live && !text) {
    art.append(el("p", "writing", pending?.comp ? "동료들이 움직이는 중" : "진행자가 쓰는 중"));
    return art;
  }
  const story = el("div", "story" + (live ? " caret" : ""));
  if (live) story.id = "live-story";
  story.append(storyNodes(text));
  art.append(story);
  if (!live) {
    const foot = el("div", "scene-foot");
    if (model) foot.append(el("span", null, modelLabel(model)));
    if (isHost() && !pending) {
      const edit = el("button", "link", "고치기");
      edit.onclick = () => { editingN = n; renderFeed(); };
      foot.append(edit);
      if (isLast) {
        const re = el("button", "link", "다시 쓰기");
        re.onclick = () => sendMsg({ t: "regen" });
        foot.append(re);
      }
    }
    if (foot.childElementCount) art.append(foot);
  }
  return art;
}

const SCENARIOS = [
  {
    tag: "판타지",
    title: "안개 낀 수도원",
    blurb: "버려진 수도원에 밤마다 불이 켜진다",
    systemPrompt:
      "배경: 왕국 북쪽 국경, 늘 안개가 끼는 회색 산맥. 산꼭대기에 50년 전 버려진 '성 오렌 수도원'이 있다.\n최근 마을 사람들이 밤마다 수도원 창에 불이 켜지는 걸 보았고, 확인하러 간 사냥꾼 둘이 돌아오지 않았다.\n분위기: 조용하고 서늘한 다크 판타지. 마법은 드물고 위험하며 늘 대가가 따른다.\n주요 인물: 수도원지기 노인 '베른'(무언가를 숨기고 있다), 마을 여관 주인 '하나'(사라진 사냥꾼의 누나).\n진행: 싸움보다 탐색과 단서, 긴장감 위주로. 수도원의 진실은 천천히 드러낸다.",
    opening:
      "안개가 무릎까지 차오른 산길 끝에서 성 오렌 수도원의 검은 윤곽이 드러났다. 바람이 멎자 들리는 건 서로의 숨소리와, 어딘가에서 규칙적으로 울리는 쇠붙이 소리뿐이다.\n\n정문은 반쯤 열려 있었다. 문틈 너머 안뜰 한가운데, 아직 온기가 남은 모닥불 자국이 보인다.",
  },
  {
    tag: "현대 괴담",
    title: "폐교 3층 방송실",
    blurb: "철거 전날 밤, 동창들이 모교에 모였다",
    systemPrompt:
      "배경: 지금의 한국, 지방 소도시의 폐교 '서림중학교'. 졸업한 지 10년 된 동창들이 철거 전 마지막으로 학교를 찾았다.\n졸업하던 해, 3층 방송실에서 같은 반 '윤서'가 사라졌고 끝내 찾지 못했다. 다들 그 얘기는 꺼내지 않는다.\n분위기: 평범한 대화 사이로 조금씩 스며드는 괴담. 잔인한 묘사 대신 소리, 기척, 어긋난 기억으로 무섭게.\n규칙: 자정이 되면 학교 방송이 저절로 켜지고, 10년 전 그날의 목소리가 흘러나온다.\n주요 인물: 학교를 오래 지킨 경비 '박 씨', 방송 속 목소리.",
    opening:
      "철거 예정 현수막이 바람에 펄럭였다. 운동장 가로등 하나만 깜빡이고, 본관 창문은 모두 까맣다. 단톡방에서 '진짜 오는 거지?'를 연달아 보내던 사람들은 결국 다 모였다.\n\n정문 자물쇠는 누군가 이미 열어 둔 상태였다. 그리고 3층, 방송실 창에만 희미한 초록 불빛이 켜져 있다.",
  },
  {
    tag: "무협",
    title: "비 오는 객잔",
    blurb: "배가 끊긴 밤, 객잔에 수상한 손님들이 모였다",
    systemPrompt:
      "배경: 강호. 정파와 사파의 다툼이 잠잠해진 지 3년, 장강 나루터 근처의 '청풍객잔'.\n장대비로 배가 끊겨 손님들이 객잔에 발이 묶였다. 그런데 오늘 밤, 무림맹이 쫓던 '혈수첩'이 이 객잔 어딘가에 숨겨져 있다는 소문이 돈다.\n분위기: 고전 무협 소설체. 초식과 기세 묘사를 살리되 대화와 수 싸움이 중심.\n주요 인물: 겉보기엔 평범한 객잔 주인 '왕노삼', 구석 자리의 맹인 악사, 검은 삿갓을 쓴 여검객 '설연'.\n진행: 누가 혈수첩을 노리는지 쉽게 드러내지 않는다.",
    opening:
      "빗줄기가 처마를 두드리는 소리가 객잔 안의 웅성거림을 덮었다. 젖은 도롱이를 벗어 든 손님들이 하나둘 자리를 잡고, 주인 왕노삼이 데운 술을 내왔다.\n\n구석 자리의 맹인 악사가 줄을 고르다 말고 고개를 들었다. \"오늘 밤엔 손님이 많구려. 칼 냄새도 많고.\"",
  },
];

function blankState() {
  const box = el("div", "blank");
  if (isHost()) {
    box.append(el("h2", null, "아직 첫 장면 전이에요."));
    box.append(
      el(
        "p",
        null,
        "설정에 세계관과 첫 장면을 적어 두면 진행자가 그 위에서 이야기를 시작해요. 아무것도 안 적고 첫 행동부터 내도 괜찮아요. 막막하면 아래 이야기 중 하나로 시작해 보세요.",
      ),
    );
    const list = el("div", "scenarios");
    for (const sc of SCENARIOS) {
      const b = el("button", "scenario");
      b.append(el("b", null, sc.title), el("span", null, `${sc.tag} · ${sc.blurb}`), el("em", null, "이걸로 시작"));
      b.onclick = () => {
        const cur = state.settings;
        if ((cur.systemPrompt.trim() || cur.opening.trim()) && !confirm("지금 적힌 세계관과 첫 장면을 바꿀까요?")) return;
        sendMsg({ t: "settings", settings: { title: sc.title, systemPrompt: sc.systemPrompt, opening: sc.opening } });
      };
      list.append(b);
    }
    box.append(list);
  } else {
    box.append(el("h2", null, "방장이 무대를 준비하고 있어요."));
    box.append(el("p", null, "그동안 첫 행동을 생각해 두세요. 내 캐릭터 설명은 파티 탭에서 고칠 수 있어요."));
  }
  return box;
}

function renderFeed(forceStick) {
  const inner = $("feed-inner");
  const stick = forceStick || nearBottom() || !inner.childElementCount;
  inner.replaceChildren();
  if (!log.length && !pending) inner.append(blankState());
  const lastTurn = log.filter((e) => e.type === "turn").at(-1);

  for (const e of log) {
    if (e.type === "opening") {
      const sec = el("section", "prologue");
      sec.append(el("div", "label", "첫 장면"));
      sec.append(sceneBlock({ text: e.text, n: 0 }));
      inner.append(sec);
    } else if (e.type === "turn") {
      inner.append(el("div", "turn", `${e.n}턴`));
      if (e.inputs?.length) inner.append(actsBlock(e.inputs));
      inner.append(sceneBlock({ text: e.story, model: e.model, n: e.n, isLast: e === lastTurn }));
    }
  }

  if (pending) {
    const n = log.filter((e) => e.type === "turn").length + 1;
    inner.append(el("div", "turn", `${n}턴`));
    if (pending.inputs.length || pending.comp) inner.append(actsBlock(pending.inputs, pending.comp));
    inner.append(sceneBlock({ text: pending.text, live: true }));
  }

  if (stick) scrollToBottom();
  else if (pending) $("jump-btn").hidden = false;
}

function updateLive(id, text, isStory) {
  let node = $(id);
  if (!node) {
    renderFeed();
    node = $(id);
    if (!node) return;
  }
  const stick = nearBottom();
  if (isStory) node.replaceChildren(storyNodes(text));
  else node.textContent = text;
  if (stick) scrollToBottom();
  else $("jump-btn").hidden = false;
}

// ============================================================ 옆 칸
const app = $("app");
function openSide(tab) {
  if (tab) selectTab(tab);
  app.classList.add("show-side");
  $("menu-dot").hidden = true;
}
const closeSide = () => app.classList.remove("show-side");
$("menu-btn").onclick = () => (app.classList.contains("show-side") ? closeSide() : openSide());
$("side-close").onclick = closeSide;
$("scrim").onclick = closeSide;
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
function selectTab(tab) {
  sideTab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
  if (tab === "chat") {
    $("chat-dot").hidden = true;
    const list = $("ooc-list");
    list.scrollTop = list.scrollHeight;
  }
  if (tab === "settings") {
    settingsDirty = false;
    renderSettings();
  }
}
const sideVisible = () => window.innerWidth > 960 || app.classList.contains("show-side");

// ============================================================ 설정
const sf = (n) => $("settings-form").elements.namedItem(n);

function buildOptions() {
  if (builtOptions || !state) return;
  builtOptions = true;
  const models = $("model-list");
  models.replaceChildren();
  for (const [value, label] of Object.entries(state.options.models)) {
    const [name, desc] = label.split(" · ");
    const lab = el("label");
    const span = el("span");
    span.append(el("b", null, name), el("small", null, desc || ""));
    lab.append(Object.assign(el("input"), { type: "radio", name: "model", value }), span);
    models.append(lab);
  }
  for (const [id, name, opts] of [["choice-length", "length", state.options.lengths], ["choice-effort", "effort", state.options.efforts]]) {
    const box = $(id);
    box.replaceChildren();
    for (const [value, label] of Object.entries(opts)) {
      const lab = el("label");
      lab.title = label;
      lab.append(Object.assign(el("input"), { type: "radio", name, value }), el("span", null, firstPart(label)));
      box.append(lab);
    }
  }
}

const COMP_SUGGEST = [
  { name: "세라", persona: "말수가 적은 궁수. 관찰력이 좋아 위험을 먼저 알아채고, 필요한 말만 짧게 한다." },
  { name: "도윤", persona: "넉살 좋은 방패병. 분위기를 풀어 주는 농담을 잘하고, 동료가 위험하면 먼저 앞에 선다." },
  { name: "미오", persona: "호기심 많은 견습 연금술사. 엉뚱한 아이디어를 잘 내고 처음 보는 물건은 꼭 만져 본다." },
];

function compRow(c, disabled) {
  const row = el("div", "comp");
  row.dataset.id = c.id || "";
  const top = el("div", "row");
  const name = Object.assign(el("input"), { type: "text", value: c.name, maxLength: 20, placeholder: "이름", disabled });
  name.className = "c-name";
  const del = el("button", "link danger", "빼기");
  del.type = "button";
  del.disabled = disabled;
  del.onclick = () => {
    row.remove();
    settingsDirty = true;
    syncCompAdd();
  };
  top.append(name, del);
  const persona = Object.assign(el("textarea"), { value: c.persona, maxLength: 600, rows: 2, placeholder: "성격, 말투, 특기", disabled });
  persona.className = "c-persona";
  row.append(top, persona);
  return row;
}
function syncCompAdd() {
  const count = $("comp-list").childElementCount;
  $("comp-add").hidden = !isHost() || count >= (state?.options.maxCompanions || 3);
}
$("comp-add").onclick = () => {
  const used = new Set([...document.querySelectorAll(".c-name")].map((i) => i.value));
  const next = COMP_SUGGEST.find((c) => !used.has(c.name)) || { name: `동료${$("comp-list").childElementCount + 1}`, persona: "" };
  $("comp-list").append(compRow(next, false));
  settingsDirty = true;
  syncCompAdd();
};
const readCompanions = () =>
  [...document.querySelectorAll("#comp-list .comp")].map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector(".c-name").value,
    persona: row.querySelector(".c-persona").value,
  }));

function renderSettings() {
  if (!state) return;
  buildOptions();
  const host = isHost();
  $("settings-readonly").hidden = host;
  $("save-bar").hidden = !host;
  for (const field of $("settings-form").elements) if (field.name) field.disabled = !host;
  if (settingsDirty && host) return;
  const s = state.settings;
  for (const key of ["title", "systemPrompt", "opening", "memo", "model", "length", "effort", "mode"]) sf(key).value = s[key];
  sf("maxPlayers").value = String(s.maxPlayers);
  const ht = sf("historyTurns");
  if (![...ht.options].some((o) => o.value === String(s.historyTurns))) {
    const o = el("option", null, `최근 ${s.historyTurns}턴`);
    o.value = String(s.historyTurns);
    ht.append(o);
  }
  ht.value = String(s.historyTurns);
  $("comp-list").replaceChildren(...s.companions.map((c) => compRow(c, !host)));
  syncCompAdd();
}
$("settings-form").addEventListener("input", () => (settingsDirty = true));
$("settings-form").addEventListener("change", () => (settingsDirty = true));
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMsg({
    t: "settings",
    settings: {
      title: sf("title").value,
      systemPrompt: sf("systemPrompt").value,
      opening: sf("opening").value,
      memo: sf("memo").value,
      model: sf("model").value,
      length: sf("length").value,
      effort: sf("effort").value,
      mode: sf("mode").value,
      maxPlayers: Number(sf("maxPlayers").value),
      historyTurns: Number(sf("historyTurns").value),
      companions: readCompanions(),
    },
  });
  settingsDirty = false;
  toast("저장했어요.");
});

// ============================================================ 모달
document.querySelectorAll("dialog [data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

$("profile-btn").onclick = () => {
  const m = me();
  if (!m) return;
  $("p-name").value = m.name;
  $("p-persona").value = m.persona;
  $("profile-modal").showModal();
};
$("profile-form").addEventListener("submit", (e) => {
  const name = $("p-name").value.trim();
  const persona = $("p-persona").value.trim();
  if (!name) {
    e.preventDefault();
    return toast("닉네임을 적어 주세요.", true);
  }
  sendMsg({ t: "profile", name, persona });
  if (joinInfo) Object.assign(joinInfo, { name, persona });
  store.set("pc-name", name);
  store.set("pc-persona", persona);
});

// ============================================================ 잡담
function addOoc(entry, silent) {
  const list = $("ooc-list");
  list.querySelector(".ooc-empty")?.remove();
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  let row;
  if (entry.system) row = el("div", "c-sys" + (entry.kind === "error" ? " error" : ""), entry.text);
  else {
    row = el("div", "c-msg");
    const nick = el("span", "nick", entry.name);
    nick.style.setProperty("--c", colorOf(entry.name));
    row.append(nick, entry.text, el("time", null, new Date(entry.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })));
  }
  list.append(row);
  while (list.childElementCount > 300) list.firstChild.remove();
  if (stick || silent) list.scrollTop = list.scrollHeight;
  if (!silent && !entry.system && !(sideTab === "chat" && sideVisible())) {
    $("chat-dot").hidden = false;
    if (window.innerWidth <= 960) $("menu-dot").hidden = false;
  }
}
function sendOoc(text) {
  text = text.trim();
  if (!text) return;
  sendMsg({ t: "ooc", text });
}
$("ooc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendOoc($("ooc-input").value);
  $("ooc-input").value = "";
});

// ============================================================ 내 단축어
const DEFAULT_SNIPS = [
  { key: "관찰", text: "주변을 천천히 둘러보며 단서가 될 만한 것을 찾는다." },
  { key: "경계", text: "무기에 손을 얹은 채 주위를 경계한다." },
  { key: "대기", text: "숨을 고르며 다른 사람들의 움직임을 지켜본다." },
  { key: "질문", text: "가까이 다가가 지금 무슨 일인지 조심스럽게 묻는다." },
];
let snips;
try { snips = JSON.parse(store.get("pc-snips") || "null"); } catch { snips = null; }
if (!Array.isArray(snips)) snips = DEFAULT_SNIPS;

function renderSnips() {
  const box = $("snips");
  box.replaceChildren();
  const dice = el("button", "snip solid", "주사위 d20");
  dice.type = "button";
  dice.title = "d20을 굴려 결과를 행동 끝에 붙여요";
  dice.onclick = () => sendMsg({ t: "roll", expr: "d20" });
  box.append(dice);
  for (const s of snips) {
    const b = el("button", "snip", ";" + s.key);
    b.type = "button";
    b.title = s.text;
    b.onclick = () => insertAtCaret(s.text);
    box.append(b);
  }
  const edit = el("button", "snip", "단축어 편집");
  edit.type = "button";
  edit.onclick = openSnipModal;
  box.append(edit);
}

function snipRow(s = { key: "", text: "" }) {
  const row = el("div", "snip-row");
  const k = Object.assign(el("input"), { type: "text", value: s.key, maxLength: 12, placeholder: "이름" });
  const t = Object.assign(el("input"), { type: "text", value: s.text, maxLength: 300, placeholder: "바뀔 문장" });
  const d = el("button", "link danger", "삭제");
  d.type = "button";
  d.onclick = () => row.remove();
  row.append(k, t, d);
  return row;
}
function openSnipModal() {
  $("snip-rows").replaceChildren(...snips.map((s) => snipRow(s)));
  $("snip-modal").showModal();
}
$("snip-add").onclick = () => $("snip-rows").append(snipRow());
$("snip-form").addEventListener("submit", () => {
  snips = [...$("snip-rows").children]
    .map((r) => {
      const [k, t] = r.querySelectorAll("input");
      return { key: k.value.trim().replace(/^;/, "").replace(/\s+/g, ""), text: t.value.trim() };
    })
    .filter((s) => s.key && s.text);
  store.set("pc-snips", JSON.stringify(snips));
  renderSnips();
  toast("단축어를 저장했어요.");
});

function expandSnips(text) {
  return text.replace(/(^|\s);([^\s;]{1,12})(?=\s|$)/g, (all, pre, key) => {
    const s = snips.find((x) => x.key === key);
    return s ? pre + s.text : all;
  });
}

// ============================================================ 명령어
const COMMANDS = [
  { name: "주사위", alias: ["roll", "굴림"], arg: "d20", desc: "주사위를 굴려 결과를 행동에 붙여요", run: (a) => sendMsg({ t: "roll", expr: a || "d20" }) },
  { name: "지켜보기", alias: ["스킵", "skip"], desc: "이번 턴은 행동 없이 넘겨요", run: () => sendMsg({ t: "pass" }) },
  { name: "대사", alias: ["say"], arg: "할 말", need: true, desc: "따옴표를 붙여 대사로 내요", run: (a) => submitAction(a, "say") },
  { name: "잡담", alias: ["ooc"], arg: "내용", need: true, desc: "진행자 몰래 잡담방에 보내요", run: (a) => sendOoc(a) },
  { name: "진행", alias: ["go"], host: true, desc: "지금 낸 것만으로 장면을 써요", run: () => sendMsg({ t: "advance" }) },
  { name: "다시", alias: ["re", "재생성"], host: true, desc: "마지막 장면을 다시 써요", run: () => sendMsg({ t: "regen" }) },
  { name: "되돌리기", alias: ["undo"], host: true, desc: "마지막 턴을 지우고 행동 단계로", run: () => confirm("마지막 턴을 지울까요?") && sendMsg({ t: "undo" }) },
  { name: "멈춤", alias: ["stop"], host: true, desc: "쓰고 있는 장면을 멈춰요", run: () => sendMsg({ t: "stop" }) },
  { name: "메모", alias: ["memo"], host: true, arg: "기억할 내용", need: true, desc: "기억 메모에 한 줄 더해요", run: (a) => sendMsg({ t: "memoAdd", text: a }) },
  { name: "단축어", alias: ["snip"], desc: "내 단축어를 고쳐요", run: () => openSnipModal() },
  { name: "테마", alias: ["theme"], desc: "밤과 낮을 바꿔요", run: () => toggleTheme() },
  { name: "도움", alias: ["help", "?"], desc: "단축키와 명령어를 봐요", run: () => openHelp() },
];
const DICE_RE = /^\d{0,2}d\d{1,4}([+-]\d{1,4})?$/i;
const findCommand = (name) => {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.alias.includes(n));
};

function runCommandLine(line) {
  const input = $("action-input");
  if (line.startsWith("//")) {
    sendOoc(line.slice(2));
    input.value = "";
    return;
  }
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(line);
  if (!m) return;
  const [, name, rawArg] = m;
  const arg = rawArg.trim();
  if (DICE_RE.test(name)) {
    input.value = "";
    sendMsg({ t: "roll", expr: name });
    return;
  }
  const cmd = findCommand(name);
  if (!cmd) return toast("모르는 명령어예요. /도움 을 쳐 보세요.", true);
  if (cmd.host && !isHost()) return toast("방장만 쓸 수 있는 명령어예요.", true);
  if (cmd.need && !arg) {
    input.value = `/${cmd.name} `;
    return;
  }
  input.value = "";
  hidePalette();
  cmd.run(arg);
}

// 명령어 목록 (입력창에 / 를 치면)
let paletteItems = [];
let paletteSel = 0;
function updatePalette() {
  const v = $("action-input").value;
  if (!v.startsWith("/") || v.startsWith("//") || /\s/.test(v)) return hidePalette();
  const q = v.slice(1).toLowerCase();
  paletteItems = COMMANDS.filter((c) => (!c.host || isHost()) && (c.name.startsWith(q) || c.alias.some((a) => a.startsWith(q))));
  if (DICE_RE.test(q)) paletteItems.unshift({ name: q, desc: `${q} 굴리기`, dice: true });
  if (!paletteItems.length) return hidePalette();
  paletteSel = Math.min(paletteSel, paletteItems.length - 1);
  const pal = $("palette");
  pal.replaceChildren();
  paletteItems.forEach((c, i) => {
    const b = el("button", i === paletteSel ? "on" : "");
    b.type = "button";
    b.setAttribute("role", "option");
    b.append(el("b", null, "/" + c.name + (c.arg ? " " : "")), el("span", null, c.desc), el("em", null, c.host ? "방장" : c.arg ? c.arg : ""));
    b.onmousedown = (e) => {
      e.preventDefault();
      choosePalette(i);
    };
    pal.append(b);
  });
  pal.hidden = false;
}
function hidePalette() {
  $("palette").hidden = true;
  paletteItems = [];
  paletteSel = 0;
}
function choosePalette(i, viaTab = false) {
  const c = paletteItems[i];
  if (!c) return;
  if (c.dice) return runCommandLine("/" + c.name);
  if (c.need || (c.arg && viaTab)) {
    $("action-input").value = `/${c.name} `;
    hidePalette();
    $("action-input").focus();
    return;
  }
  runCommandLine("/" + c.name);
}

// ============================================================ 행동 입력
const actionInput = $("action-input");
const kindOf = () => $("action-form").elements.namedItem("kind").value;
function setKind(k) {
  $("action-form").elements.namedItem("kind").value = k;
  actionInput.placeholder = k === "say" ? "할 말을 적어요. 따옴표는 알아서 붙어요." : "무엇을 할까요?";
}
$("action-form").addEventListener("change", (e) => {
  if (e.target.name === "kind") {
    setKind(kindOf());
    actionInput.focus();
  }
});

function insertAtCaret(text) {
  const i = actionInput;
  const start = i.selectionStart ?? i.value.length;
  const end = i.selectionEnd ?? i.value.length;
  const before = i.value.slice(0, start);
  const sep = before && !/\s$/.test(before) ? " " : "";
  i.value = before + sep + text + i.value.slice(end);
  const pos = (before + sep + text).length;
  i.focus();
  i.setSelectionRange(pos, pos);
}
function attachToInput(text) {
  const i = actionInput;
  i.value = i.value.trim() ? `${i.value.trim()} ${text}` : `${text} `;
  i.focus();
  i.setSelectionRange(i.value.length, i.value.length);
}

actionInput.addEventListener("input", (e) => {
  // ;단축어 + 띄어쓰기 → 문장으로 바꾸기
  if (e.data === " " || e.inputType === "insertLineBreak") {
    const pos = actionInput.selectionStart;
    const before = actionInput.value.slice(0, pos);
    const expanded = expandSnips(before);
    if (expanded !== before) {
      actionInput.value = expanded + actionInput.value.slice(pos);
      actionInput.setSelectionRange(expanded.length, expanded.length);
    }
  }
  updatePalette();
});

const coarse = window.matchMedia("(pointer: coarse)").matches;
actionInput.addEventListener("keydown", (e) => {
  const palOpen = !$("palette").hidden;
  if (palOpen) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      paletteSel = (paletteSel + (e.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length;
      updatePalette();
      return;
    }
    if ((e.key === "Enter" && !e.isComposing && e.keyCode !== 229) || e.key === "Tab") {
      e.preventDefault();
      choosePalette(paletteSel, e.key === "Tab");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hidePalette();
      return;
    }
  }
  if (e.key === "ArrowUp" && !actionInput.value && lastSubmitted) {
    e.preventDefault();
    actionInput.value = lastSubmitted;
    return;
  }
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  if (e.ctrlKey || e.metaKey) return; // 전역 단축키에서 처리
  if (coarse || e.shiftKey) return; // 모바일은 줄바꿈, PC는 Shift+Enter 줄바꿈
  e.preventDefault();
  $("action-form").requestSubmit();
});
actionInput.addEventListener("blur", () => setTimeout(hidePalette, 120));

function submitAction(text, kind = kindOf()) {
  text = expandSnips(text.trim());
  if (!text) return;
  if (kind === "say" && !/^["“「『]/.test(text)) text = `“${text}”`;
  lastSubmitted = text;
  store.set("pc-last", text);
  actionInput.value = text;
  sendMsg({ t: "submit", text });
  actionInput.blur();
}
$("action-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = actionInput.value.trim();
  if (text.startsWith("/")) return runCommandLine(text);
  if (!text) return toast("행동이나 대사를 적어 주세요. 넘기려면 '이번엔 지켜보기'를 눌러요.");
  submitAction(text);
});
$("pass-btn").onclick = () => sendMsg({ t: "pass" });
$("unsubmit-btn").onclick = () => {
  sendMsg({ t: "unsubmit" });
  actionInput.focus();
};

$("advance-btn").onclick = () => sendMsg({ t: "advance" });
$("regen-btn").onclick = () => confirm("마지막 장면을 같은 행동으로 다시 쓸까요?") && sendMsg({ t: "regen" });
$("undo-btn").onclick = () => confirm("마지막 턴을 지우고 행동 단계로 돌아갈까요?") && sendMsg({ t: "undo" });
$("stop-btn").onclick = () => sendMsg({ t: "stop" });

// ============================================================ 전역 단축키
const KEYS = [
  [[["Enter"]], "내기 (PC)"],
  [[["Shift", "Enter"]], "줄 바꾸기"],
  [[["↑"]], "빈 입력창에서 마지막에 낸 행동 다시 불러오기"],
  [[["Alt", "1"], ["Alt", "2"]], "행동 / 대사 바꾸기"],
  [[["Ctrl", "Enter"]], "기다리지 않고 진행 (방장)"],
  [[["Ctrl", "/"]], "이 도움말"],
  [[["Esc"]], "명령어 목록이나 메뉴 닫기"],
];
function openHelp() {
  const table = $("help-table");
  table.replaceChildren();
  const addRow = (a, b) => {
    const tr = el("tr");
    const td1 = el("td");
    td1.append(a);
    tr.append(td1, el("td", null, b));
    table.append(tr);
  };
  for (const [combos, d] of KEYS) {
    const frag = document.createDocumentFragment();
    combos.forEach((combo, ci) => {
      if (ci) frag.append(" / ");
      combo.forEach((k, ki) => {
        if (ki) frag.append(" + ");
        frag.append(el("kbd", null, k));
      });
    });
    addRow(frag, d);
  }
  for (const c of COMMANDS) {
    const code = el("code", null, `/${c.name}${c.arg ? ` [${c.arg}]` : ""}`);
    addRow(code, c.desc + (c.host ? " (방장)" : ""));
  }
  addRow(el("code", null, "/2d6, /d100+5"), "원하는 주사위를 바로 굴려요");
  addRow(el("code", null, "//할 말"), "잡담방에 바로 보내요");
  addRow(el("code", null, ";단축어"), "내 단축어 문장으로 바꿔요 (띄어쓰면)");
  $("help-modal").showModal();
}
$("help-btn").onclick = openHelp;

document.addEventListener("keydown", (e) => {
  if (!joined) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "/") {
    e.preventDefault();
    openHelp();
  } else if (mod && e.key === "Enter" && isHost() && !state?.generating) {
    e.preventDefault();
    sendMsg({ t: "advance" });
  } else if (e.altKey && (e.code === "Digit1" || e.code === "Digit2")) {
    e.preventDefault();
    setKind(e.code === "Digit1" ? "act" : "say");
    actionInput.focus();
  } else if (e.key === "Escape" && app.classList.contains("show-side") && !document.querySelector("dialog[open]")) {
    closeSide();
  }
});

// ============================================================ 기록 · 백업
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const safeTitle = () => (state?.settings.title || "파티챗").replace(/[\\/:*?"<>|]/g, "_");

$("export-json").onclick = () => {
  const data = { app: "party-chat", version: 2, exportedAt: new Date().toISOString(), settings: state?.settings, log };
  download(`${safeTitle()}-${fileStamp()}.json`, JSON.stringify(data, null, 2), "application/json");
};
$("export-txt").onclick = () => {
  const lines = [state?.settings.title || "파티챗", ""];
  for (const e of log) {
    if (e.type === "opening") lines.push("— 첫 장면 —", "", e.text, "");
    else {
      lines.push(`— ${e.n}턴 —`, "");
      for (const i of e.inputs) lines.push(`${i.name}${i.ai ? "(AI)" : ""}: ${i.text || "(지켜봄)"}`);
      lines.push("", e.story, "");
    }
  }
  download(`${safeTitle()}-${fileStamp()}.txt`, lines.join("\n"), "text/plain;charset=utf-8");
};
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.log)) throw new Error("bad");
    if (!confirm("지금 이야기를 지우고 이 파일의 이야기와 설정으로 바꿀까요?")) return;
    sendMsg({ t: "import", data: { log: data.log, settings: data.settings } });
  } catch {
    toast("파티챗에서 저장한 .json 파일이 아니에요.", true);
  }
});
$("reset-btn").onclick = () => confirm("이야기를 모두 지우고 처음부터 할까요? 설정은 그대로예요.") && sendMsg({ t: "reset" });

const backupKey = () => (roomKey ? `pc-backup:${roomKey}` : null);
function readBackup() {
  const k = backupKey();
  if (!k) return null;
  try { return JSON.parse(store.get(k) || "null"); } catch { return null; }
}
function writeBackup() {
  const k = backupKey();
  if (k) store.set(k, JSON.stringify({ savedAt: Date.now(), settings: state?.settings, log }));
}
$("restore-yes").onclick = () => {
  if (pendingRestore) sendMsg({ t: "import", data: { log: pendingRestore.log, settings: pendingRestore.settings } });
  pendingRestore = null;
  $("restore-banner").hidden = true;
};
$("restore-no").onclick = () => {
  pendingRestore = null;
  $("restore-banner").hidden = true;
};

// ============================================================ 토스트 · 연결 유지
let toastTimer = null;
function toast(text, bad = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3000);
}
setInterval(() => {
  if (ws && ws.readyState === 1 && joined) ws.send(JSON.stringify({ t: "ping" }));
}, 25000);
