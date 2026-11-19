// 파티챗 서버: 같은 방 비밀번호로 모인 사람들(과 AI 동료)이 함께 롤플레이를 진행한다.
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

const MODELS = {
  "claude-opus-5-5": { label: "Opus 5.5 · 글이 가장 좋아요 (기본)", fallback: true },
  "claude-sonnet-5-5": { label: "Sonnet 5.5 · 빠르고 저렴해요", fallback: true },
  "claude-haiku-5-5": { label: "Haiku 5.5 · 가장 저렴해요", fallback: false },
  "claude-fable-5-2": { label: "Fable 5.2 · 최고 성능, 비싸요", fallback: true },
};
const LENGTHS = {
  short: { label: "짧게 · 약 400자", chars: 400 },
  normal: { label: "보통 · 약 900자", chars: 900 },
  long: { label: "길게 · 약 1800자", chars: 1800 },
  xlong: { label: "아주 길게 · 약 3000자", chars: 3000 },
};
const EFFORTS = { low: "가볍게", medium: "보통", high: "깊게" };

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
  companions: 3,
};

const DEFAULT_SETTINGS = {
  title: "이름 없는 모험",
  systemPrompt: "",
  opening: "",
  memo: "",
  model: "claude-opus-5-5",
  length: "normal",
  effort: "low",
  mode: "all", // all: 전원 제출 시 자동 진행, host: 방장이 진행
  maxPlayers: 5, // 사람 최대 인원
  historyTurns: 0, // 0 = 전체 기억
  companions: [], // AI 동료 [{ id, name, persona }]
};

const COMPANION_TEMPLATES = [
  { name: "세라", persona: "말수가 적은 궁수. 관찰력이 좋아 위험을 먼저 알아채고, 필요한 말만 짧게 한다." },
  { name: "도윤", persona: "넉살 좋은 방패병. 분위기를 풀어 주는 농담을 잘하고, 동료가 위험하면 먼저 앞에 선다." },
  { name: "미오", persona: "호기심 많은 견습 연금술사. 엉뚱한 아이디어를 잘 내고 처음 보는 물건은 꼭 만져 본다." },
];

// 방을 만들 때 고르는 파티 유형
const PRESETS = {
  solo: { maxPlayers: 1, companions: 2, title: "혼자 떠나는 모험" },
  duo: { maxPlayers: 2, companions: 2, title: "둘이 떠나는 모험" },
  party: { maxPlayers: 5, companions: 0, title: "함께 떠나는 모험" },
};

const RECONNECT_GRACE_MS = 3 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 상태

/** @type {Map<string, any>} */
const rooms = new Map();

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
      settings: { ...DEFAULT_SETTINGS, companions: [] },
      members: new Map(),
      log: [],
      generating: null,
      banned: new Set(),
      emptySince: null,
      ooc: [],
      fresh: true,
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
const shortId = () => crypto.randomBytes(5).toString("hex");

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

const connectedMembers = (room) => [...room.members.values()].filter((m) => m.connected);
const turnCount = (room) => room.log.filter((e) => e.type === "turn").length;

function publicState(room, viewer) {
  return {
    t: "state",
    you: viewer.id,
    hostId: room.hostId,
    settings: room.settings,
    turn: turnCount(room) + 1,
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
      maxCompanions: LIMITS.companions,
    },
  };
}

const pushState = (room) => room.members.forEach((m) => send(m.ws, publicState(room, m)));
const pushLog = (room) => broadcast(room, { t: "log", log: room.log });
const notice = (room, text, kind = "info") => broadcast(room, { t: "notice", text, kind });

function systemChat(room, text) {
  const entry = { system: true, text, at: Date.now() };
  room.ooc.push(entry);
  if (room.ooc.length > 200) room.ooc.shift();
  broadcast(room, { t: "ooc", entry });
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

function firstLine(s) {
  const line = String(s || "").split("\n")[0].trim();
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

function formatInputs(inputs, turnNo) {
  const lines = inputs.map((i) => {
    const who = `${i.name}${i.ai ? " [AI 동료]" : ""}${i.persona ? ` (${firstLine(i.persona)})` : ""}`;
    return i.text ? `- ${who}: ${i.text}` : `- ${who}: (이번 턴은 행동 없이 지켜봄)`;
  });
  return `[턴 ${turnNo} · 파티원 행동]\n${lines.length ? lines.join("\n") : "(아무도 행동하지 않음 — 이야기를 자연스럽게 이어가 주세요)"}`;
}

function partyList(room) {
  const humans = [...room.members.values()].map((m) => `- ${m.name}${m.persona ? `: ${m.persona}` : ""}`);
  const ais = room.settings.companions.map((c) => `- ${c.name} [AI 동료]${c.persona ? `: ${c.persona}` : ""}`);
  return [...humans, ...ais].join("\n") || "(없음)";
}

function worldBlock(room) {
  const s = room.settings;
  const parts = [];
  if (s.systemPrompt.trim()) parts.push(`## 세계관 · 캐릭터 설정 (방장 작성)\n${s.systemPrompt.trim()}`);
  parts.push(`## 현재 파티 구성원\n${partyList(room)}`);
  if (s.memo.trim()) parts.push(`## 기억 메모 (반드시 지킬 것)\n${s.memo.trim()}`);
  return parts.join("\n\n");
}

function buildNarratorSystem(room) {
  const length = LENGTHS[room.settings.length] || LENGTHS.normal;
  return [
    "당신은 여러 파티원이 함께 참여하는 롤플레이 '파티챗'의 진행자이자 작가입니다.",
    worldBlock(room),
    [
      "## 진행 규칙",
      "- 매 턴의 사용자 메시지에는 파티원 각자의 행동과 대사가 들어 있습니다. [AI 동료]로 표시된 파티원도 사람 파티원과 똑같이 대우하세요. 모든 입력을 빠짐없이 반영해 하나의 자연스러운 장면으로 이어 쓰세요.",
      "- 파티원의 대사·행동·감정을 입력된 범위를 넘어 마음대로 정하지 마세요. NPC, 주변 세계, 사건의 반응을 중심으로 서술하세요.",
      "- 여러 파티원의 행동이 동시에 일어나면 순서와 상호작용을 자연스럽게 엮고, 특정 파티원만 비중이 커지지 않게 고르게 다루세요.",
      "- 행동에 [주사위 …] 결과가 붙어 있으면 그 수치로 성패를 판정하세요. 최댓값에 가까울수록 크게 성공하고, 낮을수록 실패하거나 대가를 치릅니다.",
      "- 설정과 지금까지의 이야기와 모순되지 않게 쓰세요.",
      `- 분량은 공백 포함 약 ${length.chars}자 안팎으로 쓰세요.`,
      "- 장면은 파티원들이 다음 행동을 고를 수 있는 지점에서 멈추세요.",
      "- 방장 설정에서 다른 언어나 문체를 지정하지 않았다면 한국어 소설체로 씁니다.",
      "- 선택지 목록, 해설, 메타 발언 없이 이야기 본문만 출력하세요.",
    ].join("\n"),
  ].join("\n\n");
}

function buildCompanionSystem(room, comp) {
  return [
    `당신은 롤플레이 '파티챗'에서 파티원 "${comp.name}"을(를) 맡은 플레이어입니다. 다른 파티원은 사람이거나 다른 AI이고, 장면은 진행자가 씁니다.`,
    worldBlock(room),
    `## 당신이 연기할 캐릭터\n이름: ${comp.name}\n${comp.persona || "(설정 없음 — 이야기 흐름에 어울리게 연기)"}`,
    [
      "## 규칙",
      `- 이번 턴 ${comp.name}이(가) 하는 행동이나 대사를 1~3문장, 150자 이내로 쓰세요.`,
      "- 캐릭터의 성격과 말투를 지키고, 직전 장면과 다른 파티원의 이번 턴 행동에 자연스럽게 반응하세요.",
      "- 행동의 결과나 다른 인물의 반응은 쓰지 마세요. 그건 진행자의 몫입니다. 시도와 말만 씁니다.",
      "- 다른 파티원을 대신해 말하거나 행동하지 마세요.",
      "- 대사는 큰따옴표로 감싸고, 이름표나 설명 없이 본문만 출력하세요.",
    ].join("\n"),
  ].join("\n\n");
}

/** 지난 이야기를 대화 기록으로 만든다. 마지막 사용자 메시지는 호출하는 쪽에서 붙인다. */
function historyMessages(room) {
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
    messages.push({ role: "user", content: `[안내] 앞선 이야기 ${turns.length - kept.length}턴은 생략되었습니다. 기억 메모와 이어지는 내용을 바탕으로 진행하세요.` });
    messages.push({ role: "assistant", content: "(앞선 이야기 생략)" });
  }
  for (const t of kept) {
    messages.push({ role: "user", content: formatInputs(t.inputs, t.n) });
    messages.push({ role: "assistant", content: t.story });
  }
  return messages;
}

// ---------------------------------------------------------------- AI 호출

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockScene(inputs) {
  const acts = inputs.filter((i) => i.text).map((i) => i.name);
  return (
    `(테스트 모드) ${acts.length ? acts.join(", ") + "의 움직임에" : "고요 속에서"} 낡은 문이 낮게 삐걱였다. ` +
    "안개가 발목을 휘감고, 멀리서 종소리가 한 번 울려 퍼진다.\n\n" +
    "문틈 사이로 희미한 빛이 새어 나오자, 안쪽에서 쉰 목소리가 들려왔다.\n\n" +
    "\"이 시간에 손님이라니… 길을 잃은 건가, 아니면 일부러 찾아온 건가?\"\n\n" +
    "*등불을 든 노인이 천천히 모습을 드러낸다.* 그의 눈이 파티원들을 하나하나 훑는다."
  );
}
const mockCompanion = (comp) => `(테스트) ${comp.name}이(가) 주변을 살피며 한 걸음 물러선다. "잠깐, 뭔가 이상해."`;

/**
 * 스트리밍으로 텍스트를 생성한다. onText로 조각을 넘기고 최종 텍스트를 돌려준다.
 * 거절되면 { refused: true }.
 */
async function runStream(gen, { system, messages, maxTokens, effort, mock, onText }) {
  if (MOCK_AI) {
    let text = "";
    for (const piece of mock.match(/.{1,6}/gsu)) {
      if (gen.aborted) throw new Anthropic.APIUserAbortError();
      await sleep(22);
      text += piece;
      onText(piece);
    }
    return { text, model: "mock", truncated: false };
  }
  const model = gen.model;
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
    cache_control: { type: "ephemeral" },
  };
  const stream = MODELS[model].fallback
    ? // 안전 분류기가 거절하면 서버 쪽에서 대체 모델로 이어서 생성한다.
      anthropic.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : anthropic.messages.stream(params);
  gen.current = stream;
  stream.on("text", onText);
  const final = await stream.finalMessage();
  gen.current = null;
  if (final.stop_reason === "refusal") return { refused: true };
  const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, model: final.model || model, truncated: final.stop_reason === "max_tokens" };
}

function collectInputs(room) {
  const inputs = [];
  for (const m of [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (m.draft === null && !m.connected) continue;
    inputs.push({ name: m.name, persona: m.persona, text: m.draft ?? "" });
  }
  return inputs;
}

function cleanCompanionText(text, name) {
  let t = text.trim().replace(/^\s*[-*]\s*/, "");
  const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]\\s*`);
  t = t.replace(prefix, "").trim();
  return t.slice(0, 400);
}

/** kind: "turn" (새 턴) | "regen" (마지막 장면 다시 쓰기) */
async function generate(room, kind) {
  if (room.generating) return;
  let inputs;
  let backup = null;
  if (kind === "regen") {
    const last = room.log.at(-1);
    if (!last || last.type !== "turn") return;
    backup = room.log.pop();
    inputs = backup.inputs.map((i) => ({ ...i }));
  } else {
    inputs = collectInputs(room);
  }

  const s = room.settings;
  const gen = {
    kind,
    inputs,
    aborted: false,
    current: null,
    model: MODELS[s.model] ? s.model : DEFAULT_SETTINGS.model,
    abort() {
      this.aborted = true;
      this.current?.abort();
    },
  };
  room.generating = gen;
  const effort = EFFORTS[s.effort] ? s.effort : "low";
  const turnNo = turnCount(room) + 1;
  if (kind === "regen") pushLog(room);
  broadcast(room, { t: "gen_start", kind, inputs, turn: turnNo });
  pushState(room);

  let error = null;
  let story = "";
  let servedBy = gen.model;
  let truncated = false;
  try {
    // 1) AI 동료가 차례로 행동한다 (다시 쓰기는 기존 행동 유지)
    if (kind === "turn") {
      for (const comp of s.companions) {
        if (gen.aborted) break;
        broadcast(room, { t: "comp_start", id: comp.id, name: comp.name });
        const so_far = inputs.length ? inputs.map((i) => `- ${i.name}: ${i.text || "(지켜봄)"}`).join("\n") : "(아직 아무도 행동하지 않음)";
        const result = await runStream(gen, {
          system: buildCompanionSystem(room, comp),
          messages: [
            ...historyMessages(room),
            { role: "user", content: `[턴 ${turnNo} · 지금까지 나온 파티원 행동]\n${so_far}\n\n이번 턴 ${comp.name}의 행동이나 대사를 써 주세요.` },
          ],
          maxTokens: 4000,
          effort: "low",
          mock: mockCompanion(comp),
          onText: (d) => broadcast(room, { t: "comp_delta", id: comp.id, text: d }),
        });
        const text = result.refused ? "" : cleanCompanionText(result.text, comp.name);
        inputs.push({ name: comp.name, persona: comp.persona, text, ai: true });
        broadcast(room, { t: "comp_end", id: comp.id, name: comp.name, text });
      }
    }

    // 2) 진행자가 장면을 쓴다
    if (!gen.aborted) {
      const result = await runStream(gen, {
        system: buildNarratorSystem(room),
        messages: [...historyMessages(room), { role: "user", content: formatInputs(inputs, turnNo) }],
        maxTokens: 32000,
        effort,
        mock: mockScene(inputs),
        onText: (d) => broadcast(room, { t: "delta", text: d }),
      });
      if (result.refused) error = "AI가 이번 장면을 쓰지 않겠다고 했어요. 행동을 바꾸거나 다른 모델로 다시 해 보세요.";
      else {
        story = result.text;
        servedBy = result.model;
        truncated = result.truncated;
      }
    }
  } catch (err) {
    if (gen.aborted || err instanceof Anthropic.APIUserAbortError) gen.aborted = true;
    else {
      error = describeError(err);
      console.error("[생성 실패]", err);
    }
  }

  room.generating = null;

  if (gen.aborted || error || !story.trim()) {
    if (backup) room.log.push(backup);
    if (error) notice(room, error, "error");
    else if (gen.aborted) notice(room, "생성을 멈췄어요. 제출한 행동은 그대로 남아 있어요.");
    else notice(room, "AI 응답이 비어 있어요. 다시 시도해 주세요.", "error");
    broadcast(room, { t: "gen_end", ok: false });
    pushLog(room);
    pushState(room);
    return;
  }

  room.log.push({
    type: "turn",
    n: turnNo,
    inputs: inputs.map(({ name, persona, text, ai }) => (ai ? { name, persona, text, ai: true } : { name, persona, text })),
    story: story.trim(),
    model: servedBy,
    at: Date.now(),
  });
  if (kind === "turn") for (const m of room.members.values()) m.draft = null;
  if (truncated) notice(room, "출력 한도에 닿아 장면이 중간에 끊겼을 수 있어요.");
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
  const allIn = active.every((m) => m.draft !== null);
  const someoneActed = active.some((m) => m.draft !== "") || room.settings.companions.length > 0;
  if (allIn && someoneActed) generate(room, "turn");
}

// ---------------------------------------------------------------- 주사위

function rollDice(expr) {
  const m = /^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?$/i.exec(String(expr || "d20").replace(/\s+/g, ""));
  if (!m) return null;
  const count = Math.min(Math.max(Number(m[1] || 1), 1), 20);
  const sides = Math.min(Math.max(Number(m[2]), 2), 1000);
  const mod = Number(m[3] || 0);
  const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const label = `${count > 1 ? count : ""}d${sides}${mod ? (mod > 0 ? "+" : "") + mod : ""}`;
  const detail = count > 1 || mod ? ` (${rolls.join("+")}${mod ? (mod > 0 ? "+" : "") + mod : ""})` : "";
  return { label, total, max: count * sides + mod, text: `[주사위 ${label}: ${total}${detail}]` };
}

// ---------------------------------------------------------------- 설정

function sanitizeCompanions(list, current) {
  if (!Array.isArray(list)) return current;
  const out = [];
  for (const c of list.slice(0, LIMITS.companions)) {
    const name = oneLine(c?.name, LIMITS.name);
    if (!name) continue;
    const id = typeof c.id === "string" && /^[a-f0-9]{10}$/.test(c.id) ? c.id : shortId();
    out.push({ id, name, persona: clip(c?.persona, LIMITS.persona).trim() });
  }
  return out;
}

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
  if (Number.isInteger(mp) && mp >= 1 && mp <= 5) s.maxPlayers = mp;
  const ht = Number(input.historyTurns);
  if (Number.isInteger(ht) && ht >= 0 && ht <= 500) s.historyTurns = ht;
  if ("companions" in input) s.companions = sanitizeCompanions(input.companions, current.companions);
  return s;
}

function applyPreset(room, presetKey) {
  const p = PRESETS[presetKey];
  if (!p) return;
  room.settings.maxPlayers = p.maxPlayers;
  room.settings.title = p.title;
  room.settings.companions = COMPANION_TEMPLATES.slice(0, p.companions).map((c) => ({ id: shortId(), ...c }));
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
        ? e.inputs.slice(0, 10).map((i) => {
            const o = { name: oneLine(i?.name, LIMITS.name) || "?", persona: clip(i?.persona, LIMITS.persona), text: clip(i?.text, LIMITS.action) };
            if (i?.ai) o.ai = true;
            return o;
          })
        : [];
      out.push({ type: "turn", n, inputs, story: clip(e.story, 60000), model: oneLine(e.model, 40), at: Number(e.at) || 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 메시지 처리

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
      if (room.generating) return send(member.ws, { t: "error", text: "장면을 쓰는 중이에요. 끝나면 제출해 주세요." });
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
    case "roll": {
      const r = rollDice(msg.expr);
      if (!r) return send(member.ws, { t: "error", text: "주사위는 d20, 2d6, 1d100+3처럼 적어 주세요." });
      systemChat(room, `${member.name}님의 주사위 ${r.label} → ${r.total}`);
      send(member.ws, { t: "roll_result", text: r.text, total: r.total, max: r.max });
      return;
    }
    case "memoAdd": {
      if (!hostOnly()) return;
      const text = oneLine(msg.text, 300);
      if (!text) return;
      const memo = room.settings.memo.trim();
      room.settings.memo = clip((memo ? memo + "\n" : "") + "- " + text, LIMITS.memo);
      notice(room, `기억 메모에 추가했어요: ${text}`);
      pushState(room);
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
        if (input.ai) continue;
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
    return send(ws, { t: "join_error", text: "방 코드는 4~64자로 입력해 주세요.", field: "room" });
  }
  const name = oneLine(msg.name, LIMITS.name);
  if (!name) return send(ws, { t: "join_error", text: "닉네임을 입력해 주세요.", field: "name" });
  const token = typeof msg.token === "string" && /^[a-f0-9]{32}$/.test(msg.token) ? msg.token : null;
  if (!token) return send(ws, { t: "join_error", text: "잘못된 접속 정보예요. 새로고침해 주세요." });

  const room = getOrCreateRoom(password);
  if (room.banned.has(token)) return send(ws, { t: "join_error", text: "이 방에서 강퇴되어 들어갈 수 없어요." });

  const created = room.fresh;
  if (room.fresh) {
    room.fresh = false;
    applyPreset(room, msg.preset);
  }

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
      const text = room.settings.maxPlayers === 1 ? "혼자 하는 방이라 들어갈 수 없어요." : `방이 가득 찼어요. (사람 최대 ${room.settings.maxPlayers}명)`;
      return send(ws, { t: "join_error", text });
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
  send(ws, { t: "joined", roomKey: room.key.slice(0, 16), isNewRoom: room.log.length === 0, created });
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
app.use(
  "/fonts/pretendard",
  express.static(path.join(here, "node_modules/pretendard/dist/web/variable"), { maxAge: "30d", immutable: true }),
);
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
