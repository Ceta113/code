"use strict";

// ------------------------------------------------------------ 저장소 (실패해도 동작)
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); return true; } catch { return false; } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch {} },
};

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

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ------------------------------------------------------------ 상태
let ws = null;
let joinInfo = null;
let joined = false;
let kicked = false;
let reconnectDelay = 1000;
let state = null;
let log = [];
let roomKey = null;
let pending = null; // 생성 중인 턴 { inputs, text, kind }
let pendingRestore = null;
let prevDraft = null;
let settingsDirty = false;
let openPanel = null;
let editingN = null;
let unreadChat = false;

// ------------------------------------------------------------ 입장
const joinForm = $("join-form");
$("j-name").value = store.get("pc-name") || "";
$("j-persona").value = store.get("pc-persona") || "";
$("j-room").value = store.get("pc-room", sessionStorage) || "";
$("j-access").value = store.get("pc-access", sessionStorage) || "";

fetch("config")
  .then((r) => r.json())
  .then((cfg) => {
    $("access-field").hidden = !cfg.needsAccess;
    if (cfg.mock) $("join-btn").textContent = "입장하기 (테스트 모드)";
  })
  .catch(() => {});

joinForm.addEventListener("submit", (e) => {
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
  kicked = false;
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
    if (kicked || !joined) {
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
  else toast("연결이 끊겨 있어요. 잠시 후 다시 시도해 주세요.");
}

// ------------------------------------------------------------ 메시지 처리
function handle(msg) {
  switch (msg.t) {
    case "join_error":
      $("join-error").textContent = msg.text;
      $("join-btn").disabled = false;
      if (joined) {
        joined = false;
        showJoin();
      }
      ws.close();
      break;
    case "joined":
      joined = true;
      roomKey = msg.roomKey;
      store.set("pc-room", joinInfo.room, sessionStorage);
      store.set("pc-access", joinInfo.access, sessionStorage);
      $("join-screen").hidden = true;
      $("room-screen").hidden = false;
      $("join-btn").disabled = false;
      if (msg.isNewRoom) {
        const backup = readBackup();
        pendingRestore = backup && backup.log && backup.log.some((e) => e.type === "turn") ? backup : null;
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
      renderFeed();
      break;
    case "delta":
      if (pending) {
        pending.text += msg.text;
        const node = document.querySelector(".story.streaming");
        if (node) {
          const stick = nearBottom();
          node.textContent = pending.text;
          if (stick) scrollToBottom();
        }
      }
      break;
    case "gen_end":
      pending = null;
      renderFeed();
      break;
    case "notice":
      toast(msg.text);
      addOoc({ system: true, text: msg.text, at: Date.now() });
      break;
    case "error":
      toast(msg.text);
      break;
    case "ooc":
      addOoc(msg.entry);
      break;
    case "ooc_history":
      $("ooc-list").replaceChildren();
      (msg.entries || []).forEach((e) => addOoc(e, true));
      break;
    case "kicked":
      kicked = true;
      joined = false;
      alert("방장에 의해 강퇴되었어요.");
      showJoin();
      break;
    case "replaced":
      kicked = true;
      joined = false;
      alert("다른 탭에서 같은 계정으로 접속해서 이 탭의 연결을 끊었어요.");
      showJoin();
      break;
  }
}

function showJoin() {
  $("room-screen").hidden = true;
  $("join-screen").hidden = false;
  state = null;
  log = [];
  pending = null;
}

// ------------------------------------------------------------ 렌더링: 상단/입력창
function me() {
  return state?.members.find((m) => m.id === state.you);
}
function isHost() {
  return state && state.hostId === state.you;
}

function renderState() {
  if (!state) return;
  const s = state.settings;
  const host = isHost();
  document.title = `${s.title} · 파티챗`;
  $("room-title").textContent = s.title;
  const modelLabel = (state.options.models[s.model] || s.model).split(" · ")[0];
  $("room-meta").textContent = `${state.turn}턴 · ${modelLabel}`;
  const online = state.members.filter((m) => m.connected).length;
  $("party-count").textContent = `${online}/${s.maxPlayers}`;

  // 파티 상태 칩
  const ps = $("party-status");
  ps.replaceChildren();
  for (const m of state.members) {
    const chip = el("span", "pchip");
    if (m.submitted) chip.classList.add(m.passed ? "passed" : "done");
    if (!m.connected) chip.classList.add("off");
    chip.append(el("span", "dot"));
    const label = m.name + (m.id === state.hostId ? " 👑" : "");
    const st = !m.connected ? "오프라인" : m.submitted ? (m.passed ? "스킵" : "제출") : "작성 중";
    chip.append(el("span", null, `${label} · ${st}`));
    ps.append(chip);
  }

  // 방장 도구
  const gen = Boolean(state.generating);
  const hasTurn = log.some((e) => e.type === "turn");
  $("host-tools").hidden = !host;
  $("advance-btn").disabled = gen;
  $("regen-btn").disabled = gen || !hasTurn;
  $("undo-btn").disabled = gen || !hasTurn;
  $("stop-btn").hidden = !gen;
  $("advance-btn").textContent = s.mode === "host" ? "▶ 진행" : "▶ 바로 진행";

  // 내 입력창
  const mine = me();
  const draft = state.yourDraft;
  const input = $("action-input");
  if (draft !== prevDraft) {
    if (draft === null && prevDraft !== null) input.value = "";
    else if (typeof draft === "string" && draft && document.activeElement !== input) input.value = draft;
    prevDraft = draft;
  }
  input.disabled = gen;
  $("submit-btn").disabled = gen;
  $("pass-btn").disabled = gen;
  $("submit-btn").textContent = draft ? "수정 제출" : "제출";
  $("unsubmit-btn").hidden = draft === null || gen;

  const active = state.members.filter((m) => m.connected);
  const done = active.filter((m) => m.submitted).length;
  if (gen) setStatus("AI가 이야기를 쓰는 중…");
  else if (draft !== null && mine) {
    setStatus(
      s.mode === "all"
        ? `${draft ? "제출 완료" : "스킵"} · 다른 파티원을 기다리는 중 (${done}/${active.length})`
        : `${draft ? "제출 완료" : "스킵"} · 방장이 진행하면 이야기가 이어져요 (${done}/${active.length})`,
    );
  } else {
    setStatus(
      s.mode === "all"
        ? `모두 제출하면 자동으로 이야기가 이어져요 (${done}/${active.length})`
        : `방장이 ▶ 진행을 누르면 이야기가 이어져요 (${done}/${active.length})`,
    );
  }

  // 복원 배너
  $("restore-banner").hidden = !(host && pendingRestore && !hasTurn);

  renderMembers();
  renderSettings();
  document.querySelectorAll(".host-only").forEach((n) => (n.hidden = !host));
  document.querySelectorAll(".edit-btn").forEach((b) => (b.hidden = !host || gen));
}

function setStatus(text) {
  $("status-line").textContent = text;
}

// ------------------------------------------------------------ 렌더링: 이야기
function nearBottom() {
  const f = $("feed");
  return f.scrollHeight - f.scrollTop - f.clientHeight < 120;
}
function scrollToBottom() {
  const f = $("feed");
  f.scrollTop = f.scrollHeight;
}

function inputChips(inputs) {
  const wrap = el("div", "inputs");
  for (const i of inputs) {
    const chip = el("div", "input-chip" + (i.text ? "" : " passed"));
    chip.append(el("b", null, i.name));
    chip.append(document.createTextNode(i.text || "(지켜봄)"));
    wrap.append(chip);
  }
  return wrap;
}

function renderFeed() {
  const feed = $("feed");
  const stick = nearBottom() || !feed.childElementCount;
  feed.replaceChildren();

  if (!log.length && !pending) {
    const empty = el("div", "empty-feed");
    empty.append(el("p", null, "아직 이야기가 시작되지 않았어요."));
    empty.append(
      el(
        "p",
        "hint",
        isHost()
          ? "설정에서 세계관 프롬프트와 오프닝을 적고, 아래에 첫 행동을 입력해 보세요."
          : "방장이 세계관을 정하는 동안 첫 행동을 입력해 보세요.",
      ),
    );
    feed.append(empty);
  }

  for (const e of log) {
    const n = e.type === "opening" ? 0 : e.n;
    const entry = el("article", "entry");
    const head = el("div", "entry-head");
    head.append(el("span", "tag", e.type === "opening" ? "오프닝" : `${e.n}턴`));
    if (e.model) head.append(el("span", null, e.model));
    const editBtn = el("button", "edit-btn", "수정");
    editBtn.hidden = !isHost() || Boolean(pending);
    editBtn.onclick = () => {
      editingN = n;
      renderFeed();
    };
    head.append(editBtn);
    entry.append(head);
    if (e.type === "turn" && e.inputs?.length) entry.append(inputChips(e.inputs));
    const text = e.type === "opening" ? e.text : e.story;
    if (editingN === n) {
      const ta = el("textarea", "story-edit");
      ta.value = text;
      const actions = el("div", "edit-actions");
      const save = el("button", "primary", "저장");
      const cancel = el("button", null, "취소");
      save.onclick = () => {
        sendMsg({ t: "editStory", n, text: ta.value });
        editingN = null;
      };
      cancel.onclick = () => {
        editingN = null;
        renderFeed();
      };
      actions.append(cancel, save);
      entry.append(ta, actions);
    } else {
      entry.append(el("div", "story", text));
    }
    feed.append(entry);
  }

  if (pending) {
    const entry = el("article", "entry");
    const head = el("div", "entry-head");
    head.append(el("span", "tag", pending.kind === "regen" ? "다시 쓰는 중" : "작성 중"));
    entry.append(head);
    if (pending.inputs.length) entry.append(inputChips(pending.inputs));
    entry.append(el("div", "story streaming", pending.text || (pending.resumed ? "(진행 중인 장면을 받아오는 중…)" : "")));
    feed.append(entry);
  }

  if (stick) scrollToBottom();
}

// ------------------------------------------------------------ 패널
const panelTitles = { party: "파티원", settings: "설정", chat: "잡담", records: "기록" };
document.querySelectorAll("[data-panel]").forEach((btn) => {
  btn.addEventListener("click", () => togglePanel(btn.dataset.panel));
});
$("panel-close").onclick = () => togglePanel(null);

function togglePanel(name) {
  openPanel = openPanel === name ? null : name;
  $("panel").hidden = !openPanel;
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === openPanel));
  if (openPanel) $("panel-title").textContent = panelTitles[openPanel];
  if (openPanel === "chat") {
    unreadChat = false;
    $("chat-badge").hidden = true;
    const list = $("ooc-list");
    list.scrollTop = list.scrollHeight;
  }
  if (openPanel === "party" && state) {
    const m = me();
    if (m) {
      $("p-name").value = m.name;
      $("p-persona").value = m.persona;
    }
  }
  if (openPanel === "settings") {
    settingsDirty = false;
    renderSettings();
  }
}

function renderMembers() {
  const list = $("member-list");
  list.replaceChildren();
  for (const m of state.members) {
    const li = el("li", "member");
    const top = el("div", "member-top");
    top.append(el("span", "name", m.name));
    if (m.id === state.hostId) top.append(el("span", "badge host", "방장"));
    if (m.id === state.you) top.append(el("span", "badge", "나"));
    if (!m.connected) top.append(el("span", "badge off", "오프라인"));
    li.append(top);
    if (m.persona) li.append(el("div", "persona", m.persona));
    if (isHost() && m.id !== state.you) {
      const actions = el("div", "actions");
      const tr = el("button", null, "방장 넘기기");
      tr.disabled = !m.connected;
      tr.onclick = () => confirm(`${m.name}님에게 방장을 넘길까요?`) && sendMsg({ t: "transfer", id: m.id });
      const kick = el("button", "danger", "강퇴");
      kick.onclick = () => confirm(`${m.name}님을 강퇴할까요? 다시 들어올 수 없어요.`) && sendMsg({ t: "kick", id: m.id });
      actions.append(tr, kick);
      li.append(actions);
    }
    list.append(li);
  }
}

const sf = (n) => $("settings-form").elements.namedItem(n);

function fillSelect(sel, options) {
  if (sel.options.length === Object.keys(options).length) return;
  sel.replaceChildren();
  for (const [value, label] of Object.entries(options)) {
    const o = el("option", null, label);
    o.value = value;
    sel.append(o);
  }
}

function renderSettings() {
  if (!state) return;
  const form = $("settings-form");
  fillSelect(sf("model"), state.options.models);
  fillSelect(sf("length"), state.options.lengths);
  fillSelect(sf("effort"), state.options.efforts);
  const host = isHost();
  $("settings-readonly").hidden = host;
  $("settings-save").hidden = !host;
  for (const field of form.elements) {
    if (field.name) field.disabled = !host;
  }
  if (settingsDirty && host) return;
  const s = state.settings;
  for (const key of ["title", "systemPrompt", "opening", "memo", "model", "length", "effort", "mode"]) {
    sf(key).value = s[key];
  }
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

$("profile-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("p-name").value.trim();
  const persona = $("p-persona").value.trim();
  if (!name) return toast("닉네임을 입력해 주세요.");
  sendMsg({ t: "profile", name, persona });
  if (joinInfo) {
    joinInfo.name = name;
    joinInfo.persona = persona;
  }
  store.set("pc-name", name);
  store.set("pc-persona", persona);
  toast("프로필을 저장했어요.");
});

// ------------------------------------------------------------ 잡담
function addOoc(entry, silent) {
  const list = $("ooc-list");
  const li = el("li");
  if (entry.system) {
    li.className = "hint";
    li.textContent = entry.text;
  } else {
    li.append(el("b", null, entry.name));
    li.append(document.createTextNode(entry.text));
  }
  const t = el("time", null, new Date(entry.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
  li.append(t);
  list.append(li);
  while (list.childElementCount > 200) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
  if (!silent && !entry.system && openPanel !== "chat") {
    unreadChat = true;
    $("chat-badge").hidden = false;
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
const coarse = window.matchMedia("(pointer: coarse)").matches;
actionInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  if (coarse || e.shiftKey) return; // 모바일은 줄바꿈, PC는 Shift+Enter 줄바꿈
  e.preventDefault();
  $("action-form").requestSubmit();
});
$("action-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = actionInput.value.trim();
  if (!text) return toast("행동이나 대사를 입력해 주세요. 이번 턴을 넘기려면 스킵을 누르세요.");
  sendMsg({ t: "submit", text });
  actionInput.blur();
});
$("pass-btn").onclick = () => sendMsg({ t: "pass" });
$("unsubmit-btn").onclick = () => sendMsg({ t: "unsubmit" });

// 방장 도구
$("advance-btn").onclick = () => sendMsg({ t: "advance" });
$("regen-btn").onclick = () => confirm("마지막 장면을 같은 행동으로 다시 쓸까요?") && sendMsg({ t: "regen" });
$("undo-btn").onclick = () => confirm("마지막 턴을 지우고 행동 입력 단계로 되돌릴까요?") && sendMsg({ t: "undo" });
$("stop-btn").onclick = () => sendMsg({ t: "stop" });

// ------------------------------------------------------------ 기록 / 백업
function exportData() {
  return { app: "party-chat", version: 1, exportedAt: new Date().toISOString(), settings: state?.settings, log };
}
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
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
function safeTitle() {
  return (state?.settings.title || "파티챗").replace(/[\\/:*?"<>|]/g, "_");
}
$("export-json").onclick = () =>
  download(`${safeTitle()}-${fileStamp()}.json`, JSON.stringify(exportData(), null, 2), "application/json");
$("export-txt").onclick = () => {
  const lines = [`# ${state?.settings.title || "파티챗"}`, ""];
  for (const e of log) {
    if (e.type === "opening") lines.push("[오프닝]", e.text, "");
    else {
      lines.push(`[${e.n}턴]`);
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
    toast("파티챗 저장 파일(.json)이 아니에요.");
  }
});
$("reset-btn").onclick = () => {
  if (confirm("이야기를 모두 지우고 처음부터 시작할까요? (설정은 유지돼요)")) sendMsg({ t: "reset" });
};

function backupKey() {
  return roomKey ? `pc-backup:${roomKey}` : null;
}
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

// ------------------------------------------------------------ 토스트
let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// 연결 유지용 핑 (무료 호스팅의 유휴 연결 끊김 방지)
setInterval(() => {
  if (ws && ws.readyState === 1 && joined) ws.send(JSON.stringify({ t: "ping" }));
}, 25000);
