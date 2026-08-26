const STATUS_POLL_MS = 3000;

let statusPollTimer = null;
let pollingJobId = null;
let viewMode = "clean";
let currentTranscript = null;
let currentJobId = null;

function formatBytes(n) {
  if (!n) return "0";
  return String(n);
}

function formatFetchProgress(job) {
  const fetched = job.bytesFetched ?? 0;
  const total = job.bytesTotal ?? 0;
  if (total) return `Fetching webcams… ${formatBytes(fetched)} / ${formatBytes(total)} bytes`;
  return `Fetching webcams… ${formatBytes(fetched)} bytes`;
}

function jobBusy(job) {
  return job && ["starting", "fetching", "uploading", "processing"].includes(job.phase);
}

function transcriptText(record) {
  if (!record) return "";
  if (viewMode === "raw") {
    return (
      record.raw?.markdown ||
      record.raw?.text ||
      ""
    );
  }
  return (
    record.clean?.markdown ||
    record.clean?.text ||
    record.raw?.markdown ||
    record.raw?.text ||
    ""
  );
}

function hasTranscriptText(record) {
  if (!record) return false;
  const raw = record.raw?.markdown || record.raw?.text || "";
  const clean = record.clean?.markdown || record.clean?.text || "";
  return Boolean(raw.trim() || clean.trim());
}

function render(lecture, job, transcript) {
  const status = document.getElementById("status");
  const webcamEl = document.getElementById("webcamUrl");
  const deskshareEl = document.getElementById("deskshareUrl");
  const jobStatus = document.getElementById("jobStatus");
  const transcriptEl = document.getElementById("transcript");
  const generate = document.getElementById("generate");
  const actions = document.getElementById("actions");
  const viewToggle = document.getElementById("viewToggle");

  currentTranscript = transcript;
  currentJobId = job?.jobId || transcript?.jobId || null;

  if (!lecture) {
    status.textContent = "No lecture detected yet.";
    webcamEl.textContent = "—";
    deskshareEl.textContent = "—";
  } else {
    status.textContent = "Lecture detected";
    webcamEl.textContent = lecture.webcamUrl || "Not found";
    deskshareEl.textContent = lecture.deskshareUrl || "Not found";
  }

  generate.disabled = !lecture?.webcamUrl || jobBusy(job);

  const statusText = (() => {
    if (!job) return "";
    if (job.phase === "fetching") return formatFetchProgress(job);
    if (job.phase === "uploading") return "Uploading webcams…";
    if (job.phase === "processing") return "Processing… waiting for transcript";
    if (job.phase === "done") {
      return job.cleanError ? `Done (clean fallback: ${job.cleanError})` : "Done";
    }
    if (job.phase === "error") return job.error || "Something went wrong";
    if (job.phase === "starting") return "Starting…";
    return "";
  })();
  jobStatus.textContent = statusText;
  jobStatus.hidden = !statusText;

  const ready = hasTranscriptText(transcript);
  viewToggle.hidden = !ready;
  actions.hidden = !ready;
  document.getElementById("viewRaw").setAttribute("aria-pressed", String(viewMode === "raw"));
  document.getElementById("viewClean").setAttribute("aria-pressed", String(viewMode === "clean"));
  transcriptEl.textContent = ready
    ? transcriptText(transcript)
    : jobBusy(job)
      ? ""
      : "No transcript yet. Click Generate Transcript.";
}

async function load() {
  const items = await chrome.storage.local.get(["currentLectureId", "jobState"]);
  let { currentLectureId, jobState } = items;
  if (
    jobState?.phase === "processing" &&
    (!jobState.jobId || String(jobState.jobId).startsWith("stub-"))
  ) {
    jobState = { ...jobState, phase: "idle" };
    await chrome.storage.local.set({ jobState });
  }
  let lecture = null;
  if (currentLectureId) {
    const stored = await chrome.storage.local.get([`lecture:${currentLectureId}`]);
    lecture = stored[`lecture:${currentLectureId}`] || null;
  }
  const lectureId = currentLectureId || jobState?.lectureId;
  const transcript = lectureId ? await loadLectureTranscript(lectureId) : null;
  render(lecture, jobState, transcript);
  syncStatusPolling(jobState);
}

async function persistDone(jobId, lectureId, data) {
  await saveLectureTranscript({
    lectureId,
    jobId,
    raw: data.raw || null,
    clean: data.clean || null,
    cleanError: data.cleanError || null,
    savedAt: Date.now(),
  });
  await chrome.storage.local.set({
    jobState: {
      phase: "done",
      jobId,
      lectureId,
      error: null,
      cleanError: data.cleanError || null,
      updatedAt: Date.now(),
    },
  });
}

async function pollStatusOnce(jobId) {
  const { jobState } = await chrome.storage.local.get(["jobState"]);
  const lectureId = jobState?.lectureId;
  try {
    const res = await fetch(`${BACKEND_URL}/status/${encodeURIComponent(jobId)}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (data.status === "done") {
      await persistDone(jobId, lectureId, data);
      stopStatusPolling();
      return;
    }
    if (data.status === "error") {
      await chrome.storage.local.set({
        jobState: {
          ...(jobState || {}),
          phase: "error",
          jobId,
          error: data.error || "Transcription failed",
          updatedAt: Date.now(),
        },
      });
      stopStatusPolling();
      return;
    }
    await chrome.storage.local.set({
      jobState: {
        ...(jobState || {}),
        phase: "processing",
        jobId,
        updatedAt: Date.now(),
      },
    });
  } catch (err) {
    await chrome.storage.local.set({
      jobState: {
        ...(jobState || {}),
        phase: "error",
        jobId,
        error: err?.message || "Status poll failed",
        updatedAt: Date.now(),
      },
    });
    stopStatusPolling();
  }
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  pollingJobId = null;
}

function syncStatusPolling(job) {
  if (job?.phase === "processing" && job.jobId) {
    if (pollingJobId === job.jobId && statusPollTimer) return;
    stopStatusPolling();
    pollingJobId = job.jobId;
    statusPollTimer = setInterval(() => pollStatusOnce(job.jobId), STATUS_POLL_MS);
    pollStatusOnce(job.jobId);
    return;
  }
  if (job?.phase === "done" || job?.phase === "error") stopStatusPolling();
}

function download(format) {
  if (!currentJobId) return;
  const version = format === "srt" ? "raw" : viewMode;
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_EXPORT",
    jobId: currentJobId,
    lectureId: currentTranscript?.lectureId,
    format,
    version,
  });
}

document.getElementById("generate").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_GENERATE" }, () => {
    void chrome.runtime.lastError;
  });
});

document.getElementById("openPanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

document.getElementById("viewRaw").addEventListener("click", () => {
  viewMode = "raw";
  document.getElementById("transcript").textContent = transcriptText(currentTranscript);
  document.getElementById("viewRaw").setAttribute("aria-pressed", "true");
  document.getElementById("viewClean").setAttribute("aria-pressed", "false");
});

document.getElementById("viewClean").addEventListener("click", () => {
  viewMode = "clean";
  document.getElementById("transcript").textContent = transcriptText(currentTranscript);
  document.getElementById("viewRaw").setAttribute("aria-pressed", "false");
  document.getElementById("viewClean").setAttribute("aria-pressed", "true");
});

document.getElementById("copy").addEventListener("click", async () => {
  const text = document.getElementById("transcript").textContent || "";
  await navigator.clipboard.writeText(text);
});

document.getElementById("dlTxt").addEventListener("click", () => download("txt"));
document.getElementById("dlMd").addEventListener("click", () => download("md"));
document.getElementById("dlSrt").addEventListener("click", () => download("srt"));

chrome.storage.onChanged.addListener(load);
load();
