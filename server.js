// 파티챗 서버: 같은 방 비밀번호로 모인 사람들이 함께 AI 롤플레이를 진행한다.
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const MOCK_AI = process.env.MOCK_AI === "1";

if (!MOCK_AI && !process.env.ANTHROPIC_API_KEY) {
  console.warn("[경고] ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 생성이 실패합니다. (테스트는 MOCK_AI=1)");
}
const anthropic = MOCK_AI ? null : new Anthropic();

// ---------------------------------------------------------------- 설정값

export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 · 고품질 (기본)", fallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 · 빠르고 저렴", fallback: true },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 · 가장 저렴", fallback: false },
  "claude-fable-5-2": { label: "Claude Fable 5.2 · 최고 성능 (비쌈)", fallback: true },
};
const LENGTHS = {
  short: { label: "짧게 (약 400자)", chars: 400 },
  normal: { label: "보통 (약 900자)", chars: 900 },
  long: { label: "길게 (약 1800자)", chars: 1800 },
  xlong: { label: "아주 길게 (약 3000자)", chars: 3000 },
};
const EFFORTS = { low: "낮음 (빠름)", medium: "보통", high: "높음 (느림)" };

const LIMITS = {
  name: 20,
  persona: 600,
  action: 2000,
  title: 40,
  systemPrompt: 30000,
  opening: 12000,
  memo: 8000,
  ooc: 500,
  roomPassword: 64,
};

const DEFAULT_SETTINGS = {
  title: "새 파티챗",
  systemPrompt: "",
  opening: "",
  memo: "",
  model: "claude-opus-5-5",
  length: "normal",
  effort: "low",
  mode: "all", // all: 전원 제출 시 자동 진행, host: 방장이 진행
  maxPlayers: 5,
  historyTurns: 0, // 0 = 전체 기억
};

const RECONNECT_GRACE_MS = 3 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 상태

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ id: string, token: string, name: string, persona: string, ws: any, connected: boolean,
 *   draft: string|null, joinedAt: number, leaveTimer: any }} Member
 * @typedef {{ key: string, hostId: string|null, settings: typeof DEFAULT_SETTINGS,
 *   members: Map<string, Member>, log: any[], generating: null|{ abort: () => void, inputs: any[], kind: string },
 *   banned: Set<string>, emptySince: number|null, ooc: any[] }} Room
 */

function roomKeyOf(password) {
  return crypto.createHash("sha256").update("party-chat:" + password).digest("hex");
}

function getOrCreateRoom(password) {
  const key = roomKeyOf(password);
  let room = rooms.get(key);
  if (!room) {
    room = {
      key,
      hostId: null,
      settings: { ...DEFAULT_SETTINGS },
      members: new Map(),
      log: [],
      generating: null,
      banned: new Set(),
      emptySince: null,
      ooc: [],
    };
    rooms.set(key, room);
  }
  return room;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) {
    if (room.members.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- 유틸

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const oneLine = (v, n) => clip(v, n).replace(/[\r\n\t]+/g, " ").trim();

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (m.ws && m.ws.readyState === 1) m.ws.send(data);
  }
}

function connectedMembers(room) {
  return [...room.members.values()].filter((m) => m.connected);
}

function publicState(room, viewer) {
  const turnNo = room.log.filter((e) => e.type === "turn").length + 1;
  return {
    t: "state",
    you: viewer.id,
    hostId: room.hostId,
    settings: room.settings,
    turn: turnNo,
    generating: room.generating ? { kind: room.generating.kind } : null,
    members: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      persona: m.persona,
      connected: m.connected,
      submitted: m.draft !== null,
      passed: m.draft === "",
    })),
    yourDraft: viewer.draft,
    options: {
      models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.label])),
      lengths: Object.fromEntries(Object.entries(LENGTHS).map(([k, v]) => [k, v.label])),
      efforts: EFFORTS,
    },
  };
}

function pushState(room) {
  for (const m of room.members.values()) send(m.ws, publicState(room, m));
}

function pushLog(room) {
  broadcast(room, { t: "log", log: room.log });
}

function notice(room, text) {
  broadcast(room, { t: "notice", text });
}

function assignHostIfNeeded(room) {
  if (room.hostId && room.members.has(room.hostId)) return;
  const hadHost = room.hostId !== null;
  const next = connectedMembers(room).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostId = next ? next.id : null;
  if (next && hadHost) notice(room, `${next.name}님이 새 방장이 되었어요.`);
}

function removeMember(room, member, reason) {
  clearTimeout(member.leaveTimer);
  room.members.delete(member.id);
  if (reason) notice(room, `${member.name}님이 ${reason}`);
  if (room.members.size === 0) room.emptySince = Date.now();
  assignHostIfNeeded(room);
  pushState(room);
  maybeAutoAdvance(room);
}

// ---------------------------------------------------------------- 프롬프트

function formatInputs(inputs, turnNo) {
  const lines = inputs.map((i) => {
    const who = i.persona ? `${i.name} (${firstLine(i.persona)})` : i.name;
    return i.text ? `- ${who}: ${i.text}` : `- ${who}: (이번 턴은 행동 없이 지켜봄)`;
  });
  return `[턴 ${turnNo} · 파티원 행동]\n${lines.length ? lines.join("\n") : "(아무도 행동하지 않음 — 이야기를 자연스럽게 이어가 주세요)"}`;
}

function firstLine(s) {
  const line = s.split("\n")[0].trim();
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

function buildSystem(room) {
  const s = room.settings;
  const party = [...room.members.values()]
    .map((m) => `- ${m.name}${m.persona ? `: ${m.persona}` : ""}`)
    .join("\n");
  const length = LENGTHS[s.length] || LENGTHS.normal;
  const parts = [
    "당신은 여러 명의 플레이어가 함께 참여하는 롤플레이 '파티챗'의 진행자이자 작가입니다.",
  ];
  if (s.systemPrompt.trim()) {
    parts.push(`## 세계관 · 캐릭터 설정 (방장 작성)\n${s.systemPrompt.trim()}`);
  }
  parts.push(`## 현재 파티 구성원 (플레이어 캐릭터)\n${party || "(없음)"}`);
  if (s.memo.trim()) parts.push(`## 기억 메모 (반드시 지킬 것)\n${s.memo.trim()}`);
  parts.push(
    [
      "## 진행 규칙",
      "- 매 턴의 사용자 메시지에는 파티원 각자의 행동과 대사가 들어 있습니다. 모든 파티원의 입력을 빠짐없이 반영해 하나의 자연스러운 장면으로 이어 쓰세요.",
      "- 파티원 캐릭터의 대사·행동·감정을 플레이어가 쓴 범위를 넘어 마음대로 정하지 마세요. NPC, 주변 세계, 사건의 반응을 중심으로 서술하세요.",
      "- 여러 파티원의 행동이 동시에 일어나면 순서와 상호작용을 자연스럽게 엮으세요. 특정 파티원만 비중이 커지지 않게 고르게 다루세요.",
      "- 설정과 지금까지의 이야기와 모순되지 않게 쓰세요.",
      `- 분량은 공백 포함 약 ${length.chars}자 안팎으로 쓰세요.`,
      "- 장면은 파티원들이 다음 행동을 고를 수 있는 지점에서 멈추세요.",
      "- 방장 설정에서 다른 언어나 문체를 지정하지 않았다면 한국어 소설체로 씁니다.",
      "- 선택지 목록, 해설, 메타 발언 없이 이야기 본문만 출력하세요.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

function buildMessages(room, inputs) {
  const s = room.settings;
  const turns = room.log.filter((e) => e.type === "turn");
  const kept = s.historyTurns > 0 ? turns.slice(-s.historyTurns) : turns;
  const opening = room.log.find((e) => e.type === "opening");
  const messages = [];
  if (opening && kept.length === turns.length) {
    messages.push({ role: "user", content: "[파티챗 시작] 오프닝 장면을 보여 주세요." });
    messages.push({ role: "assistant", content: opening.text });
  }
  if (kept.length < turns.length) {
    messages.push({
      role: "user",
      content: `[안내] 앞선 이야기 ${turns.length - kept.length}턴은 생략되었습니다. 기억 메모와 이어지는 내용을 바탕으로 진행하세요.`,
    });
    messages.push({ role: "assistant", content: "(앞선 이야기 생략)" });
  }
  for (const t of kept) {
    messages.push({ role: "user", content: formatInputs(t.inputs, t.n) });
    messages.push({ role: "assistant", content: t.story });
  }
  messages.push({ role: "user", content: formatInputs(inputs, turns.length + 1) });
  return messages;
}

// ---------------------------------------------------------------- AI 생성

async function* mockStream(inputs) {
  const text =
    `(테스트 모드 응답) ${inputs.map((i) => `${i.name}의 행동 "${i.text || "지켜보기"}"`).join(", ")}에 ` +
    "세계가 반응합니다. 바람이 불고, 멀리서 종소리가 울려 퍼집니다. 파티원들은 서로를 바라보며 다음 행동을 고민합니다.";
  for (const ch of text.match(/.{1,6}/gsu)) {
    await new Promise((r) => setTimeout(r, 30));
    yield ch;
  }
}

function collectInputs(room) {
  const inputs = [];
  for (const m of [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (m.draft === null && !m.connected) continue;
    inputs.push({ id: m.id, name: m.name, persona: m.persona, text: m.draft ?? "" });
  }
  return inputs;
}

/**
 * kind: "turn" (새 턴) | "regen" (마지막 턴 다시 쓰기)
 */
async function generate(room, kind) {
  if (room.generating) return;
  let inputs;
  if (kind === "regen") {
    const last = room.log.at(-1);
    if (!last || last.type !== "turn") return;
    room.log.pop();
    inputs = last.inputs;
    room._regenBackup = last;
  } else {
    inputs = collectInputs(room);
  }

  const s = room.settings;
  const model = MODELS[s.model] ? s.model : DEFAULT_SETTINGS.model;
  const system = buildSystem(room);
  const messages = buildMessages(room, inputs);

  let aborted = false;
  let stream = null;
  room.generating = { kind, inputs, abort: () => { aborted = true; stream?.abort(); } };
  if (kind === "regen") pushLog(room);
  broadcast(room, { t: "gen_start", kind, inputs, turn: room.log.filter((e) => e.type === "turn").length + 1 });
  pushState(room);

  let text = "";
  let error = null;
  let truncated = false;
  let servedBy = model;
  try {
    if (MOCK_AI) {
      for await (const delta of mockStream(inputs)) {
        if (aborted) break;
        text += delta;
        broadcast(room, { t: "delta", text: delta });
      }
    } else {
      const params = {
        model,
        max_tokens: 32000,
        system,
        messages,
        output_config: { effort: EFFORTS[s.effort] ? s.effort : "low" },
        cache_control: { type: "ephemeral" },
      };
      if (MODELS[model].fallback) {
        // 안전 분류기가 거절하면 서버 쪽에서 대체 모델로 이어서 생성한다.
        stream = anthropic.beta.messages.stream({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } else {
        stream = anthropic.messages.stream(params);
      }
      stream.on("text", (delta) => {
        text += delta;
        broadcast(room, { t: "delta", text: delta });
      });
      const final = await stream.finalMessage();
      servedBy = final.model || model;
      if (final.stop_reason === "refusal") {
        error = "AI가 이번 장면 생성을 거절했어요. 행동을 바꾸거나 다른 모델로 다시 시도해 보세요.";
      } else {
        if (final.stop_reason === "max_tokens") truncated = true;
        text = final.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
      }
    }
  } catch (err) {
    if (aborted || err instanceof Anthropic.APIUserAbortError) {
      aborted = true;
    } else {
      error = describeError(err);
      console.error("[생성 실패]", err);
    }
  }

  room.generating = null;
  const backup = room._regenBackup;
  room._regenBackup = null;

  if (aborted || error || !text.trim()) {
    if (kind === "regen" && backup) room.log.push(backup);
    if (error) notice(room, `⚠️ ${error}`);
    else if (aborted) notice(room, "생성을 중지했어요. 제출한 행동은 그대로 남아 있어요.");
    else notice(room, "⚠️ AI 응답이 비어 있어요. 다시 시도해 주세요.");
    broadcast(room, { t: "gen_end", ok: false });
    pushLog(room);
    pushState(room);
    return;
  }

  const turnNo = room.log.filter((e) => e.type === "turn").length + 1;
  room.log.push({
    type: "turn",
    n: turnNo,
    inputs: inputs.map(({ name, persona, text }) => ({ name, persona, text })),
    story: text.trim(),
    model: servedBy,
    at: Date.now(),
  });
  if (kind === "turn") {
    for (const m of room.members.values()) m.draft = null;
  }
  if (truncated) notice(room, "출력 한도에 닿아 이야기가 중간에 끊겼을 수 있어요.");
  broadcast(room, { t: "gen_end", ok: true });
  pushLog(room);
  pushState(room);
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않아요. 서버의 ANTHROPIC_API_KEY를 확인해 주세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 선택한 모델을 쓸 수 없어요.";
  if (err instanceof Anthropic.NotFoundError) return "선택한 모델을 찾을 수 없어요. 다른 모델을 골라 주세요.";
  if (err instanceof Anthropic.RateLimitError) return "요청이 너무 많거나 크레딧이 부족해요. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.BadRequestError) return `요청 오류: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return "AI 서버가 혼잡해요. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.APIConnectionError) return "AI 서버에 연결하지 못했어요.";
  if (err instanceof Anthropic.APIError) return `AI 오류 (${err.status ?? "?"}): ${err.message}`;
  return "알 수 없는 오류가 발생했어요.";
}

function maybeAutoAdvance(room) {
  if (room.generating || room.settings.mode !== "all") return;
  const active = connectedMembers(room);
  if (active.length === 0) return;
  if (active.every((m) => m.draft !== null) && active.some((m) => m.draft !== "")) {
    generate(room, "turn");
  }
}

// ---------------------------------------------------------------- 메시지 처리

function sanitizeSettings(input, current) {
  const s = { ...current };
  if (typeof input.title === "string") s.title = oneLine(input.title, LIMITS.title) || DEFAULT_SETTINGS.title;
  if (typeof input.systemPrompt === "string") s.systemPrompt = clip(input.systemPrompt, LIMITS.systemPrompt);
  if (typeof input.opening === "string") s.opening = clip(input.opening, LIMITS.opening);
  if (typeof input.memo === "string") s.memo = clip(input.memo, LIMITS.memo);
  if (MODELS[input.model]) s.model = input.model;
  if (LENGTHS[input.length]) s.length = input.length;
  if (EFFORTS[input.effort]) s.effort = input.effort;
  if (input.mode === "all" || input.mode === "host") s.mode = input.mode;
  const mp = Number(input.maxPlayers);
  if (Number.isInteger(mp) && mp >= 2 && mp <= 5) s.maxPlayers = mp;
  const ht = Number(input.historyTurns);
  if (Number.isInteger(ht) && ht >= 0 && ht <= 500) s.historyTurns = ht;
  return s;
}

function syncOpening(room) {
  const idx = room.log.findIndex((e) => e.type === "opening");
  const text = room.settings.opening.trim();
  if (idx >= 0 && room.log.length > 1) {
    room.log[idx].text = text || room.log[idx].text;
    return;
  }
  room.log = room.log.filter((e) => e.type !== "opening");
  if (text) room.log.unshift({ type: "opening", text });
}

function sanitizeImportedLog(log) {
  if (!Array.isArray(log)) return null;
  const out = [];
  let n = 0;
  for (const e of log.slice(0, 2000)) {
    if (e?.type === "opening" && typeof e.text === "string" && out.length === 0) {
      out.push({ type: "opening", text: clip(e.text, LIMITS.opening) });
    } else if (e?.type === "turn" && typeof e.story === "string") {
      n += 1;
      const inputs = Array.isArray(e.inputs)
        ? e.inputs.slice(0, 10).map((i) => ({
            name: oneLine(i?.name, LIMITS.name) || "?",
            persona: clip(i?.persona, LIMITS.persona),
            text: clip(i?.text, LIMITS.action),
          }))
        : [];
      out.push({ type: "turn", n, inputs, story: clip(e.story, 60000), model: oneLine(e.model, 40), at: Number(e.at) || 0 });
    }
  }
  return out;
}

function handleMessage(conn, msg) {
  const { room, member } = conn;
  if (!room || !member) return;
  const isHost = room.hostId === member.id;
  const hostOnly = () => {
    if (!isHost) send(member.ws, { t: "error", text: "방장만 할 수 있어요." });
    return isHost;
  };

  switch (msg.t) {
    case "submit": {
      if (room.generating) return send(member.ws, { t: "error", text: "AI가 쓰는 중이에요. 끝나면 제출해 주세요." });
      const text = clip(msg.text, LIMITS.action).trim();
      if (!text) return;
      member.draft = text;
      pushState(room);
      maybeAutoAdvance(room);
      return;
    }
    case "pass": {
      if (room.generating) return;
      member.draft = "";
      pushState(room);
      maybeAutoAdvance(room);
      return;
    }
    case "unsubmit": {
      if (room.generating) return;
      member.draft = null;
      pushState(room);
      return;
    }
    case "profile": {
      const name = oneLine(msg.name, LIMITS.name);
      if (name) member.name = name;
      if (typeof msg.persona === "string") member.persona = clip(msg.persona, LIMITS.persona).trim();
      pushState(room);
      return;
    }
    case "ooc": {
      const text = oneLine(msg.text, LIMITS.ooc);
      if (!text) return;
      const entry = { name: member.name, text, at: Date.now() };
      room.ooc.push(entry);
      if (room.ooc.length > 200) room.ooc.shift();
      broadcast(room, { t: "ooc", entry });
      return;
    }
    case "advance": {
      if (!hostOnly() || room.generating) return;
      generate(room, "turn");
      return;
    }
    case "regen": {
      if (!hostOnly() || room.generating) return;
      generate(room, "regen");
      return;
    }
    case "stop": {
      if (!hostOnly() || !room.generating) return;
      room.generating.abort();
      return;
    }
    case "undo": {
      if (!hostOnly() || room.generating) return;
      const last = room.log.at(-1);
      if (!last || last.type !== "turn") return;
      room.log.pop();
      // 되돌린 턴의 행동을 각자의 입력칸에 다시 넣어 준다.
      for (const input of last.inputs) {
        const m = [...room.members.values()].find((x) => x.name === input.name);
        if (m) m.draft = input.text || null;
      }
      notice(room, `방장이 ${last.n}턴을 되돌렸어요.`);
      pushLog(room);
      pushState(room);
      return;
    }
    case "editStory": {
      if (!hostOnly() || room.generating) return;
      const entry = room.log.find((e) => (msg.n === 0 ? e.type === "opening" : e.type === "turn" && e.n === msg.n));
      const text = clip(msg.text, 60000).trim();
      if (!entry || !text) return;
      if (entry.type === "opening") entry.text = text;
      else entry.story = text;
      pushLog(room);
      return;
    }
    case "reset": {
      if (!hostOnly() || room.generating) return;
      room.log = [];
      for (const m of room.members.values()) m.draft = null;
      syncOpening(room);
      notice(room, "방장이 이야기를 처음부터 다시 시작했어요.");
      pushLog(room);
      pushState(room);
      return;
    }
    case "settings": {
      if (!hostOnly() || typeof msg.settings !== "object" || !msg.settings) return;
      room.settings = sanitizeSettings(msg.settings, room.settings);
      syncOpening(room);
      notice(room, "방장이 설정을 바꿨어요.");
      pushLog(room);
      pushState(room);
      return;
    }
    case "import": {
      if (!hostOnly() || room.generating) return;
      const log = sanitizeImportedLog(msg.data?.log);
      if (!log) return send(member.ws, { t: "error", text: "불러올 수 없는 파일이에요." });
      if (msg.data?.settings && typeof msg.data.settings === "object") {
        room.settings = sanitizeSettings(msg.data.settings, room.settings);
      }
      room.log = log;
      if (!log.some((e) => e.type === "opening")) syncOpening(room);
      for (const m of room.members.values()) m.draft = null;
      notice(room, "방장이 저장된 이야기를 불러왔어요.");
      pushLog(room);
      pushState(room);
      return;
    }
    case "kick": {
      if (!hostOnly()) return;
      const target = room.members.get(msg.id);
      if (!target || target.id === member.id) return;
      room.banned.add(target.token);
      send(target.ws, { t: "kicked" });
      target.ws?.close();
      removeMember(room, target, "강퇴되었어요.");
      return;
    }
    case "transfer": {
      if (!hostOnly()) return;
      const target = room.members.get(msg.id);
      if (!target || !target.connected) return;
      room.hostId = target.id;
      notice(room, `${target.name}님이 새 방장이 되었어요.`);
      pushState(room);
      return;
    }
  }
}

function handleJoin(conn, ws, msg) {
  if (ACCESS_PASSWORD && !safeEqual(msg.access ?? "", ACCESS_PASSWORD)) {
    return send(ws, { t: "join_error", text: "입장 비밀번호가 틀렸어요.", field: "access" });
  }
  const password = typeof msg.room === "string" ? msg.room.trim() : "";
  if (password.length < 4 || password.length > LIMITS.roomPassword) {
    return send(ws, { t: "join_error", text: "방 비밀번호는 4~64자로 입력해 주세요.", field: "room" });
  }
  const name = oneLine(msg.name, LIMITS.name);
  if (!name) return send(ws, { t: "join_error", text: "닉네임을 입력해 주세요.", field: "name" });
  const token = typeof msg.token === "string" && /^[a-f0-9]{32}$/.test(msg.token) ? msg.token : null;
  if (!token) return send(ws, { t: "join_error", text: "잘못된 접속 정보예요. 새로고침해 주세요." });

  const room = getOrCreateRoom(password);
  if (room.banned.has(token)) return send(ws, { t: "join_error", text: "이 방에서 강퇴되어 들어갈 수 없어요." });

  let member = [...room.members.values()].find((m) => m.token === token);
  if (member) {
    // 재접속
    clearTimeout(member.leaveTimer);
    if (member.ws && member.ws !== ws) {
      send(member.ws, { t: "replaced" });
      member.ws.close();
    }
    member.ws = ws;
    member.connected = true;
    member.name = name;
    if (typeof msg.persona === "string") member.persona = clip(msg.persona, LIMITS.persona).trim();
  } else {
    if (room.members.size >= room.settings.maxPlayers) {
      return send(ws, { t: "join_error", text: `방이 가득 찼어요. (최대 ${room.settings.maxPlayers}명)` });
    }
    member = {
      id: crypto.randomUUID(),
      token,
      name,
      persona: clip(msg.persona, LIMITS.persona).trim(),
      ws,
      connected: true,
      draft: null,
      joinedAt: Date.now(),
      leaveTimer: null,
    };
    room.members.set(member.id, member);
    room.emptySince = null;
    notice(room, `${member.name}님이 들어왔어요.`);
  }
  conn.room = room;
  conn.member = member;
  assignHostIfNeeded(room);
  send(ws, { t: "joined", roomKey: room.key.slice(0, 16), isNewRoom: room.log.length === 0 });
  send(ws, { t: "log", log: room.log });
  send(ws, { t: "ooc_history", entries: room.ooc.slice(-50) });
  if (room.generating) {
    send(ws, { t: "gen_start", kind: room.generating.kind, inputs: room.generating.inputs, resumed: true });
  }
  pushState(room);
}

function handleClose(conn, ws) {
  const { room, member } = conn;
  if (!room || !member || member.ws !== ws) return;
  member.connected = false;
  member.ws = null;
  // 방장이 잠깐 끊겨도 바로 넘기지 않고, 유예 시간이 지나 퇴장 처리될 때 넘긴다.
  pushState(room);
  maybeAutoAdvance(room);
  member.leaveTimer = setTimeout(() => {
    if (!member.connected && room.members.get(member.id) === member) {
      removeMember(room, member, "나갔어요.");
    }
  }, RECONNECT_GRACE_MS);
}

// ---------------------------------------------------------------- 서버

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/config", (_req, res) => res.json({ needsAccess: Boolean(ACCESS_PASSWORD), mock: MOCK_AI }));
app.use(express.static(path.join(here, "public"), { extensions: ["html"] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });

wss.on("connection", (ws) => {
  const conn = { room: null, member: null, joinAttempts: 0, msgTimes: [] };
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (raw) => {
    // 간단한 도배 방지: 10초에 40개 이상 메시지면 무시
    const now = Date.now();
    conn.msgTimes = conn.msgTimes.filter((t) => now - t < 10000);
    conn.msgTimes.push(now);
    if (conn.msgTimes.length > 40) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "join") {
      if (conn.member) return;
      conn.joinAttempts += 1;
      if (conn.joinAttempts > 10) {
        send(ws, { t: "join_error", text: "시도 횟수가 너무 많아요. 새로고침 후 다시 시도해 주세요." });
        return ws.close();
      }
      return handleJoin(conn, ws, msg);
    }
    if (msg.t === "ping") return send(ws, { t: "pong" });
    handleMessage(conn, msg);
  });
  ws.on("close", () => handleClose(conn, ws));
});

// 끊긴 연결 정리 + 무료 호스팅에서 연결 유지
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`파티챗 서버 실행 중: http://localhost:${PORT}${MOCK_AI ? " (테스트 모드: 실제 AI 호출 안 함)" : ""}`);
});
