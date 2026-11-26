# 마음 통화 (VoiceTalk 멘탈케어 AI)

보이스톡처럼 전화를 걸어 AI와 대화하는 멘탈케어 웹앱입니다. 대사는 모두 LLM(Claude)이 실시간으로 만들고,
시스템 프롬프트가 "심리적 안정감을 주는 말하기" 원칙(경청·감정 반영·타당화·짧은 구어체·그라운딩·위기 대응)을 정합니다.

## 구조
```
브라우저 마이크 ─(Web Speech API, ko-KR STT)→ 텍스트
   → POST /api/chat (SSE 스트리밍) → server.mjs → Claude (claude-opus-5-5, effort=low)
   ← 토큰 스트림 ← 문장 단위로 잘라 바로 TTS(speechSynthesis) 재생 → 끝나면 다시 듣기
```
| 파일 | 역할 |
|---|---|
| `prompt.mjs` | 페르소나(하루·달·솔)와 멘탈케어 대사 원칙 — **대사 톤을 바꾸려면 여기만 고치면 됩니다** |
| `server.mjs` | 정적 파일 + `/api/chat` 스트리밍 프록시 + `/api/tts` (API 키는 서버에만) |
| `tts.mjs` | 클라우드 TTS (CLOVA Voice, Google) — 음성 목록, 문장 → mp3 |
| `public/app.js` | 통화 루프: 듣기 → 침묵 1.4초 감지 → 전송 → 문장별 읽기 → 다시 듣기 |

## 실행
```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY 입력
npm start              # http://localhost:3000
```
- 크롬/엣지(데스크톱·안드로이드), 사파리(iOS)에서 동작. 마이크는 `localhost` 또는 HTTPS에서만 허용됩니다.
- 음성 인식이 안 되는 브라우저에서는 키보드 버튼으로 글로 대화할 수 있습니다.
- 통화 중 가운데 원을 누르면 AI 말을 끊고 바로 말할 수 있습니다.

## 설정 (.env)
- `EFFORT` — `low`(기본, 응답 빠름) / `medium` / `high`
- `MODEL` — 기본 `claude-opus-5-5`
- 안전 분류기가 응답을 거절하면 서버 측 fallback(`fallbacks: "default"`)으로 다른 모델이 이어받습니다.

## 목소리 (톤 · 성별 · 음성)
- **톤**: 대기 화면에서 상대(하루/달/솔)를 고르면 말투와 기본 빠르기·높낮이가 바뀝니다.
- **목소리**: "목소리 설정"에서 선택. `[여성]`/`[남성]` 표시, 미리 듣기, "추천 여성 목소리 이어 듣기"로 ★ 음성을 차례로 비교. 설정은 브라우저에 저장됩니다.
- 클라우드 음성은 앞 문장을 읽는 동안 다음 문장을 미리 받아와 끊김을 줄이고, 실패한 문장은 기기 음성으로 대신 읽습니다.

### 네이버 CLOVA Voice (기본 추천)
한국어가 가장 자연스러워서 목록 맨 위에 나오고, 기본값은 **유나(vyuna)** 입니다.
1. 네이버 클라우드 플랫폼 콘솔 → AI·NAVER API → Application 등록 → **CLOVA Voice** 선택
2. 발급된 Client ID / Client Secret 을 `.env` 의 `CLOVA_CLIENT_ID`, `CLOVA_CLIENT_SECRET` 에 입력
3. 기본 화자: 유나(vyuna) · 고은(vgoeun) · 아라(vara) · 아라 기본(nara) · 미경(vmikyung) · 다인(vdain)
   - CLOVA 는 음성 목록 API 가 없어 코드에 넣어둔 목록입니다. 콘솔의 음성 목록에서 다른 화자를 쓰려면 `CLOVA_SPEAKERS` 로 바꾸세요 (`.env.example` 참고).
   - 계정에서 쓸 수 없는 화자는 오류가 나고 그 문장만 기기 음성으로 대체됩니다.
- 요금: 사용량(글자 수) 기준 과금 — 콘솔에서 확인하세요.

### Google Cloud TTS (선택)
`GOOGLE_TTS_API_KEY` 를 넣으면 Google 한국어 음성(HD/Neural2/WaveNet, 남녀)도 목록에 추가됩니다.
Google Cloud 콘솔 → "Cloud Text-to-Speech API" 사용 설정 → API 키 생성.

### 키가 없으면
브라우저/기기 내장 한국어 음성으로 동작합니다 (기기마다 목록이 다름).

### 다른 업체 추가
`tts.mjs` 의 `PROVIDERS` 에 `{ enabled, list(), synth() }` 하나를 추가하면 됩니다.

## 안전 관련
- 전문 상담·치료를 대신하지 않습니다. 자해·자살 신호가 있으면 AI가 109(자살예방상담전화), 1577-0199(정신건강위기상담), 119/112를 안내하도록 프롬프트에 넣어두었습니다.
- 대화 기록은 브라우저 메모리에만 있고 서버에 저장하지 않습니다 (통화 종료 시 사라짐).

## 다음 단계 아이디어
- 말 끊기(barge-in)를 위한 에코 캔슬링 + VAD
- 통화 후 감정 일기/요약, 이전 통화 기억
