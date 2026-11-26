import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, PERSONAS } from "./prompt.mjs";
import { ttsEnabled, ttsProviders, listVoices, synthesize } from "./tts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.EFFORT ?? "low"; // 통화는 응답 속도가 중요해서 low 기본
const MAX_TURNS = 40; // 너무 긴 기록은 앞부분을 잘라 보냄

const client = new Anthropic();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 첫 인사를 받기 위한 숨은 사용자 턴 (화면에는 보이지 않음)
const CALL_START = "(통화가 연결되었습니다. 먼저 짧게 인사해 주세요.)";

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-MAX_TURNS);
  // 같은 역할이 연달아 오면 합친다 (말 끊김 등으로 user 발화가 두 번 온 경우)
  const merged = [];
  for (const m of msgs) {
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content += " " + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("body too large");
  }
  return JSON.parse(body || "{}");
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  const persona = PERSONAS[payload.persona] ? payload.persona : "haru";
  let messages = sanitizeHistory(payload.messages ?? []);
  if (!messages) {
    res.writeHead(400).end("bad messages");
    return;
  }
  // 클라이언트 기록은 AI의 첫 인사(assistant)부터 시작. 앞에 숨은 '통화 연결' 턴을 붙인다.
  if (messages[0]?.role === "user") messages.unshift({ role: "assistant", content: "여보세요." });
  messages.unshift({ role: "user", content: CALL_START });
  if (messages.at(-1).role !== "user") {
    res.writeHead(400).end("last message must be from user");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 2000,
        output_config: { effort: EFFORT },
        // 안전 분류기가 거절하면 서버에서 다른 모델로 자동 이어받기
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: buildSystemPrompt(persona), cache_control: { type: "ephemeral" } },
        ],
        messages,
      },
      { signal: abort.signal }
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send("delta", { text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send("delta", {
        text: "지금 이 이야기는 제가 잘 이어가기 어려워요. 그래도 당신 곁에 있을게요. 힘들다면 109에 전화해서 이야기 나눠볼 수도 있어요.",
      });
    }
    send("done", { stop_reason: final.stop_reason });
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error("[chat error]", err?.status ?? "", err?.message ?? err);
    const msg =
      err instanceof Anthropic.AuthenticationError || /authentication method/i.test(err?.message ?? "")
        ? "API 키가 설정되지 않았거나 올바르지 않아요. .env 파일을 확인해 주세요."
        : err instanceof Anthropic.RateLimitError
          ? "지금 요청이 많아서 잠깐 쉬어야 해요. 조금 뒤에 다시 말해 주세요."
          : "연결이 잠깐 끊겼어요. 다시 한 번 말해 줄래요?";
    send("error", { message: msg });
  } finally {
    res.end();
  }
}

async function handleVoices(res) {
  let voices = [];
  try {
    voices = await listVoices();
  } catch (err) {
    console.error("[tts voices]", err.message);
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ enabled: ttsEnabled && voices.length > 0, voices }));
}

async function handleTts(req, res) {
  try {
    const { text, voice, rate, pitch } = await readJson(req);
    if (typeof text !== "string" || !text.trim() || text.length > 600) {
      res.writeHead(400).end("bad text");
      return;
    }
    const audio = await synthesize({ text, voice, rate, pitch });
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length });
    res.end(audio);
  } catch (err) {
    console.error("[tts]", err.message);
    res.writeHead(502).end("tts failed");
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// 인터넷에 공개할 땐 APP_PASSWORD 를 꼭 설정 (남이 API 키를 쓰지 못하게)
const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-app-password"] ?? ""));
  const want = Buffer.from(APP_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/") && !authorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"password"}');
    return;
  }
  if (req.method === "GET" && req.url === "/api/auth") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET" && req.url === "/api/tts/voices") return handleVoices(res);
  if (req.method === "POST" && req.url === "/api/tts") return handleTts(req, res);
  if (req.method === "GET" && req.url === "/api/personas") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, desc: p.desc }))));
    return;
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
    console.warn("⚠ ANTHROPIC_API_KEY 가 없어요. .env 에 넣거나 `ant auth login` 으로 로그인하세요.");
  console.log(
    ttsEnabled
      ? `🔊 클라우드 TTS 사용: ${ttsProviders.join(", ")}`
      : "🔈 클라우드 TTS 꺼짐 → 브라우저 음성 사용 (.env 에 CLOVA_* 또는 GOOGLE_TTS_API_KEY 를 넣으면 켜짐)"
  );
  if (!APP_PASSWORD) console.warn("⚠ APP_PASSWORD 가 없어요. 인터넷에 공개한다면 꼭 설정하세요.");
  console.log(`VoiceTalk 멘탈케어 AI → http://localhost:${PORT}  (model=${MODEL}, effort=${EFFORT})`);
});
