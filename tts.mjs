// 클라우드 TTS (Google Cloud Text-to-Speech, REST + API 키)
// 키가 없으면 비활성 → 브라우저 기본 음성으로 동작.
// 다른 업체(CLOVA, ElevenLabs 등)를 붙일 땐 listVoices / synthesize 두 함수만 같은 모양으로 만들면 됨.

const KEY = process.env.GOOGLE_TTS_API_KEY;
const BASE = process.env.GOOGLE_TTS_BASE_URL ?? "https://texttospeech.googleapis.com/v1"; // 테스트용 덮어쓰기 가능

export const ttsEnabled = Boolean(KEY);

let voiceCache = null;

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
      return {
        id: v.name,
        gender: v.ssmlGender === "MALE" ? "남성" : v.ssmlGender === "FEMALE" ? "여성" : "",
        tier: t.label,
        rank: t.rank,
        // Chirp3-HD 는 pitch 조절을 지원하지 않음
        pitch: t.rank !== 0,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.gender.localeCompare(b.gender) || a.id.localeCompare(b.id));
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
