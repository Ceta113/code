"use strict";

// ------------------------------------------------------------ 기본 도구
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

// 이름마다 고정된 색
const PALETTE = ["#ff8a5c", "#ffd166", "#7bdff2", "#c8b6ff", "#80ed99", "#f4a261", "#ff99c8", "#a0c4ff", "#90be6d", "#f7b7a3", "#e9c46a", "#b8f2e6"];
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function avatar(name, size = 36, status) {
  const a = el("span", "avatar", [...String(name || "?")][0]);
  a.style.setProperty("--c", colorOf(name));
  a.style.setProperty("--s", size + "px");
  a.setAttribute("aria-hidden", "true");
  if (status) a.append(el("i", "st " + status));
  return a;
}
function gmAvatar(size = 36) {
  const a = el("span", "avatar gm");
  a.style.setProperty("--s", size + "px");
  a.innerHTML = '<svg aria-hidden="true"><use href="#i-gm"/></svg>';
  return a;
}

// 이야기 본문: "대사"는 밝게, *강조*는 기울여서
const STORY_RE = /("[^"\n]{1,400}"|“[^”\n]{1,400}”|「[^」\n]{1,400}」|『[^』\n]{1,400}』|\*[^*\n]{1,400}\*)/g;
function storyNodes(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(STORY_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("*")) frag.append(el("span", "em", tok.slice(1, -1)));
    else frag.append(el("span", "dlg", tok));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// ------------------------------------------------------------ 상태
let ws = null;
let joinInfo = null;
let joined = false;
let stopped = false;
let reconnectDelay = 1000;
let state = null;
let log = [];
let roomKey = null;
let pending = null;
let pendingRestore = null;
let prevDraft = null;
let settingsDirty = false;
let editingN = null;
let railTab = "chat";
let unreadChat = false;
let builtOptions = false;
let lastHostView = null;

const me = () => state?.members.find((m) => m.id === state.you);
const isHost = () => Boolean(state && state.hostId === state.you);
const shortLabel = (s) => String(s).split(/ [·(]/)[0].trim();

// ------------------------------------------------------------ 입장
$("j-name").value = store.get("pc-name") || "";
$("j-persona").value = store.get("pc-persona") || "";
$("j-room").value = store.get("pc-room", sessionStorage) || "";
$("j-access").value = store.get("pc-access", sessionStorage) || "";

fetch("config")
  .then((r) => r.json())
  .then((cfg) => {
    $("access-field").hidden = !cfg.needsAccess;
    $("mock-badge").hidden = !cfg.mock;
  })
  .catch(() => {});

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  joinInfo = {
    access: $("j-access").value,
    room: $("j-room").value.trim(),
    name: $("j-name").value.trim(),
    persona: $("j-persona").value.trim(),
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
    setStatus("연결이 끊겼어요. 다시 연결하는 중…");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function sendMsg(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else toast("연결이 끊겨 있어요. 잠시 후 다시 시도해 주세요.", true);
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

// ------------------------------------------------------------ 서버 메시지
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
      joined = true;
      roomKey = msg.roomKey;
      store.set("pc-room", joinInfo.room, sessionStorage);
      store.set("pc-access", joinInfo.access, sessionStorage);
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
      pending = { inputs: msg.inputs || [], text: "", kind: msg.kind, resumed: msg.resumed };
      renderFeed(true);
      break;
    case "delta":
      if (!pending) break;
      pending.text += msg.text;
      updateLiveStory();
      break;
    case "gen_end":
      pending = null;
      renderFeed();
      break;
    case "notice":
      toast(msg.text, msg.text.startsWith("⚠️"));
      addOoc({ system: true, text: msg.text, at: Date.now() });
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
      if (!msg.entries?.length) $("ooc-list").append(el("div", "ooc-empty", "AI에게 전달되지 않는 파티원끼리의 잡담방이에요."));
      break;
    case "kicked":
      leave("방장에 의해 강퇴되었어요.");
      break;
    case "replaced":
      leave("다른 탭에서 같은 계정으로 들어와서 이 탭의 연결을 끊었어요.");
      break;
  }
}

// ------------------------------------------------------------ 상단 · 파티 · 입력창
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

  document.title = `${s.title} · PARTY CHAT`;
  $("top-title").textContent = s.title;
  $("top-pill").classList.toggle("live", gen);
  $("top-state").textContent = gen ? "AI 작성 중" : `TURN ${state.turn}`;
  $("room-title").textContent = s.title;
  const chips = $("room-chips");
  chips.replaceChildren(
    el("span", "chip accent", shortLabel(state.options.models[s.model] || s.model).replace("Claude ", "")),
    el("span", "chip", shortLabel(state.options.lengths[s.length] || "")),
    el("span", "chip", s.mode === "all" ? "자동 진행" : "방장 진행"),
    el("span", "chip", `TURN ${state.turn}`),
  );
  $("party-count").textContent = `${active.length}/${s.maxPlayers}`;
  $("party-count-top").textContent = `${active.length}`;

  renderMembers();
  renderPartyBar(done, active.length);

  // 방장 도구
  $("host-tools").hidden = !host;
  $("advance-btn").disabled = gen;
  $("regen-btn").disabled = gen || !hasTurn;
  $("undo-btn").disabled = gen || !hasTurn;
  $("stop-btn").hidden = !gen;
  $("advance-btn").textContent = s.mode === "host" ? "▶ 진행" : "▶ 바로 진행";

  // 내 입력
  const draft = state.yourDraft;
  const input = $("action-input");
  if (draft !== prevDraft) {
    if (draft === null && prevDraft !== null) input.value = "";
    else if (draft && document.activeElement !== input) input.value = draft;
    prevDraft = draft;
  }
  input.disabled = gen;
  $("action-form").classList.toggle("locked", gen);
  $("submit-btn").disabled = gen;
  $("pass-btn").disabled = gen;
  $("submit-btn").textContent = draft ? "수정 제출" : "제출";
  $("unsubmit-btn").hidden = draft === null || gen;

  const status = $("status-line");
  status.replaceChildren();
  if (gen) status.append(el("b", null, "AI가 다음 장면을 쓰는 중이에요…"));
  else if (draft !== null) {
    status.append(el("b", null, draft ? "제출 완료 " : "스킵 "));
    status.append(s.mode === "all" ? `· 다른 파티원을 기다리는 중 (${done}/${active.length})` : `· 방장이 진행하면 이야기가 이어져요 (${done}/${active.length})`);
  } else {
    status.append(s.mode === "all" ? `모두 제출하면 자동으로 이야기가 이어져요 · ${done}/${active.length}` : `방장이 ▶ 진행을 누르면 이야기가 이어져요 · ${done}/${active.length}`);
  }

  $("restore-banner").hidden = !(host && pendingRestore && !hasTurn);
  document.querySelectorAll(".host-only").forEach((n) => (n.hidden = !host));
  document.querySelectorAll(".scene .edit").forEach((b) => (b.hidden = !host || gen));
  renderSettings();
  syncDockHeight();
}

function statusOf(m) {
  if (!m.connected) return { cls: "off", label: "오프라인", dot: null };
  if (m.submitted) return m.passed ? { cls: "passed", label: "스킵", dot: "wait" } : { cls: "done", label: "제출", dot: "on" };
  return { cls: "", label: "작성 중", dot: null };
}

function renderMembers() {
  const list = $("member-list");
  list.replaceChildren();
  for (const m of state.members) {
    const st = statusOf(m);
    const li = el("li", "member" + (m.connected ? "" : " off"));
    li.append(avatar(m.name, 36, st.dot));
    const info = el("div", "info");
    const row = el("div", "name-row");
    const name = el("span", "name", m.name);
    name.style.color = colorOf(m.name);
    row.append(name);
    if (m.id === state.hostId) row.append(el("span", "crown", "👑"));
    if (m.id === state.you) row.append(el("span", "chip", "나"));
    row.append(el("span", "chip tag " + (st.cls === "done" ? "accent" : st.cls === "passed" ? "gold" : ""), st.label));
    info.append(row);
    if (m.persona) info.append(el("div", "persona", m.persona));
    if (isHost() && m.id !== state.you) {
      const tools = el("div", "tools");
      const tr = el("button", "btn", "방장 넘기기");
      tr.disabled = !m.connected;
      tr.onclick = () => confirm(`${m.name}님에게 방장을 넘길까요?`) && sendMsg({ t: "transfer", id: m.id });
      const kick = el("button", "btn danger", "강퇴");
      kick.onclick = () => confirm(`${m.name}님을 강퇴할까요? 다시 들어올 수 없어요.`) && sendMsg({ t: "kick", id: m.id });
      tools.append(tr, kick);
      info.append(tools);
    }
    li.append(info);
    list.append(li);
  }
  for (let i = state.members.length; i < state.settings.maxPlayers; i++) {
    const slot = el("li", "empty-slot");
    slot.append(el("span"), "빈 자리");
    list.append(slot);
  }
}

function renderPartyBar(done, total) {
  const bar = $("party-bar");
  bar.replaceChildren();
  for (const m of state.members) {
    const st = statusOf(m);
    const chip = el("span", "who " + st.cls);
    chip.append(avatar(m.name, 22));
    chip.append(m.name);
    chip.append(el("span", "s", st.label));
    bar.append(chip);
  }
  bar.append(el("span", "count", `${done}/${total} 제출`));
}

function setStatus(text) {
  $("status-line").textContent = text;
}

// 입력창 높이에 맞춰 '최신 장면' 버튼 위치 조정
function syncDockHeight() {
  document.documentElement.style.setProperty("--dock-h", $("dock").offsetHeight + "px");
}
new ResizeObserver(syncDockHeight).observe($("dock"));

// ------------------------------------------------------------ 이야기 피드
const feed = $("feed");
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
const scrollToBottom = () => {
  feed.scrollTop = feed.scrollHeight;
  $("jump-btn").hidden = true;
};
feed.addEventListener("scroll", () => {
  if (nearBottom()) $("jump-btn").hidden = true;
});
$("jump-btn").onclick = scrollToBottom;

function actsBlock(inputs) {
  const wrap = el("div", "acts");
  const myName = me()?.name;
  for (const i of inputs) {
    const row = el("div", "act" + (i.name === myName ? " mine" : "") + (i.text ? "" : " passed"));
    row.style.setProperty("--c", colorOf(i.name));
    row.append(avatar(i.name, 30));
    const bubble = el("div", "bubble");
    bubble.append(el("span", "who", i.name));
    bubble.append(el("div", "txt", i.text || "이번 턴은 지켜봄"));
    row.append(bubble);
    wrap.append(row);
  }
  return wrap;
}

function sceneBlock({ text, model, n, live }) {
  const wrap = el("article", "scene");
  wrap.append(gmAvatar(36));
  const main = el("div", "scene-main");
  const head = el("div", "scene-head");
  head.append(el("span", "name", "진행자"));
  if (model) head.append(el("span", "chip", model.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2")));
  if (live) head.append(el("span", "chip accent", pending?.kind === "regen" ? "다시 쓰는 중" : "작성 중"));
  if (!live) {
    const edit = el("button", "btn ghost sm edit", "수정");
    edit.hidden = !isHost() || Boolean(pending);
    edit.onclick = () => {
      editingN = n;
      renderFeed();
    };
    head.append(edit);
  }
  main.append(head);
  const body = el("div", "scene-body");
  if (!live && editingN === n) {
    const ta = el("textarea", "story-edit");
    ta.value = text;
    const actions = el("div", "edit-actions");
    const cancel = el("button", "btn sm", "취소");
    const save = el("button", "btn sm primary", "저장");
    cancel.onclick = () => { editingN = null; renderFeed(); };
    save.onclick = () => { sendMsg({ t: "editStory", n, text: ta.value }); editingN = null; };
    actions.append(cancel, save);
    body.append(ta, actions);
  } else if (live && !text) {
    const dots = el("span", "dots");
    dots.id = "live-story";
    dots.append(el("i"), el("i"), el("i"));
    body.append(dots);
  } else {
    const story = el("div", "story" + (live ? " typing" : ""));
    if (live) story.id = "live-story";
    story.append(storyNodes(text));
    body.append(story);
  }
  main.append(body);
  wrap.append(main);
  return wrap;
}

function turnDivider(label) {
  const d = el("div", "turn-div");
  d.append(el("span", null, label));
  return d;
}

function emptyState() {
  const box = el("div", "empty-feed");
  box.append(el("b", null, "이야기를 시작해 볼까요?"));
  box.append(el("p", null, isHost() ? "방장인 당신이 무대를 준비할 차례예요." : "방장이 무대를 준비하는 동안 첫 행동을 생각해 두세요."));
  const steps = el("div", "steps");
  const items = isHost()
    ? [["01", "설정에서 세계관 프롬프트와 오프닝을 적어요"], ["02", "친구들에게 방 비밀번호를 알려 줘요"], ["03", "모두 첫 행동을 제출하면 시작!"]]
    : [["01", "왼쪽(또는 파티 버튼)에서 내 캐릭터를 확인해요"], ["02", "아래 입력창에 첫 행동이나 대사를 적어요"], ["03", "모두 제출하면 AI가 장면을 써요"]];
  for (const [num, text] of items) {
    const row = el("div");
    row.append(el("em", null, num), text);
    steps.append(row);
  }
  box.append(steps);
  return box;
}

function renderFeed(forceStick) {
  const inner = $("feed-inner");
  const stick = forceStick || nearBottom() || !inner.childElementCount;
  inner.replaceChildren();
  if (!log.length && !pending) inner.append(emptyState());

  for (const e of log) {
    if (e.type === "opening") {
      const card = el("section", "prologue");
      card.append(el("div", "eyebrow", "PROLOGUE"));
      if (editingN === 0) {
        const s = sceneBlock({ text: e.text, n: 0 });
        card.append(s.querySelector(".scene-body"));
      } else {
        const story = el("div", "story");
        story.append(storyNodes(e.text));
        card.append(story);
        if (isHost() && !pending) {
          const edit = el("button", "btn ghost sm", "프롤로그 수정");
          edit.style.marginTop = "12px";
          edit.onclick = () => { editingN = 0; renderFeed(); };
          card.append(edit);
        }
      }
      inner.append(card);
    } else if (e.type === "turn") {
      inner.append(turnDivider(`TURN ${e.n}`));
      if (e.inputs?.length) inner.append(actsBlock(e.inputs));
      inner.append(sceneBlock({ text: e.story, model: e.model, n: e.n }));
    }
  }

  if (pending) {
    const n = log.filter((e) => e.type === "turn").length + 1;
    inner.append(turnDivider(`TURN ${n}`));
    if (pending.inputs.length) inner.append(actsBlock(pending.inputs));
    inner.append(sceneBlock({ text: pending.text, live: true }));
  }

  if (stick) scrollToBottom();
  else if (pending) $("jump-btn").hidden = false;
}

function updateLiveStory() {
  const node = $("live-story");
  if (!node) return renderFeed();
  const stick = nearBottom();
  if (node.classList.contains("dots")) {
    const story = el("div", "story typing");
    story.id = "live-story";
    node.replaceWith(story);
    story.append(storyNodes(pending.text));
  } else {
    node.replaceChildren(storyNodes(pending.text));
  }
  if (stick) scrollToBottom();
  else $("jump-btn").hidden = false;
}

// ------------------------------------------------------------ 시트 · 탭
const app = $("app");
document.querySelectorAll("[data-sheet]").forEach((b) => {
  b.addEventListener("click", () => {
    const cls = "show-" + b.dataset.sheet;
    const open = !app.classList.contains(cls);
    app.classList.remove("show-side", "show-rail");
    if (open) app.classList.add(cls);
    if (open && b.dataset.sheet === "rail" && railTab === "chat") markChatRead();
  });
});
$("scrim").onclick = () => app.classList.remove("show-side", "show-rail");

document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
function selectTab(tab) {
  railTab = tab;
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
  if (tab === "chat") markChatRead();
  if (tab === "settings") {
    settingsDirty = false;
    renderSettings();
  }
}
function markChatRead() {
  unreadChat = false;
  $("chat-dot").hidden = true;
  $("menu-dot").hidden = true;
  const list = $("ooc-list");
  list.scrollTop = list.scrollHeight;
}

// ------------------------------------------------------------ 설정
const sf = (n) => $("settings-form").elements.namedItem(n);

function buildOptions() {
  if (builtOptions || !state) return;
  builtOptions = true;
  const models = $("model-list");
  models.replaceChildren();
  for (const [value, label] of Object.entries(state.options.models)) {
    const [name, desc] = label.split(" · ");
    const lab = el("label", "model");
    const input = Object.assign(el("input"), { type: "radio", name: "model", value });
    const span = el("span");
    span.append(el("b", null, name), el("small", null, desc || ""));
    lab.append(input, span);
    models.append(lab);
  }
  for (const [id, name, opts] of [["seg-length", "length", state.options.lengths], ["seg-effort", "effort", state.options.efforts]]) {
    const seg = $(id);
    seg.replaceChildren();
    for (const [value, label] of Object.entries(opts)) {
      const lab = el("label");
      lab.title = label;
      lab.append(Object.assign(el("input"), { type: "radio", name, value }), el("span", null, shortLabel(label)));
      seg.append(lab);
    }
  }
}

function renderSettings() {
  if (!state) return;
  buildOptions();
  const host = isHost();
  $("settings-readonly").hidden = host;
  $("save-bar").hidden = !host;
  for (const field of $("settings-form").elements) {
    if (field.name) field.disabled = !host;
  }
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
    },
  });
  settingsDirty = false;
  toast("설정을 저장했어요.");
});

// ------------------------------------------------------------ 프로필
$("profile-btn").onclick = () => {
  const m = me();
  if (!m) return;
  $("p-name").value = m.name;
  $("p-persona").value = m.persona;
  $("profile-modal").showModal();
};
$("profile-cancel").onclick = () => $("profile-modal").close();
$("profile-form").addEventListener("submit", (e) => {
  const name = $("p-name").value.trim();
  const persona = $("p-persona").value.trim();
  if (!name) {
    e.preventDefault();
    return toast("닉네임을 입력해 주세요.", true);
  }
  sendMsg({ t: "profile", name, persona });
  if (joinInfo) Object.assign(joinInfo, { name, persona });
  store.set("pc-name", name);
  store.set("pc-persona", persona);
  toast("프로필을 저장했어요.");
});

// ------------------------------------------------------------ 잡담
function addOoc(entry, silent) {
  const list = $("ooc-list");
  list.querySelector(".ooc-empty")?.remove();
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  let row;
  if (entry.system) {
    row = el("div", "c-sys" + (entry.text.startsWith("⚠️") ? " warn" : ""), entry.text);
  } else {
    row = el("div", "c-msg");
    const nick = el("span", "nick", entry.name);
    nick.style.color = colorOf(entry.name);
    row.append(nick, entry.text);
    row.append(el("time", null, new Date(entry.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })));
  }
  list.append(row);
  while (list.childElementCount > 300) list.firstChild.remove();
  if (stick || silent) list.scrollTop = list.scrollHeight;
  const chatOpen = railTab === "chat" && (window.innerWidth > 900 || app.classList.contains("show-rail"));
  if (!silent && !entry.system && !chatOpen) {
    unreadChat = true;
    $("chat-dot").hidden = false;
    $("menu-dot").hidden = window.innerWidth > 900;
  }
}
$("ooc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("ooc-input").value.trim();
  if (!text) return;
  sendMsg({ t: "ooc", text });
  $("ooc-input").value = "";
});

// ------------------------------------------------------------ 행동 입력
const actionInput = $("action-input");
const kindOf = () => $("action-form").elements.namedItem("kind").value;
$("action-form").addEventListener("change", (e) => {
  if (e.target.name !== "kind") return;
  actionInput.placeholder = kindOf() === "say" ? "내 캐릭터가 할 말을 입력하세요 (따옴표는 자동)" : "내 캐릭터의 행동을 입력하세요";
  actionInput.focus();
});
const coarse = window.matchMedia("(pointer: coarse)").matches;
actionInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  if (coarse || e.shiftKey) return; // 모바일은 줄바꿈, PC는 Shift+Enter 줄바꿈
  e.preventDefault();
  $("action-form").requestSubmit();
});
$("action-form").addEventListener("submit", (e) => {
  e.preventDefault();
  let text = actionInput.value.trim();
  if (!text) return toast("행동이나 대사를 입력해 주세요. 이번 턴을 넘기려면 스킵을 누르세요.");
  if (kindOf() === "say" && !/^["“「『]/.test(text)) text = `“${text}”`;
  actionInput.value = text;
  sendMsg({ t: "submit", text });
  actionInput.blur();
});
$("pass-btn").onclick = () => sendMsg({ t: "pass" });
$("unsubmit-btn").onclick = () => sendMsg({ t: "unsubmit" });

$("advance-btn").onclick = () => sendMsg({ t: "advance" });
$("regen-btn").onclick = () => confirm("마지막 장면을 같은 행동으로 다시 쓸까요?") && sendMsg({ t: "regen" });
$("undo-btn").onclick = () => confirm("마지막 턴을 지우고 행동 입력 단계로 되돌릴까요?") && sendMsg({ t: "undo" });
$("stop-btn").onclick = () => sendMsg({ t: "stop" });

// ------------------------------------------------------------ 기록 · 백업
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
  const data = { app: "party-chat", version: 1, exportedAt: new Date().toISOString(), settings: state?.settings, log };
  download(`${safeTitle()}-${fileStamp()}.json`, JSON.stringify(data, null, 2), "application/json");
};
$("export-txt").onclick = () => {
  const lines = [`# ${state?.settings.title || "파티챗"}`, ""];
  for (const e of log) {
    if (e.type === "opening") lines.push("[프롤로그]", e.text, "");
    else {
      lines.push(`[TURN ${e.n}]`);
      for (const i of e.inputs) lines.push(`> ${i.name}: ${i.text || "(지켜봄)"}`);
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
    if (!confirm("현재 이야기를 지우고 이 파일의 이야기와 설정으로 바꿀까요?")) return;
    sendMsg({ t: "import", data: { log: data.log, settings: data.settings } });
  } catch {
    toast("파티챗 저장 파일(.json)이 아니에요.", true);
  }
});
$("reset-btn").onclick = () => {
  if (confirm("이야기를 모두 지우고 처음부터 시작할까요? (설정은 유지돼요)")) sendMsg({ t: "reset" });
};

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

// ------------------------------------------------------------ 토스트 · 연결 유지
let toastTimer = null;
function toast(text, bad = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}
setInterval(() => {
  if (ws && ws.readyState === 1 && joined) ws.send(JSON.stringify({ t: "ping" }));
}, 25000);
