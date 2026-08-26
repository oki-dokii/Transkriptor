importScripts("config.js", "idb.js");

let generateInFlight = false;

function lectureIdFrom(url, title) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last !== "index.html") {
      return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "");
    }
    if (parts.length) return parts.join("/");
    if (title) return title.trim();
    return parsed.hostname;
  } catch {
    return title?.trim() || url || "unknown-lecture";
  }
}

function setJobState(patch, sendResponse) {
  chrome.storage.local.get(["jobState"], ({ jobState }) => {
    const cleaned = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) cleaned[key] = value;
    }
    const next = { ...(jobState || {}), ...cleaned, updatedAt: Date.now() };
    chrome.storage.local.set({ jobState: next }, () => {
      if (sendResponse) sendResponse({ ok: true });
    });
  });
}

function setJobStateAsync(patch) {
  return new Promise((resolve) => setJobState(patch, resolve));
}

function safeFilename(name, ext) {
  const base =
    String(name || "lecture")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "lecture";
  return `${base}.${ext}`;
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

function httpError(status, action) {
  const err = new Error(`${action} failed (${status})`);
  err.status = status;
  err.transient = status === 408 || status === 429 || status >= 500;
  return err;
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

async function fetchMediaBlob(url, lectureId) {
  await setJobStateAsync({
    phase: "fetching",
    lectureId,
    bytesFetched: 0,
    bytesTotal: 0,
    error: null,
  });

  const res = await fetch(url, { credentials: "include" });
  if (res.status !== 200 && res.status !== 206) {
    throw httpError(res.status, "Fetch");
  }

  const total = totalFromHeaders(res);
  if (!res.body) {
    const blob = await res.blob();
    await setJobStateAsync({
      phase: "fetching",
      lectureId,
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
    await setJobStateAsync({
      phase: "fetching",
      lectureId,
      bytesFetched: received,
      bytesTotal: total,
    });
  }
  return new Blob(chunks, { type: "video/webm" });
}

async function uploadWebcams(blob, lectureId) {
  await setJobStateAsync({
    phase: "uploading",
    lectureId,
    bytesFetched: blob.size,
    bytesTotal: blob.size,
  });

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

async function persistJobPayload(lectureId, jobId, data) {
  const meta = await chrome.storage.local.get([`lecture:${lectureId}`]);
  const info = meta[`lecture:${lectureId}`] || {};
  const record = await mergeLectureRecord(lectureId, {
    jobId,
    title: info.title || lectureId,
    pageUrl: info.pageUrl || "",
    raw: data.raw ?? undefined,
    clean: data.clean ?? undefined,
    cleanError: data.cleanError ?? undefined,
    importance: data.importance ?? undefined,
    notes: data.notes ?? undefined,
    mcqs: data.mcqs ?? undefined,
    flashcards: data.flashcards ?? undefined,
    revision: data.revision ?? undefined,
    stages: data.stages ?? undefined,
  });
  const { lectureIndex = [] } = await chrome.storage.local.get("lectureIndex");
  const entry = {
    lectureId,
    jobId,
    title: record.title,
    savedAt: record.savedAt,
  };
  const next = [entry, ...lectureIndex.filter((x) => x.lectureId !== lectureId)].slice(0, 40);
  await chrome.storage.local.set({ lectureIndex: next });
  return record;
}

function stagesComplete(stages) {
  if (!stages) return false;
  const keys = ["transcript", "importance", "notes", "mcqs", "flashcards", "revision"];
  return keys.every((k) => stages[k] === "done" || stages[k] === "error");
}

async function pollBackendJob(jobId, lectureId) {
  const res = await fetch(`${BACKEND_URL}/status/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();

  await persistJobPayload(lectureId, jobId, data);

  const finished =
    data.status === "done" || data.status === "error" || stagesComplete(data.stages);

  if (data.status === "error") {
    await chrome.storage.local.set({
      jobState: {
        phase: "error",
        jobId,
        lectureId,
        error: data.error || "Transcription failed",
        updatedAt: Date.now(),
      },
    });
    return { done: true, data };
  }

  await chrome.storage.local.set({
    jobState: {
      phase: finished ? "done" : "processing",
      jobId,
      lectureId,
      stages: data.stages || null,
      error: null,
      updatedAt: Date.now(),
    },
  });
  return { done: finished, data };
}

async function runGenerate(lectureId, webcamUrl, tabId) {
  if (generateInFlight) return;
  generateInFlight = true;
  try {
    const blob = await withOneRetry(() => fetchMediaBlob(webcamUrl, lectureId));
    const jobId = await withOneRetry(() => uploadWebcams(blob, lectureId));
    await setJobStateAsync({
      phase: "processing",
      lectureId,
      jobId,
      error: null,
    });
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: "START_JOB_POLL", jobId, lectureId }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (err) {
    await setJobStateAsync({
      phase: "error",
      lectureId,
      error: err?.message || "Generate transcript failed",
    });
  } finally {
    generateInFlight = false;
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LECTURE_MEDIA_FOUND") {
    const pageUrl = sender.tab?.url || message.pageUrl || "";
    const pageTitle = sender.tab?.title || message.pageTitle || "";
    const lectureId = lectureIdFrom(pageUrl, pageTitle);

    const record = {
      lectureId,
      title: pageTitle,
      pageUrl,
      frameUrl: message.pageUrl || "",
      webcamUrl: message.webcamUrl || null,
      deskshareUrl: message.deskshareUrl || null,
      detectedAt: Date.now(),
    };

    chrome.storage.local.set(
      {
        currentLectureId: lectureId,
        lastDetectedTabId: sender.tab?.id,
        [`lecture:${lectureId}`]: record,
      },
      () => sendResponse({ ok: true, lectureId })
    );
    return true;
  }

  if (message?.type === "JOB_UPDATE") {
    setJobState(
      {
        phase: message.phase,
        lectureId: message.lectureId,
        jobId: message.jobId,
        bytesFetched: message.bytesFetched,
        bytesTotal: message.bytesTotal,
        error: message.error || null,
      },
      sendResponse
    );
    return true;
  }

  if (message?.type === "OPEN_STUDY_PACK") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
      chrome.sidePanel.open({ tabId });
    }
    chrome.storage.local.get(["currentLectureId"], async ({ currentLectureId }) => {
      const lectureId = message.lectureId || currentLectureId;
      if (!lectureId) {
        sendResponse({ ok: true, generate: false });
        return;
      }
      const existing = await loadLectureTranscript(lectureId);
      const hasJob = Boolean(existing?.jobId || existing?.raw);
      sendResponse({ ok: true, generate: !hasJob, lectureId });
    });
    return true;
  }

  if (message?.type === "LIST_LECTURES") {
    listLectureTranscripts()
      .then((rows) => sendResponse({ ok: true, lectures: rows }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "POLL_JOB") {
    pollBackendJob(message.jobId, message.lectureId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ done: false, error: err?.message || "Poll failed" }));
    return true;
  }

  if (message?.type === "DOWNLOAD_EXPORT") {
    const format = message.format || "md";
    const version = message.version || "clean";
    const jobId = message.jobId;
    const url = `${BACKEND_URL}/export/${encodeURIComponent(jobId)}?format=${encodeURIComponent(format)}&version=${encodeURIComponent(version)}`;
    chrome.downloads.download(
      {
        url,
        filename: safeFilename(`${message.lectureId || jobId}-${version}`, format),
        saveAs: true,
      },
      () => sendResponse({ ok: !chrome.runtime.lastError })
    );
    return true;
  }

  if (message?.type === "START_GENERATE") {
    chrome.storage.local.get(["currentLectureId", "lastDetectedTabId"], (items) => {
      const lectureId = items.currentLectureId;
      if (!lectureId) {
        sendResponse({ ok: false, error: "No lecture detected" });
        return;
      }
      chrome.storage.local.get([`lecture:${lectureId}`], (stored) => {
        const record = stored[`lecture:${lectureId}`];
        const tabId = items.lastDetectedTabId;
        if (!record?.webcamUrl) {
          sendResponse({ ok: false, error: "Webcam URL not found" });
          return;
        }
        sendResponse({ ok: true });
        setJobState({
          phase: "starting",
          lectureId,
          jobId: null,
          bytesFetched: 0,
          bytesTotal: 0,
          error: null,
        });
        if (tabId) {
          chrome.tabs.sendMessage(
            tabId,
            {
              type: "START_GENERATE",
              lectureId,
              webcamUrl: record.webcamUrl,
            },
            () => {
              void chrome.runtime.lastError;
            }
          );
        }
        setTimeout(() => {
          chrome.storage.local.get(["jobState"], ({ jobState }) => {
            if (jobState?.lectureId !== lectureId) return;
            if (jobState.phase === "starting") {
              runGenerate(lectureId, record.webcamUrl, tabId);
            }
          });
        }, 4000);
      });
    });
    return true;
  }
});
