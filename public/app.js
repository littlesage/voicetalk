// 마음 통화 - 브라우저 측: 음성 인식(STT) → 서버(Claude) 스트리밍 → 문장 단위 음성 합성(TTS)
(() => {
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  // 서버에 APP_PASSWORD 가 걸려 있으면 모든 /api 요청에 비밀번호를 붙임
  let appPw = "";
  try { appPw = localStorage.getItem("appPw") || ""; } catch {}
  const api = (url, opts = {}) =>
    fetch(url, { ...opts, headers: { ...(opts.headers || {}), "x-app-password": appPw } });

  const VOICE_TUNING = { haru: { rate: 0.95, pitch: 1.0 }, dal: { rate: 0.88, pitch: 0.9 }, sol: { rate: 1.02, pitch: 1.1 } };
  const SILENCE_MS = 1400; // 이만큼 조용하면 말이 끝난 것으로 봄

  let persona = "haru";
  let personas = [];
  let history = []; // [{role, content}] — AI 첫 인사부터
  let state = "off"; // off | listening | thinking | speaking | waiting
  let muted = false;
  let recog = null;
  let silenceTimer = null;
  let transcript = "";
  let ttsQueue = [];
  let streamDone = true;
  let abortCtl = null;
  let timerId = null;
  let koVoice = null;

  // ---------- 목소리 설정 ----------
  // 선택값: "cloud:<id>" (서버의 고음질 클라우드 TTS) 또는 "device:<name>" (브라우저 내장 음성)
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  // 브라우저는 음성의 성별을 알려주지 않아서, 알려진 이름으로 추정
  const FEMALE = /yuna|sora|sunhi|heami|seoyeon|jimin|yujin|seohyeon|google|female|여성/i;
  const MALE = /injoon|hyunsu|minsu|bongjin|gookmin|jinho|male|남성/i;
  const genderOf = (v) => (MALE.test(v.name) ? "남성" : FEMALE.test(v.name) ? "여성" : "");
  const voiceCfg = { name: null, rate: 0.95, pitch: 1.0, ...(store.get("voiceCfg") || {}) };
  let koVoices = []; // 기기 음성
  let cloudVoices = []; // 클라우드 음성 [{id, gender, tier, pitch}]

  const isCloud = () => voiceCfg.name?.startsWith("cloud:") && cloudVoices.some((v) => "cloud:" + v.id === voiceCfg.name);
  const cloudVoice = () => cloudVoices.find((v) => "cloud:" + v.id === voiceCfg.name);

  function refreshVoices() {
    koVoices = synth
      ? synth.getVoices().filter((v) => v.lang?.toLowerCase().replace("_", "-").startsWith("ko"))
      : [];
    const valid =
      cloudVoices.some((v) => "cloud:" + v.id === voiceCfg.name) ||
      koVoices.some((v) => "device:" + v.name === voiceCfg.name);
    if (!valid || !voiceCfg.userPicked) {
      // 기본값: 클라우드 여성 고음질 > 기기의 자연스러운 음성 > 아무거나
      const c = cloudVoices.find((v) => v.pick) || cloudVoices.find((v) => v.gender === "여성") || cloudVoices[0];
      const d = koVoices.find((v) => /natural|neural|premium|enhanced|yuna|google/i.test(v.name)) || koVoices[0];
      voiceCfg.name = c ? "cloud:" + c.id : d ? "device:" + d.name : null;
    }
    koVoice = koVoices.find((v) => "device:" + v.name === voiceCfg.name) ||
      koVoices.find((v) => /natural|neural|premium|enhanced|yuna|google/i.test(v.name)) || koVoices[0] || null;
    renderVoiceSettings();
  }

  function renderVoiceSettings() {
    const sel = $("voiceSel");
    sel.textContent = "";
    const addGroup = (label, items) => {
      if (!items.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const [value, text] of items) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        o.selected = value === voiceCfg.name;
        g.appendChild(o);
      }
      sel.appendChild(g);
    };
    addGroup(
      "고음질 (클라우드)",
      cloudVoices.map((v) => [
        "cloud:" + v.id,
        `${v.pick ? "★ " : ""}[${v.gender || "?"}] ${v.style ? v.style + " · " : ""}${v.name} (${v.provider})`,
      ])
    );
    addGroup(
      "이 기기 음성",
      koVoices.map((v) => {
        const g = genderOf(v);
        return ["device:" + v.name, (g ? `[${g}] ` : "") + v.name.replace(/^(Microsoft|Google)\s*/, "")];
      })
    );
    if (!sel.options.length) {
      const o = document.createElement("option");
      o.textContent = synth ? "기기 기본 한국어 음성" : "음성 출력 미지원";
      sel.appendChild(o);
    }
    sel.disabled = !cloudVoices.length && !koVoices.length;
    $("compareBtn").hidden = !cloudVoices.some((v) => v.pick);
    $("rate").value = voiceCfg.rate;
    $("pitch").value = voiceCfg.pitch;
    const noPitch = isCloud() && !cloudVoice()?.pitch;
    $("pitch").disabled = noPitch;
    $("pitchNote").hidden = !noPitch;
  }

  function applyPersonaVoice(id) {
    const t = VOICE_TUNING[id] ?? VOICE_TUNING.haru;
    voiceCfg.rate = t.rate;
    voiceCfg.pitch = t.pitch;
    store.set("voiceCfg", voiceCfg);
    renderVoiceSettings();
  }

  $("voiceSel").onchange = (e) => {
    voiceCfg.name = e.target.value;
    voiceCfg.userPicked = true;
    store.set("voiceCfg", voiceCfg);
    refreshVoices();
    preview();
  };
  $("rate").oninput = (e) => { voiceCfg.rate = Number(e.target.value); store.set("voiceCfg", voiceCfg); };
  $("pitch").oninput = (e) => { voiceCfg.pitch = Number(e.target.value); store.set("voiceCfg", voiceCfg); };
  $("previewBtn").onclick = () => preview();

  // 추천 여성 목소리 이어 듣기: 같은 문장을 목소리별로 차례대로 들려줌 (다시 누르면 멈춤)
  let compareGen = 0;
  let comparing = false;
  $("compareBtn").onclick = async () => {
    const btn = $("compareBtn");
    if (comparing) {
      compareGen++;
      player.pause();
      return;
    }
    const list = cloudVoices.filter((v) => v.pick);
    if (!list.length) return;
    const my = ++compareGen;
    comparing = true;
    btn.textContent = "멈추기";
    synth?.cancel();
    for (const v of list) {
      if (my !== compareGen) break;
      $("voiceSel").value = "cloud:" + v.id; // 지금 나오는 목소리를 목록에 표시
      const blob = await fetchCloudAudio(`${v.style ? v.style + " 목소리예요" : "안녕하세요"}. 오늘 하루도 정말 수고 많았어요.`, v.id);
      if (!blob || my !== compareGen) continue;
      player.src = URL.createObjectURL(blob);
      await new Promise((res) => {
        player.onended = player.onerror = player.onpause = res;
        player.play().catch(res);
      });
    }
    player.onended = player.onerror = player.onpause = null;
    comparing = false;
    btn.textContent = "추천 여성 목소리 이어 듣기";
    $("voiceSel").value = voiceCfg.name; // 원래 선택으로 복귀 — 마음에 드는 걸 목록에서 고르면 됨
  };

  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    if (koVoice) u.voice = koVoice;
    u.rate = voiceCfg.rate;
    u.pitch = voiceCfg.pitch;
    return u;
  }

  // 클라우드 TTS: 문장 → mp3 Blob (실패하면 null → 기기 음성으로 대체)
  function fetchCloudAudio(text, voiceId) {
    const v = voiceId ? { id: voiceId } : cloudVoice();
    if (!v) return Promise.resolve(null);
    return api("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: v.id, rate: voiceCfg.rate, pitch: voiceCfg.pitch }),
    })
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
  }

  const player = new Audio();
  player.preload = "auto";
  // 무음 WAV (iOS 등에서 사용자 제스처 안에 오디오 재생을 한 번 풀어두기 위함)
  function unlockAudio() {
    const buf = new ArrayBuffer(46);
    const d = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); d.setUint32(4, 38, true); w(8, "WAVE"); w(12, "fmt ");
    d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
    d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    w(36, "data"); d.setUint32(40, 2, true);
    player.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    player.play().catch(() => {});
  }

  function preview() {
    const name = personas.find((p) => p.id === persona)?.name ?? "하루";
    const hasBatchim = (name.charCodeAt(name.length - 1) - 0xac00) % 28 > 0;
    const text = `안녕하세요, 저 ${name}${hasBatchim ? "이에요" : "예요"}. 오늘도 수고 많았어요.`;
    synth?.cancel();
    player.pause();
    if (isCloud()) {
      fetchCloudAudio(text).then((blob) => {
        if (blob) {
          player.src = URL.createObjectURL(blob);
          player.play().catch(() => {});
        } else synth?.speak(makeUtterance(text));
      });
    } else synth?.speak(makeUtterance(text));
  }

  if (synth) synth.onvoiceschanged = refreshVoices;
  refreshVoices();
  function loadCloudVoices() {
  api("/api/tts/voices")
    .then((r) => r.json())
    .then((d) => {
      cloudVoices = d.enabled ? d.voices : [];
      refreshVoices();
    })
    .catch(() => {});
  }

  const warn = [];
  if (!SR) warn.push("이 브라우저는 음성 인식을 지원하지 않아요. 크롬/엣지/사파리를 쓰거나 키보드로 대화할 수 있어요.");
  if (!synth) warn.push("이 브라우저는 음성 출력을 지원하지 않아 자막으로만 들려드려요.");
  if (warn.length) {
    $("support").hidden = false;
    $("support").textContent = warn.join(" ");
  }

  function loadPersonas() {
  api("/api/personas")
    .then((r) => r.json())
    .then((list) => {
      personas = list;
      const box = $("personas");
      for (const p of list) {
        const b = document.createElement("button");
        b.className = "persona";
        b.setAttribute("aria-pressed", String(p.id === persona));
        b.innerHTML = `<span class="av"></span><span><strong></strong><small></small></span>`;
        b.querySelector(".av").textContent = p.name[0];
        b.querySelector("strong").textContent = p.name;
        b.querySelector("small").textContent = p.desc;
        b.onclick = () => {
          persona = p.id;
          applyPersonaVoice(p.id);
          box.querySelectorAll(".persona").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        };
        box.appendChild(b);
      }
    });
  }

  // ---------- 비밀번호 확인 후 시작 ----------
  async function boot() {
    const r = await api("/api/auth").catch(() => null);
    if (r && r.status === 401) {
      $("gate").hidden = false;
      $("lobby").hidden = true;
      if (appPw) $("gateMsg").textContent = "비밀번호가 맞지 않아요.";
      $("gateInput").focus();
      return;
    }
    $("gate").hidden = true;
    $("lobby").hidden = false;
    loadPersonas();
    loadCloudVoices();
  }
  $("gateForm").onsubmit = (e) => {
    e.preventDefault();
    appPw = $("gateInput").value;
    try { localStorage.setItem("appPw", appPw); } catch {}
    boot();
  };
  boot();

  // ---------- 화면 상태 ----------
  function setState(s, label) {
    state = s;
    const orb = $("orb");
    orb.className = "orb " + ({ listening: "listening", thinking: "thinking", speaking: "speaking" }[s] || "idle");
    const text =
      label ??
      {
        listening: muted ? "음소거 중이에요" : "듣고 있어요…",
        thinking: "",
        speaking: "",
        waiting: "",
      }[s] ??
      "";
    $("status").textContent = text;
  }

  function setCaption(aiText, meText) {
    const c = $("caption");
    c.textContent = "";
    if (meText) {
      const me = document.createElement("span");
      me.className = "me";
      me.textContent = "나: " + meText;
      c.appendChild(me);
    }
    c.appendChild(document.createTextNode(aiText || ""));
    c.scrollTop = c.scrollHeight;
  }

  function startTimer() {
    const t0 = Date.now();
    timerId = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  }

  // ---------- 통화 시작/종료 ----------
  $("callBtn").onclick = async () => {
    // iOS 등에서 사용자 제스처 안에 음성 출력을 한 번 깨워둬야 함
    if (synth) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      synth.speak(u);
    }
    unlockAudio();
    // 마이크 권한을 미리 받아둠
    if (SR && navigator.mediaDevices?.getUserMedia) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        $("support").hidden = false;
        $("support").textContent = "마이크 권한이 없어서 키보드로 대화할게요.";
      }
    }
    history = [];
    $("lobby").hidden = true;
    $("call").hidden = false;
    $("callName").textContent = personas.find((p) => p.id === persona)?.name ?? "하루";
    $("timer").textContent = "00:00";
    setCaption("");
    if (!SR) $("textForm").hidden = false;
    startTimer();
    setState("thinking", "연결 중…");
    askAI(null);
  };

  $("hangBtn").onclick = () => {
    state = "off";
    gen++;
    uttering = false;
    abortCtl?.abort();
    stopListening();
    ttsQueue = [];
    synth?.cancel();
    player.onended = player.onerror = null;
    player.pause();
    clearInterval(timerId);
    $("call").hidden = true;
    $("lobby").hidden = false;
  };

  $("muteBtn").onclick = () => {
    muted = !muted;
    $("muteBtn").setAttribute("aria-pressed", String(muted));
    if (muted) stopListening();
    if (state === "listening") {
      setState("listening");
      if (!muted) startListening();
    }
  };

  $("kbdBtn").onclick = () => {
    const f = $("textForm");
    f.hidden = !f.hidden;
    if (!f.hidden) $("textInput").focus();
  };

  $("textForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("textInput").value.trim();
    if (!v || state === "off") return;
    $("textInput").value = "";
    interruptSpeaking();
    stopListening();
    userSaid(v);
  };

  // AI가 말하는 중에 원을 누르면 끊고 바로 내가 말하기
  $("orb").onclick = () => {
    if (state === "speaking" || state === "thinking") {
      interruptSpeaking();
      listen();
    }
  };

  // ---------- 음성 인식 ----------
  function listen() {
    if (state === "off") return;
    setState("listening");
    if (!muted) startListening();
  }

  function startListening() {
    if (!SR || recog) return;
    transcript = "";
    recog = new SR();
    recog.lang = "ko-KR";
    recog.continuous = true;
    recog.interimResults = true;

    recog.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      transcript = finalText;
      const shown = (finalText + " " + interim).trim();
      if (shown) setCaption("", shown);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finishUtterance((finalText + " " + interim).trim()), SILENCE_MS);
    };
    recog.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        $("textForm").hidden = false;
        setState("listening", "마이크를 쓸 수 없어 글로 대화해요");
      }
    };
    recog.onend = () => {
      recog = null;
      // 말없이 끝났으면 계속 듣기
      if (state === "listening" && !muted) setTimeout(startListening, 250);
    };
    try {
      recog.start();
    } catch {
      recog = null;
    }
  }

  function stopListening() {
    clearTimeout(silenceTimer);
    if (recog) {
      const r = recog;
      recog = null;
      r.onend = null;
      try {
        r.abort();
      } catch {}
    }
  }

  function finishUtterance(text) {
    if (state !== "listening") return;
    stopListening();
    if (!text) return listen();
    userSaid(text);
  }

  // ---------- 대화 ----------
  function userSaid(text) {
    history.push({ role: "user", content: text });
    setCaption("", text);
    askAI(text);
  }

  async function askAI(userText) {
    setState("thinking", userText ? "" : "연결 중…");
    abortCtl = new AbortController();
    streamDone = false;
    ttsQueue = [];
    let full = "";
    let pending = "";

    const flushSentences = (force) => {
      // 문장 끝(. ! ? … ~ 와 공백)마다 잘라서 바로 읽기 시작 → 응답 지연 체감 줄이기
      const re = /^([\s\S]*?[.!?…~。]+)(\s+|$)/;
      let m;
      while ((m = pending.match(re)) && (m[2] || force)) {
        enqueueSpeech(m[1].trim());
        pending = pending.slice(m[0].length);
      }
      if (force && pending.trim()) {
        enqueueSpeech(pending.trim());
        pending = "";
      }
    };

    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona, messages: history }),
        signal: abortCtl.signal,
      });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(raw)?.[1];
          const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (ev === "delta") {
            full += data.text;
            pending += data.text;
            setCaption(full, userText);
            flushSentences(false);
          } else if (ev === "error") {
            full += (full ? " " : "") + data.message;
            pending += " " + data.message;
            setCaption(full, userText);
          }
        }
      }
      flushSentences(true);
    } catch (err) {
      if (state === "off" || err.name === "AbortError") return;
      const msg = "연결이 잠깐 불안정해요. 다시 말해 줄래요?";
      full = msg;
      setCaption(msg, userText);
      enqueueSpeech(msg);
    } finally {
      streamDone = true;
    }

    if (full.trim()) history.push({ role: "assistant", content: full.trim() });
    maybeFinishSpeaking();
  }

  // ---------- 음성 합성 ----------
  // 큐 항목: {text, audio}  audio = 클라우드 음성이면 미리 받아두는 Promise<Blob|null>
  let uttering = false; // 지금 한 문장을 읽는 중인지
  let gen = 0; // 끊기(interrupt) 시 증가 → 이전 콜백 무시

  function enqueueSpeech(text) {
    if (!text || state === "off") return;
    // 클라우드 음성은 큐에 넣는 순간 받기 시작 → 앞 문장 읽는 동안 다음 문장 준비
    ttsQueue.push({ text, audio: isCloud() ? fetchCloudAudio(text) : null });
    if (!uttering) speakNext();
  }

  function speakDevice(text, done) {
    if (!synth) {
      // 음성 출력이 없으면 읽는 시간만큼 기다림
      setTimeout(done, Math.min(6000, 400 + text.length * 90));
      return;
    }
    const u = makeUtterance(text);
    u.onend = u.onerror = done;
    try {
      synth.speak(u);
    } catch {
      setTimeout(done, 0);
    }
  }

  function speakNext() {
    if (state === "off") return;
    const item = ttsQueue.shift();
    if (!item) {
      uttering = false;
      return maybeFinishSpeaking();
    }
    uttering = true;
    setState("speaking");
    const myGen = gen;
    let finished = false;
    const done = () => {
      if (finished || myGen !== gen) return;
      finished = true;
      speakNext();
    };
    if (!item.audio) return speakDevice(item.text, done);

    item.audio.then((blob) => {
      if (myGen !== gen) return;
      if (!blob) return speakDevice(item.text, done);
      const url = URL.createObjectURL(blob);
      const end = () => {
        URL.revokeObjectURL(url);
        done();
      };
      player.onended = end;
      player.onerror = () => {
        URL.revokeObjectURL(url);
        if (myGen === gen && !finished) speakDevice(item.text, done);
      };
      player.src = url;
      player.play().catch(() => {
        if (myGen === gen && !finished) speakDevice(item.text, done);
      });
    });
  }

  function maybeFinishSpeaking() {
    if (state === "off" || uttering) return;
    if (streamDone && ttsQueue.length === 0) listen();
    else if (ttsQueue.length === 0) setState("thinking"); // 다음 문장 스트리밍 대기
  }

  function interruptSpeaking() {
    gen++;
    abortCtl?.abort();
    ttsQueue = [];
    uttering = false;
    streamDone = true;
    state = "waiting";
    synth?.cancel();
    player.onended = player.onerror = null;
    player.pause();
  }
})();
