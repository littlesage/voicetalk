// 클라우드 TTS (Google Cloud Text-to-Speech, REST + API 키)
// 키가 없으면 비활성 → 브라우저 기본 음성으로 동작.
// 다른 업체(CLOVA, ElevenLabs 등)를 붙일 땐 listVoices / synthesize 두 함수만 같은 모양으로 만들면 됨.

const KEY = process.env.GOOGLE_TTS_API_KEY;
const BASE = process.env.GOOGLE_TTS_BASE_URL ?? "https://texttospeech.googleapis.com/v1"; // 테스트용 덮어쓰기 가능

export const ttsEnabled = Boolean(KEY);

let voiceCache = null;

// Chirp3-HD 여성 음성의 성격 (Google 음성 설명 기준). 멘탈케어에 어울리는 순서대로 정렬.
// pick: 추천 표시(★) 대상
const FEMALE_STYLE = [
  ["Sulafat", "따뜻한", true],
  ["Vindemiatrix", "다정한", true],
  ["Achernar", "부드러운", true],
  ["Despina", "매끄러운", true],
  ["Leda", "앳된", true],
  ["Aoede", "산뜻한", false],
  ["Callirrhoe", "편안한", false],
  ["Erinome", "맑은", false],
  ["Autonoe", "밝은", false],
  ["Zephyr", "화사한", false],
  ["Laomedeia", "경쾌한", false],
  ["Kore", "또렷한", false],
  ["Gacrux", "성숙한", false],
  ["Pulcherrima", "힘있는", false],
];
function styleOf(name) {
  const i = FEMALE_STYLE.findIndex(([n]) => name.endsWith("-" + n));
  return i < 0 ? { order: 99, style: "", pick: false } : { order: i, style: FEMALE_STYLE[i][1], pick: FEMALE_STYLE[i][2] };
}

// 음성 이름으로 품질 등급 구분 (Chirp3-HD > Neural2 > Wavenet > Standard)
function tierOf(name) {
  if (/Chirp3-HD|Chirp-HD/i.test(name)) return { rank: 0, label: "HD" };
  if (/Neural2/i.test(name)) return { rank: 1, label: "Neural" };
  if (/Wavenet/i.test(name)) return { rank: 2, label: "WaveNet" };
  return { rank: 3, label: "Standard" };
}

export async function listVoices() {
  if (!ttsEnabled) return [];
  if (voiceCache) return voiceCache;
  const r = await fetch(`${BASE}/voices?languageCode=ko-KR`, { headers: { "X-Goog-Api-Key": KEY } });
  if (!r.ok) throw new Error(`voices ${r.status}: ${await r.text()}`);
  const { voices = [] } = await r.json();
  voiceCache = voices
    .filter((v) => v.languageCodes?.includes("ko-KR") && !/Studio|Polyglot/i.test(v.name))
    .map((v) => {
      const t = tierOf(v.name);
      const st = styleOf(v.name);
      return {
        id: v.name,
        style: st.style,
        pick: st.pick,
        order: st.order,
        gender: v.ssmlGender === "MALE" ? "남성" : v.ssmlGender === "FEMALE" ? "여성" : "",
        tier: t.label,
        rank: t.rank,
        // Chirp3-HD 는 pitch 조절을 지원하지 않음
        pitch: t.rank !== 0,
      };
    })
    // 추천 여성 → 그 외 여성 → 남성, 같은 그룹에선 품질 등급·성격 순
    .sort((a, b) => {
      const g = (v) => (v.pick ? 0 : v.gender === "여성" ? 1 : 2);
      return g(a) - g(b) || a.rank - b.rank || a.order - b.order || a.id.localeCompare(b.id);
    });
  return voiceCache;
}

// text → MP3 Buffer
export async function synthesize({ text, voice, rate = 1, pitch = 1 }) {
  const voices = await listVoices();
  const v = voices.find((x) => x.id === voice) ?? voices[0];
  if (!v) throw new Error("no ko-KR voice");
  const audioConfig = {
    audioEncoding: "MP3",
    speakingRate: Math.min(2, Math.max(0.5, Number(rate) || 1)),
  };
  // 브라우저 pitch(0.5~1.6, 1=기본) → Google semitone(-20~20)
  if (v.pitch) audioConfig.pitch = Math.max(-10, Math.min(10, ((Number(pitch) || 1) - 1) * 12));
  const r = await fetch(`${BASE}/text:synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
    body: JSON.stringify({ input: { text }, voice: { languageCode: "ko-KR", name: v.id }, audioConfig }),
  });
  if (!r.ok) throw new Error(`synthesize ${r.status}: ${await r.text()}`);
  const { audioContent } = await r.json();
  return Buffer.from(audioContent, "base64");
}
