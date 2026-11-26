// 클라우드 TTS: 네이버 CLOVA Voice (Premium) + Google Cloud TTS
// - 키가 있는 업체만 켜짐. 둘 다 없으면 브라우저 내장 음성으로 동작.
// - 음성 id 는 "업체:음성" 형식 (예: "clova:vyuna", "google:ko-KR-Chirp3-HD-Sulafat").
// - 다른 업체를 붙일 땐 PROVIDERS 에 { enabled, list(), synth() } 하나 추가.

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
      text,
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
      body: JSON.stringify({ input: { text }, voice: { languageCode: "ko-KR", name }, audioConfig }),
    });
    if (!r.ok) throw new Error(`google ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const { audioContent } = await r.json();
    return Buffer.from(audioContent, "base64");
  },
};

// ---------------- 공통 ----------------
// 순서 = 목록 표시 순서 (CLOVA 가 한국어에 더 자연스러워서 먼저)
const PROVIDERS = { clova, google };

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
  const voices = await listVoices();
  const v = voices.find((x) => x.id === voice) ?? voices[0];
  if (!v) throw new Error("사용 가능한 클라우드 음성이 없음");
  const [key, ...rest] = v.id.split(":");
  return PROVIDERS[key].synth(rest.join(":"), { text, rate, pitch });
}
