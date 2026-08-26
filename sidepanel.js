const POLL_MS = 3000;

let viewMode = "clean";
let current = null;
let pollTimer = null;
let cardIndex = 0;
let cardFlipped = false;
let quizState = { answered: {}, score: 0 };

function $(id) {
  return document.getElementById(id);
}

function parseMd(text) {
  const src = text || "";
  if (globalThis.marked?.parse) return marked.parse(src);
  if (typeof marked === "function") return marked(src);
  return src.replace(/</g, "&lt;");
}

function decorateTiers(html) {
  return html
    .replace(/🔥/g, '<span class="badge">🔥 high</span>')
    .replace(/🟡/g, '<span class="badge">🟡 medium</span>')
    .replace(/⚪/g, '<span class="badge">⚪ low</span>');
}

function transcriptText(record) {
  if (!record) return "";
  if (viewMode === "raw") return record.raw?.markdown || record.raw?.text || "";
  return record.clean?.markdown || record.clean?.text || record.raw?.markdown || "";
}

function stageLabel(stages, key, ready) {
  if (ready) return "ready";
  const s = stages?.[key];
  if (s === "processing") return "processing…";
  if (s === "error") return "error";
  if (s === "done") return "ready";
  return "pending";
}

function setTab(name) {
  document.querySelectorAll("[role=tab]").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

function renderTranscript(record, query) {
  let text = transcriptText(record) || "No transcript yet.";
  if (query) {
    const q = query.toLowerCase();
    text = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(q))
      .join("\n") || "(no matches)";
  }
  $("transcriptBody").textContent = text;
}

function renderNotes(record) {
  $("notesStatus").textContent = record?.notes
    ? ""
    : `Notes ${stageLabel(record?.stages, "notes", false)}`;
  $("notesBody").innerHTML = record?.notes
    ? decorateTiers(parseMd(record.notes))
    : "<p>Notes will appear here as soon as they are generated.</p>";
}

function renderMcqs(record) {
  const items = record?.mcqs || [];
  $("mcqScore").textContent = items.length
    ? `Score ${quizState.score} / ${items.length}`
    : `MCQs ${stageLabel(record?.stages, "mcqs", false)}`;
  const root = $("mcqBody");
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = "<p class='hint'>Questions appear when this stage finishes.</p>";
    return;
  }
  items.forEach((q, i) => {
    const wrap = document.createElement("article");
    wrap.className = "mcq";
    wrap.innerHTML = `<h3>${i + 1}. ${q.question}</h3>`;
    q.options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.textContent = opt;
      if (quizState.answered[i] != null) {
        if (idx === q.correct_index) btn.classList.add("correct");
        if (idx === quizState.answered[i] && idx !== q.correct_index) btn.classList.add("wrong");
      }
      btn.addEventListener("click", () => {
        if (quizState.answered[i] != null) return;
        quizState.answered[i] = idx;
        if (idx === q.correct_index) quizState.score += 1;
        renderMcqs(current);
      });
      wrap.appendChild(btn);
    });
    if (quizState.answered[i] != null) {
      const exp = document.createElement("p");
      exp.className = "explain";
      exp.textContent = q.explanation || "";
      wrap.appendChild(exp);
    }
    root.appendChild(wrap);
  });
}

function renderCard(record) {
  const cards = record?.flashcards || [];
  const stage = $("cardStage");
  if (!cards.length) {
    $("cardMeta").textContent = `Flashcards ${stageLabel(record?.stages, "flashcards", false)}`;
    stage.innerHTML = "<p class='hint'>Cards appear when this stage finishes.</p>";
    return;
  }
  if (cardIndex >= cards.length) cardIndex = 0;
  const card = cards[cardIndex];
  $("cardMeta").textContent = `${cardIndex + 1} / ${cards.length} · ${card.tier || ""}`;
  stage.innerHTML = `
    <div class="card ${cardFlipped ? "flipped" : ""}" id="flipCard">
      <div class="badge">${card.tier === "high" ? "🔥 high" : card.tier === "medium" ? "🟡 medium" : "⚪ low"}</div>
      <div class="face">${card.front}</div>
      <div class="back">${card.back}</div>
    </div>`;
  $("flipCard").addEventListener("click", () => {
    cardFlipped = !cardFlipped;
    renderCard(current);
  });
}

function renderRevision(record) {
  $("revisionBody").innerHTML = record?.revision
    ? decorateTiers(parseMd(record.revision))
    : `<p>Revision ${stageLabel(record?.stages, "revision", false)}</p>`;
}

function renderHistory(rows) {
  const ul = $("lectureList");
  ul.innerHTML = "";
  (rows || []).forEach((row) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = row.title || row.lectureId;
    btn.addEventListener("click", async () => {
      const rec = await loadLectureTranscript(row.lectureId);
      if (!rec) return;
      current = rec;
      quizState = { answered: {}, score: 0 };
      paint(rec);
      if (rec.jobId && !packReady(rec)) startPolling(rec.jobId, rec.lectureId);
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function packReady(rec) {
  return Boolean(rec?.notes && rec?.mcqs && rec?.flashcards && rec?.revision);
}

function paint(record) {
  current = record;
  $("lectureTitle").textContent = record?.title || "Study pack";
  const stages = record?.stages;
  if (record?.error) {
    $("jobLine").textContent = record.error;
  } else if (packReady(record)) {
    $("jobLine").textContent = "All outputs ready";
  } else if (stages) {
    $("jobLine").textContent = `T ${stages.transcript || "…"} · N ${stages.notes || "…"} · Q ${stages.mcqs || "…"} · F ${stages.flashcards || "…"} · R ${stages.revision || "…"}`;
  } else {
    $("jobLine").textContent = "Generating…";
  }
  renderTranscript(record, $("search").value.trim());
  renderNotes(record);
  renderMcqs(record);
  renderCard(record);
  renderRevision(record);
}

function startPolling(jobId, lectureId) {
  stopPolling();
  const tick = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/status/${encodeURIComponent(jobId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const merged = await mergeLectureRecord(lectureId, {
        jobId,
        title: current?.title,
        raw: data.raw,
        clean: data.clean,
        importance: data.importance,
        notes: data.notes,
        mcqs: data.mcqs,
        flashcards: data.flashcards,
        revision: data.revision,
        stages: data.stages,
        error: data.error,
      });
      paint(merged);
      if (data.status === "done" || data.status === "error") stopPolling();
    } catch {
      /* keep polling */
    }
  };
  pollTimer = setInterval(tick, POLL_MS);
  tick();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function loadCurrent() {
  const { currentLectureId, jobState } = await chrome.storage.local.get([
    "currentLectureId",
    "jobState",
  ]);
  const lectureId = currentLectureId || jobState?.lectureId;
  let record = lectureId ? await loadLectureTranscript(lectureId) : null;
  if (!record && lectureId) record = { lectureId, title: lectureId, stages: jobState?.stages };
  if (record) paint(record);
  const rows = await listLectureTranscripts();
  renderHistory(rows);
  if (jobState?.jobId && lectureId && !packReady(record || {})) {
    startPolling(jobState.jobId, lectureId);
  }
}

function downloadExport(format) {
  if (!current?.jobId) return;
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_EXPORT",
    jobId: current.jobId,
    lectureId: current.lectureId,
    format,
    version: format === "srt" ? "raw" : viewMode,
  });
}

document.querySelectorAll("[role=tab]").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

$("viewClean").addEventListener("click", () => {
  viewMode = "clean";
  $("viewClean").classList.add("on");
  $("viewRaw").classList.remove("on");
  renderTranscript(current, $("search").value.trim());
});
$("viewRaw").addEventListener("click", () => {
  viewMode = "raw";
  $("viewRaw").classList.add("on");
  $("viewClean").classList.remove("on");
  renderTranscript(current, $("search").value.trim());
});
$("generatePack").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_GENERATE" }, (res) => {
    void chrome.runtime.lastError;
    if (res?.ok === false) {
      $("jobLine").textContent = res.error || "Could not start generate";
    }
  });
});

$("search").addEventListener("input", () => renderTranscript(current, $("search").value.trim()));
$("copy").addEventListener("click", () => navigator.clipboard.writeText(transcriptText(current) || ""));
$("dlTxt").addEventListener("click", () => downloadExport("txt"));
$("dlMd").addEventListener("click", () => downloadExport("md"));
$("dlSrt").addEventListener("click", () => downloadExport("srt"));
$("cardPrev").addEventListener("click", () => {
  const n = current?.flashcards?.length || 0;
  if (!n) return;
  cardIndex = (cardIndex - 1 + n) % n;
  cardFlipped = false;
  renderCard(current);
});
$("cardNext").addEventListener("click", () => {
  const n = current?.flashcards?.length || 0;
  if (!n) return;
  cardIndex = (cardIndex + 1) % n;
  cardFlipped = false;
  renderCard(current);
});
$("cardFlip").addEventListener("click", () => {
  cardFlipped = !cardFlipped;
  renderCard(current);
});
$("dlPdf").addEventListener("click", () => {
  const text = current?.revision || "";
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) return;
  const doc = new JsPDF({ unit: "pt", format: "letter" });
  const lines = doc.splitTextToSize(text.replace(/[#*_]/g, ""), 500);
  doc.setFont("times", "normal");
  doc.setFontSize(11);
  let y = 48;
  lines.forEach((line) => {
    if (y > 740) {
      doc.addPage();
      y = 48;
    }
    doc.text(line, 48, y);
    y += 14;
  });
  doc.save(`${(current?.lectureId || "revision").slice(0, 40)}.pdf`);
});

chrome.storage.onChanged.addListener(loadCurrent);
loadCurrent();
