// 마음 통화 - 브라우저 측: 음성 인식(STT) → 서버(Claude) 스트리밍 → 문장 단위 음성 합성(TTS)
(() => {
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

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

  // ---------- 준비 ----------
  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("ko"));
    // 자연스러운 음성 우선 (기기별 이름이 다름)
    koVoice =
      voices.find((v) => /natural|neural|premium|enhanced|yuna|google/i.test(v.name)) || voices[0] || null;
  }
  if (synth) {
    pickVoice();
    synth.onvoiceschanged = pickVoice;
  }

  const warn = [];
  if (!SR) warn.push("이 브라우저는 음성 인식을 지원하지 않아요. 크롬/엣지/사파리를 쓰거나 키보드로 대화할 수 있어요.");
  if (!synth) warn.push("이 브라우저는 음성 출력을 지원하지 않아 자막으로만 들려드려요.");
  if (warn.length) {
    $("support").hidden = false;
    $("support").textContent = warn.join(" ");
  }

  fetch("/api/personas")
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
          box.querySelectorAll(".persona").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        };
        box.appendChild(b);
      }
    });

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
      const res = await fetch("/api/chat", {
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
  let uttering = false; // 지금 한 문장을 읽는 중인지
  let gen = 0; // 끊기(interrupt) 시 증가 → 이전 콜백 무시

  function enqueueSpeech(text) {
    if (!text || state === "off") return;
    ttsQueue.push(text);
    if (!uttering) speakNext();
  }

  function speakNext() {
    if (state === "off") return;
    const next = ttsQueue.shift();
    if (!next) {
      uttering = false;
      return maybeFinishSpeaking();
    }
    uttering = true;
    setState("speaking");
    const myGen = gen;
    const done = () => {
      if (myGen === gen) speakNext();
    };
    if (!synth) {
      // 음성 출력이 없으면 읽는 시간만큼 기다림
      setTimeout(done, Math.min(6000, 400 + next.length * 90));
      return;
    }
    const u = new SpeechSynthesisUtterance(next);
    u.lang = "ko-KR";
    if (koVoice) u.voice = koVoice;
    const t = VOICE_TUNING[persona] ?? VOICE_TUNING.haru;
    u.rate = t.rate;
    u.pitch = t.pitch;
    u.onend = u.onerror = done;
    try {
      synth.speak(u);
    } catch {
      setTimeout(done, 0);
    }
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
  }
})();
