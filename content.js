const POLL_MS = 300;
const TIMEOUT_MS = 8000;

let webcamUrl = null;
let deskshareUrl = null;
let sent = false;
let generateInFlight = false;
let jobPollTimer = null;

function srcOf(video) {
  return video.currentSrc || video.src || "";
}

function scanVideos() {
  const videos = document.querySelectorAll("video");
  for (const video of videos) {
    const src = srcOf(video);
    if (!src) continue;
    if (/webcams/i.test(src)) webcamUrl = src;
    if (/deskshare/i.test(src)) deskshareUrl = src;
  }
}

function sendIfFound() {
  if (sent) return false;
  if (!webcamUrl && !deskshareUrl) return false;

  chrome.runtime.sendMessage({
    type: "LECTURE_MEDIA_FOUND",
    webcamUrl,
    deskshareUrl,
    pageUrl: location.href,
    pageTitle: document.title,
  });
  sent = true;
  return true;
}

function tick() {
  scanVideos();
  if (webcamUrl && deskshareUrl) {
    sendIfFound();
    return true;
  }
  return false;
}

function report(update) {
  chrome.runtime.sendMessage({ type: "JOB_UPDATE", ...update });
}

function isTransient(err) {
  if (!err) return false;
  if (err.transient) return true;
  if (err.name === "TypeError") return true;
  const status = err.status;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    return await fn();
  }
}

function totalFromHeaders(res) {
  const range = res.headers.get("Content-Range");
  if (range) {
    const match = /\/(\d+)\s*$/.exec(range);
    if (match) return Number(match[1]);
  }
  const length = res.headers.get("Content-Length");
  if (length && /^\d+$/.test(length)) return Number(length);
  return 0;
}

function httpError(status, action) {
  const err = new Error(`${action} failed (${status})`);
  err.status = status;
  err.transient = status === 408 || status === 429 || status >= 500;
  return err;
}

async function fetchWebcamsBlob(url) {
  const res = await fetch(url, { credentials: "include" });
  if (res.status !== 200 && res.status !== 206) {
    throw httpError(res.status, "Fetch");
  }

  const total = totalFromHeaders(res);
  if (!res.body) {
    const blob = await res.blob();
    report({
      phase: "fetching",
      bytesFetched: blob.size,
      bytesTotal: total || blob.size,
    });
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    report({
      phase: "fetching",
      bytesFetched: received,
      bytesTotal: total,
    });
  }
  return new Blob(chunks, { type: "video/webm" });
}

async function uploadWebcams(blob, lectureId) {
  report({ phase: "uploading", bytesFetched: blob.size, bytesTotal: blob.size });

  const form = new FormData();
  form.append("file", blob, "webcams.webm");
  form.append("lectureId", lectureId);
  form.append("kind", "webcams");

  const res = await fetch(`${BACKEND_URL}/upload`, { method: "POST", body: form });
  if (!res.ok) throw httpError(res.status, "Upload");
  const data = await res.json().catch(() => ({}));
  if (!data.jobId) throw new Error("Upload did not return a jobId");
  return data.jobId;
}

function sameOriginAs(url) {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function startJobPoll(jobId, lectureId) {
  if (jobPollTimer) clearInterval(jobPollTimer);
  const tickPoll = () => {
    chrome.runtime.sendMessage({ type: "POLL_JOB", jobId, lectureId }, (res) => {
      void chrome.runtime.lastError;
      if (res?.done && jobPollTimer) {
        clearInterval(jobPollTimer);
        jobPollTimer = null;
      }
    });
  };
  jobPollTimer = setInterval(tickPoll, 3000);
  tickPoll();
}

async function generateTranscript(lectureId, url) {
  if (generateInFlight) return;
  generateInFlight = true;
  try {
    report({ phase: "fetching", lectureId, bytesFetched: 0, bytesTotal: 0 });
    const blob = await withOneRetry(() => fetchWebcamsBlob(url));
    const jobId = await withOneRetry(() => uploadWebcams(blob, lectureId));
    report({ phase: "processing", lectureId, jobId });
    startJobPoll(jobId, lectureId);
  } catch (err) {
    report({
      phase: "error",
      lectureId,
      error: err?.message || "Generate transcript failed",
    });
  } finally {
    generateInFlight = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_JOB_POLL" && message.jobId) {
    startJobPoll(message.jobId, message.lectureId);
    return;
  }

  if (message?.type !== "START_GENERATE") return;

  const url = message.webcamUrl || webcamUrl;
  if (!url || !sameOriginAs(url)) return;

  sendResponse({ ok: true });
  generateTranscript(message.lectureId, url);
});

function injectStudyButton() {
  if (!document.querySelector("video")) return;
  if (document.getElementById("ct-study-fab-host")) return;

  const host = document.createElement("div");
  host.id = "ct-study-fab-host";
  host.style.cssText = [
    "all:initial",
    "position:fixed",
    "right:20px",
    "bottom:28px",
    "z-index:2147483647",
    "pointer-events:auto",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "🧠 Generate Study Pack";
  btn.style.cssText = [
    "pointer-events:auto",
    "cursor:pointer",
    "padding:10px 14px",
    "border:0",
    "border-radius:999px",
    "background:#1c1914",
    "color:#f3e6c8",
    "font:600 13px/1.2 Palatino,Georgia,serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.45)",
  ].join(";");
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_STUDY_PACK" }, (res) => {
      void chrome.runtime.lastError;
      if (res?.generate) chrome.runtime.sendMessage({ type: "START_GENERATE" });
    });
  });
  shadow.appendChild(btn);
  (document.body || document.documentElement).appendChild(host);
}

  const host = document.createElement("div");
  host.id = "ct-study-fab-host";
  host.style.cssText = [
    "all:initial",
    "position:fixed",
    "right:20px",
    "bottom:28px",
    "z-index:2147483647",
    "pointer-events:auto",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "🧠 Generate Study Pack";
  btn.style.cssText = [
    "pointer-events:auto",
    "cursor:pointer",
    "padding:10px 14px",
    "border:0",
    "border-radius:999px",
    "background:#1c1914",
    "color:#f3e6c8",
    "font:600 13px/1.2 Palatino,Georgia,serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.45)",
  ].join(";");
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_STUDY_PACK" }, (res) => {
      void chrome.runtime.lastError;
      if (res?.generate) chrome.runtime.sendMessage({ type: "START_GENERATE" });
    });
  });
  shadow.appendChild(btn);
  (document.body || document.documentElement).appendChild(host);
}

injectStudyButton();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectStudyButton);
}
setTimeout(injectStudyButton, 1500);
setTimeout(injectStudyButton, 5000);
new MutationObserver(() => injectStudyButton()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

if (!tick()) {
  const started = Date.now();
  const intervalId = setInterval(() => {
    if (tick() || Date.now() - started >= TIMEOUT_MS) {
      clearInterval(intervalId);
      sendIfFound();
    }
  }, POLL_MS);
}
