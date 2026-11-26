// 클라우드 TTS: ElevenLabs + 네이버 CLOVA Voice (Premium) + Google Cloud TTS
// - 키가 있는 업체만 켜짐. 둘 다 없으면 브라우저 내장 음성으로 동작.
// - 음성 id 는 "업체:음성" 형식 (예: "clova:vyuna", "google:ko-KR-Chirp3-HD-Sulafat").
// - 다른 업체를 붙일 땐 PROVIDERS 에 { enabled, list(), synth() } 하나 추가.

import { stripTags } from "./prompt.mjs";

// ---------------- CLOVA Voice ----------------
const CLOVA_ID = process.env.CLOVA_CLIENT_ID;
const CLOVA_SECRET = process.env.CLOVA_CLIENT_SECRET;
const CLOVA_URL = process.env.CLOVA_TTS_URL ?? "https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts";

// CLOVA 는 음성 목록 API 가 없어서 직접 정의. (멘탈케어 추천 순서)
// 콘솔의 "음성 목록"에서 다른 화자를 쓰고 싶으면 .env 의 CLOVA_SPEAKERS 로 덮어쓰기:
//   CLOVA_SPEAKERS=vyuna:유나:차분한,vgoeun:고은:따뜻한
const CLOVA_DEFAULT = [
  { id: "vyuna", name: "유나", style: "차분한", pick: true },
  { id: "vgoeun", name: "고은", style: "따뜻한", pick: true },
  { id: "vara", name: "아라", style: "다정한", pick: true },
  { id: "nara", name: "아라 (기본)", style: "부드러운", pick: true },
  { id: "vmikyung", name: "미경", style: "성숙한", pick: false },
  { id: "vdain", name: "다인", style: "앳된", pick: false },
];
function clovaSpeakers() {
  const raw = process.env.CLOVA_SPEAKERS?.trim();
  if (!raw) return CLOVA_DEFAULT;
  return raw.split(",").map((s, i) => {
    const [id, name = id, style = ""] = s.split(":").map((x) => x.trim());
    return { id, name, style, pick: i < 4 };
  });
}

// 브라우저 rate(1=보통) → CLOVA speed(-5=2배 빠름, 0=보통, 10=0.5배 느림)
function clovaSpeed(rate) {
  const r = Math.min(2, Math.max(0.5, Number(rate) || 1));
  const s = r >= 1 ? -5 * Math.log2(r) : -10 * Math.log2(r);
  return Math.round(Math.max(-5, Math.min(10, s)));
}
// 브라우저 pitch(1=보통, 클수록 높음) → CLOVA pitch(-5=높게 … 5=낮게)
function clovaPitch(pitch) {
  const p = Number(pitch) || 1;
  return Math.round(Math.max(-5, Math.min(5, -(p - 1) * 10)));
}

const clova = {
  enabled: Boolean(CLOVA_ID && CLOVA_SECRET),
  async list() {
    return clovaSpeakers().map((s) => ({
      id: "clova:" + s.id,
      name: s.name,
      style: s.style,
      gender: "여성",
      provider: "CLOVA",
      pick: s.pick,
      pitch: true,
    }));
  },
  async synth(speaker, { text, rate, pitch }) {
    const body = new URLSearchParams({
      speaker,
      text: stripTags(text),
      volume: "0",
      speed: String(clovaSpeed(rate)),
      pitch: String(clovaPitch(pitch)),
      format: "mp3",
    });
    const r = await fetch(CLOVA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-NCP-APIGW-API-KEY-ID": CLOVA_ID,
        "X-NCP-APIGW-API-KEY": CLOVA_SECRET,
      },
      body,
    });
    if (!r.ok) throw new Error(`clova ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return Buffer.from(await r.arrayBuffer());
  },
};

// ---------------- Google Cloud TTS ----------------
const G_KEY = process.env.GOOGLE_TTS_API_KEY;
const G_BASE = process.env.GOOGLE_TTS_BASE_URL ?? "https://texttospeech.googleapis.com/v1"; // 테스트용 덮어쓰기 가능

// Chirp3-HD 여성 음성의 성격 (Google 음성 설명 기준), 멘탈케어 추천 순
const G_FEMALE = [
  ["Sulafat", "따뜻한", true],
  ["Vindemiatrix", "다정한", true],
  ["Achernar", "부드러운", true],
  ["Despina", "매끄러운", true],
  ["Leda", "앳된", true],
  ["Aoede", "산뜻한"],
  ["Callirrhoe", "편안한"],
  ["Erinome", "맑은"],
  ["Autonoe", "밝은"],
  ["Zephyr", "화사한"],
  ["Laomedeia", "경쾌한"],
  ["Kore", "또렷한"],
  ["Gacrux", "성숙한"],
  ["Pulcherrima", "힘있는"],
];
function gTier(name) {
  if (/Chirp3-HD|Chirp-HD/i.test(name)) return [0, "HD"];
  if (/Neural2/i.test(name)) return [1, "Neural"];
  if (/Wavenet/i.test(name)) return [2, "WaveNet"];
  return [3, "Standard"];
}
let gCache = null;

const google = {
  enabled: Boolean(G_KEY),
  async list() {
    if (gCache) return gCache;
    const r = await fetch(`${G_BASE}/voices?languageCode=ko-KR`, { headers: { "X-Goog-Api-Key": G_KEY } });
    if (!r.ok) throw new Error(`google voices ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const { voices = [] } = await r.json();
    gCache = voices
      .filter((v) => v.languageCodes?.includes("ko-KR") && !/Studio|Polyglot/i.test(v.name))
      .map((v) => {
        const [rank, tier] = gTier(v.name);
        const i = G_FEMALE.findIndex(([n]) => v.name.endsWith("-" + n));
        const short = v.name.replace(/^ko-KR-/, "").replace(/^(Chirp3-HD|Neural2|Wavenet|Standard)-/, "");
        return {
          id: "google:" + v.name,
          name: short,
          style: i >= 0 ? G_FEMALE[i][1] : "",
          gender: v.ssmlGender === "MALE" ? "남성" : v.ssmlGender === "FEMALE" ? "여성" : "",
          provider: "Google " + tier,
          pick: i >= 0 && Boolean(G_FEMALE[i][2]),
          pitch: rank !== 0, // Chirp3-HD 는 pitch 조절 미지원
          _rank: rank,
          _order: i < 0 ? 99 : i,
        };
      })
      .sort((a, b) => {
        const g = (v) => (v.pick ? 0 : v.gender === "여성" ? 1 : 2);
        return g(a) - g(b) || a._rank - b._rank || a._order - b._order || a.id.localeCompare(b.id);
      });
    return gCache;
  },
  async synth(name, { text, rate, pitch }) {
    const audioConfig = { audioEncoding: "MP3", speakingRate: Math.min(2, Math.max(0.5, Number(rate) || 1)) };
    // 브라우저 pitch(1=기본) → Google semitone
    if (!/Chirp3-HD|Chirp-HD/i.test(name))
      audioConfig.pitch = Math.max(-10, Math.min(10, ((Number(pitch) || 1) - 1) * 12));
    const r = await fetch(`${G_BASE}/text:synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": G_KEY },
      body: JSON.stringify({ input: { text: stripTags(text) }, voice: { languageCode: "ko-KR", name }, audioConfig }),
    });
    if (!r.ok) throw new Error(`google ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const { audioContent } = await r.json();
    return Buffer.from(audioContent, "base64");
  },
};

// ---------------- ElevenLabs ----------------
// 보이스 라이브러리(elevenlabs.io → Voices → Library)에서 마음에 드는 목소리를
// "Add to my voices" 하면 여기 목록에 자동으로 나타남. (귀여운/나긋한/속삭이는 목소리 등)
const XI_KEY = process.env.ELEVENLABS_API_KEY;
const XI_BASE = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1"; // 테스트용 덮어쓰기 가능
// eleven_v3: [whispers] 같은 지시어로 속삭임 연기 가능 (ASMR 기본)
// eleven_multilingual_v2: 안정적 / eleven_flash_v2_5: 빠르고 저렴 (이 둘은 지시어를 지우고 읽음)
const XI_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_v3";
const XI_FALLBACK_MODEL = "eleven_multilingual_v2";
let xiV3Broken = false; // v3 호출이 모델 오류로 실패하면 이후엔 v2 사용
let xiCache = null;
let xiCacheAt = 0;

const XI_WORDS = {
  cute: "귀여운", sweet: "달콤한", soft: "부드러운", calm: "차분한", warm: "따뜻한", gentle: "다정한",
  seductive: "매혹적인", sultry: "나른한", sensual: "나긋한", sexy: "섹시한", husky: "허스키한", breathy: "숨결 섞인",
  whisper: "속삭이는", whispery: "속삭이는", asmr: "ASMR", soothing: "편안한", bright: "밝은", young: "앳된",
  playful: "장난스러운", cheerful: "명랑한", mature: "성숙한", deep: "낮은", confident: "당당한", casual: "편한",
};
function xiStyle(v) {
  const l = v.labels || {};
  const raw = [l.descriptive, l.description, l.use_case].filter(Boolean).join(" ").toLowerCase();
  const ko = [...new Set(raw.split(/[\s,_/-]+/).map((w) => XI_WORDS[w]).filter(Boolean))];
  return ko.slice(0, 2).join(" ");
}

// 보이스 라이브러리 인기 한국어 여성 목소리 (많이 쓰인 순). 1시간 캐시.
const XI_POPULAR_COUNT = Number(process.env.ELEVENLABS_POPULAR_COUNT ?? 10);
let xiShared = null;
let xiSharedAt = 0;
const xiAdded = new Map(); // 공유 목소리 → 내 목소리로 추가된 voice_id

async function xiPopular() {
  if (xiShared && Date.now() - xiSharedAt < 60 * 60_000) return xiShared;
  const q = new URLSearchParams({
    page_size: String(Math.min(100, XI_POPULAR_COUNT * 2)),
    language: "ko",
    gender: "female",
    sort: "cloned_by_count",
  });
  const r = await fetch(`${XI_BASE}/shared-voices?${q}`, { headers: { "xi-api-key": XI_KEY } });
  if (!r.ok) throw new Error(`elevenlabs shared ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const { voices = [] } = await r.json();
  xiShared = voices
    .filter((v) => v.voice_id && v.public_owner_id)
    .sort((x, y) => (y.cloned_by_count ?? 0) - (x.cloned_by_count ?? 0))
    .slice(0, XI_POPULAR_COUNT);
  xiSharedAt = Date.now();
  return xiShared;
}

const elevenlabs = {
  enabled: Boolean(XI_KEY),
  async list() {
    // 사용자가 사이트에서 목소리를 추가하면 바로 반영되도록 10분 캐시
    if (xiCache && Date.now() - xiCacheAt < 10 * 60_000) return xiCache;
    const r = await fetch(`${XI_BASE}/voices`, { headers: { "xi-api-key": XI_KEY } });
    if (!r.ok) throw new Error(`elevenlabs voices ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const { voices = [] } = await r.json();
    const mineIds = new Set(voices.map((v) => v.voice_id));
    const mineNames = new Set(voices.map((v) => v.name));
    const mine = voices.map((v) => {
      const g = (v.labels?.gender || "").toLowerCase();
      const own = v.category !== "premade"; // 직접 추가한 목소리 = 추천
      const korean = /korean|ko\b|한국/i.test(JSON.stringify(v.labels || {}) + v.name);
      return {
        id: "elevenlabs:" + v.voice_id,
        name: v.name.replace(/\s*[-–|].*$/, "").slice(0, 24),
        style: xiStyle(v),
        gender: g === "female" ? "여성" : g === "male" ? "남성" : "",
        provider: "ElevenLabs",
        pick: own,
        pitch: false,
        _order: own ? 0 : korean ? 3 : 4,
      };
    });

    // 인기 목소리 (이미 내 목록에 있는 건 제외)
    let popular = [];
    try {
      popular = (await xiPopular())
        .filter((v) => !mineIds.has(v.voice_id) && !mineNames.has(v.name))
        .map((v, i) => ({
          id: `elevenlabs:shared:${v.public_owner_id}:${v.voice_id}`,
          name: v.name.replace(/\s*[-–|].*$/, "").slice(0, 24),
          style: xiStyle({ labels: { descriptive: v.descriptive, use_case: v.use_case } }) || "인기",
          gender: "여성",
          provider: `ElevenLabs 인기 ${i + 1}위`,
          pick: i < 5, // 상위 5개 ★
          pitch: false,
          _order: i < 5 ? 1 : 2,
          _rank: i,
        }));
    } catch (err) {
      console.error("[tts elevenlabs popular]", err.message);
    }

    xiCache = [...mine, ...popular].sort(
      (a, b) => a._order - b._order || (a._rank ?? 0) - (b._rank ?? 0) || a.name.localeCompare(b.name)
    );
    xiCacheAt = Date.now();
    return xiCache;
  },
  async synth(voiceRef, { text, rate }) {
    // 공유(라이브러리) 목소리: 바로 시도 → 안 되면 내 목소리로 추가 후 재시도
    let voiceId = voiceRef;
    let shared = null;
    if (voiceRef.startsWith("shared:")) {
      const [, owner, id] = voiceRef.split(":");
      shared = { owner, id };
      voiceId = xiAdded.get(id) ?? id;
    }
    let r = await xiTts(voiceId, text, rate);
    if (!r.ok && shared && !xiAdded.has(shared.id) && r.status >= 400 && r.status < 500) {
      const add = await fetch(`${XI_BASE}/voices/add/${encodeURIComponent(shared.owner)}/${encodeURIComponent(shared.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": XI_KEY },
        body: JSON.stringify({ new_name: xiShared?.find((v) => v.voice_id === shared.id)?.name ?? `voicetalk-${shared.id.slice(0, 8)}` }),
      });
      if (!add.ok) throw new Error(`elevenlabs add ${add.status}: ${(await add.text()).slice(0, 300)}`);
      const added = (await add.json()).voice_id ?? shared.id;
      xiAdded.set(shared.id, added);
      xiCache = null; // 내 목록이 바뀌었으니 다시 읽기
      r = await xiTts(added, text, rate);
    }
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return Buffer.from(await r.arrayBuffer());
  },
};

async function xiTts(voiceId, text, rate) {
  const call = (model) => {
    const v3 = model === "eleven_v3";
    return fetch(`${XI_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": XI_KEY, Accept: "audio/mpeg" },
      body: JSON.stringify({
        // v3 만 [whispers] 같은 지시어를 연기로 처리. 나머지 모델엔 지시어를 지워서 보냄
        text: v3 ? text : stripTags(text),
        model_id: model,
        language_code: /^eleven_(flash|turbo)/.test(model) ? "ko" : undefined,
        voice_settings: v3
          ? { stability: 0.5, similarity_boost: 0.8 } // v3: 0=창의적, 0.5=자연스러움, 1=안정적
          : {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.25,
              use_speaker_boost: true,
              speed: Math.min(1.2, Math.max(0.7, Number(rate) || 1)),
            },
      }),
    });
  };
  const model = XI_MODEL === "eleven_v3" && xiV3Broken ? XI_FALLBACK_MODEL : XI_MODEL;
  const r = await call(model);
  // v3 를 쓸 수 없는 계정/상황이면 v2 로 자동 전환 (목소리 없음 오류는 제외)
  if (!r.ok && model === "eleven_v3" && r.status >= 400 && r.status < 500) {
    const body = await r.clone().text();
    if (!/voice_not_found|voice not found/i.test(body)) {
      console.error("[tts elevenlabs] v3 실패 → v2 로 전환:", body.slice(0, 200));
      xiV3Broken = true;
      return call(XI_FALLBACK_MODEL);
    }
  }
  return r;
}

// ---------------- 공통 ----------------
// 순서 = 목록 표시 순서 (직접 고른 ElevenLabs 목소리 → CLOVA → Google)
const PROVIDERS = { elevenlabs, clova, google };

export const ttsEnabled = Object.values(PROVIDERS).some((p) => p.enabled);
export const ttsProviders = Object.entries(PROVIDERS)
  .filter(([, p]) => p.enabled)
  .map(([k]) => k);

export async function listVoices() {
  const out = [];
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (!p.enabled) continue;
    try {
      out.push(...(await p.list()));
    } catch (err) {
      console.error(`[tts ${key}]`, err.message);
    }
  }
  // 추천(★) 먼저, 그 안에서는 업체 순서 유지
  return out.map(({ _rank, _order, ...v }) => v).sort((a, b) => Number(b.pick) - Number(a.pick));
}

// text → MP3 Buffer
export async function synthesize({ text, voice, rate = 1, pitch = 1 }) {
  // 요청한 업체가 켜져 있으면 목록 확인 없이 바로 사용 (라이브러리에서 추가된 직후 등)
  let id = typeof voice === "string" ? voice : "";
  if (!PROVIDERS[id.split(":")[0]]?.enabled) {
    const voices = await listVoices();
    id = voices[0]?.id;
    if (!id) throw new Error("사용 가능한 클라우드 음성이 없음");
  }
  const [key, ...rest] = id.split(":");
  return PROVIDERS[key].synth(rest.join(":"), { text, rate, pitch });
}
