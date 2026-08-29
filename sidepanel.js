const POLL_MS = 3000;

let viewMode = "clean";
let current = null;
let pollTimer = null;
let cardIndex = 0;
let cardFlipped = false;
let quizState = { answered: {}, score: 0 };
let resumeInFlight = false;

function $(id) {
  return document.getElementById(id);
}

function parseMd(text) {
  const src = String(text || "");
  try {
    if (globalThis.marked?.parse) return marked.parse(src);
    if (typeof marked === "function") return marked(src);
  } catch {
    /* fall through */
  }
  return src.replace(/</g, "&lt;").replace(/\n/g, "<br>");
}

function applyStatus(record, data, jobId) {
  return {
    ...(record || {}),
    jobId: jobId || record?.jobId,
    title: record?.title,
    raw: data.raw || record?.raw,
    clean: data.clean || record?.clean,
    importance: data.importance || record?.importance,
    notes: data.notes || record?.notes,
    mcqs: Array.isArray(data.mcqs) && data.mcqs.length ? data.mcqs : record?.mcqs,
    flashcards:
      Array.isArray(data.flashcards) && data.flashcards.length
        ? data.flashcards
        : record?.flashcards,
    revision: data.revision || record?.revision,
    stages: data.stages || record?.stages,
    error: data.error || record?.error,
  };
}

function typesetMath(el) {
  if (!el || typeof renderMathInElement !== "function") return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  } catch {
    /* KaTeX optional */
  }
}

function setMarkdown(el, markdown) {
  const html = decorateTiers(parseMd(markdown));
  el.innerHTML = html && String(html).trim() ? html : String(markdown).replace(/</g, "&lt;").replace(/\n/g, "<br>");
  typesetMath(el);
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
  const el = $("transcriptBody");
  if (viewMode === "raw" || query) {
    el.className = "scroll paper";
    el.textContent = text;
    return;
  }
  el.className = "scroll prose";
  setMarkdown(el, text);
}

function renderNotes(record) {
  const notes = (record?.notes || "").trim();
  $("notesStatus").textContent = notes
    ? ""
    : `Notes ${stageLabel(record?.stages, "notes", false)}`;
  if (!notes) {
    $("notesBody").innerHTML = "<p>Notes will appear here as soon as they are generated.</p>";
    return;
  }
  setMarkdown($("notesBody"), notes);
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
    const title = document.createElement("h3");
    title.textContent = `${i + 1}. ${q.question}`;
    wrap.appendChild(title);
    typesetMath(title);
    q.options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.textContent = opt;
      typesetMath(btn);
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
      typesetMath(exp);
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
      <div class="face"></div>
      <div class="back"></div>
    </div>`;
  const face = stage.querySelector(".face");
  const back = stage.querySelector(".back");
  face.textContent = card.front;
  back.textContent = card.back;
  typesetMath(face);
  typesetMath(back);
  $("flipCard").addEventListener("click", () => {
    cardFlipped = !cardFlipped;
    renderCard(current);
  });
}

function renderRevision(record) {
  const revision = (record?.revision || "").trim();
  if (!revision) {
    $("revisionBody").innerHTML = `<p>Revision ${stageLabel(record?.stages, "revision", false)}</p>`;
    return;
  }
  setMarkdown($("revisionBody"), revision);
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

function hasTranscript(record) {
  const segs = record?.raw?.segments || record?.transcript;
  return Array.isArray(segs) && segs.length > 0;
}

function packReady(rec) {
  return Boolean(
    rec?.notes &&
      Array.isArray(rec?.mcqs) &&
      rec.mcqs.length &&
      Array.isArray(rec?.flashcards) &&
      rec.flashcards.length &&
      rec?.revision
  );
}

function paint(record) {
  current = record;
  $("lectureTitle").textContent = record?.title || "Study pack";
  const stages = record?.stages;
  if (record?.error) {
    $("jobLine").textContent = record.error;
  } else if (packReady(record)) {
    $("jobLine").textContent = "All outputs ready";
  } else if (hasTranscript(record) && !packReady(record)) {
    $("jobLine").textContent = "Transcript ready. Building notes / MCQs / cards…";
  } else if (stages) {
    $("jobLine").textContent = `T ${stages.transcript || "…"} · N ${stages.notes || "…"} · Q ${stages.mcqs || "…"} · F ${stages.flashcards || "…"} · R ${stages.revision || "…"}`;
  } else {
    $("jobLine").textContent = "Generating…";
  }
  $("generatePack").textContent =
    hasTranscript(record) && !packReady(record) ? "Finish study pack" : "Generate study pack";
  renderTranscript(record, $("search").value.trim());
  renderNotes(record);
  renderMcqs(record);
  renderCard(record);
  renderRevision(record);
}

async function resumeStudyPack(record) {
  if (resumeInFlight || !hasTranscript(record) || packReady(record)) return;
  resumeInFlight = true;
  $("jobLine").textContent = "Finishing study pack from saved transcript…";
  try {
    const res = await fetch(`${BACKEND_URL}/from-transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lectureId: record.lectureId,
        segments: record.raw?.segments || record.transcript,
        raw: record.raw,
        clean: record.clean,
      }),
    });
    if (!res.ok) {
      $("jobLine").textContent = `Could not finish study pack (${res.status})`;
      return;
    }
    const data = await res.json();
    const jobId = data.jobId;
    const merged = await mergeLectureRecord(record.lectureId, {
      jobId,
      stages: {
        transcript: "done",
        importance: "pending",
        notes: "pending",
        mcqs: "pending",
        flashcards: "pending",
        revision: "pending",
      },
    });
    await chrome.storage.local.set({
      jobState: {
        phase: "processing",
        lectureId: record.lectureId,
        jobId,
        error: null,
        updatedAt: Date.now(),
      },
    });
    paint(merged);
    startPolling(jobId, record.lectureId);
  } catch (err) {
    $("jobLine").textContent = err?.message || "Could not finish study pack";
  } finally {
    resumeInFlight = false;
  }
}

function startPolling(jobId, lectureId) {
  stopPolling();
  const tick = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/status/${encodeURIComponent(jobId)}`);
      if (res.status === 404) {
        stopPolling();
        const rec = await loadLectureTranscript(lectureId);
        if (hasTranscript(rec) && !packReady(rec)) {
          await resumeStudyPack(rec);
        } else {
          $("jobLine").textContent = "Job lost after API restart. Click Finish study pack.";
        }
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const live = applyStatus(current, data, jobId);
      live.lectureId = lectureId;
      paint(live);
      mergeLectureRecord(lectureId, {
        jobId,
        title: live.title,
        raw: data.raw,
        clean: data.clean,
        importance: data.importance,
        notes: data.notes,
        mcqs: data.mcqs,
        flashcards: data.flashcards,
        revision: data.revision,
        stages: data.stages,
        error: data.error,
      }).catch(() => {});
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
  if (current?.lectureId === lectureId) {
    record = applyStatus(record, current, current.jobId);
  }
  if (record) paint(record);
  const rows = await listLectureTranscripts();
  renderHistory(rows);
  if (packReady(record || {})) return;
  if (resumeInFlight || pollTimer) return;
  if (jobState?.jobId && lectureId) {
    startPolling(jobState.jobId, lectureId);
    return;
  }
  if (hasTranscript(record) && !packReady(record)) {
    await resumeStudyPack(record);
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
  if (pollTimer || resumeInFlight) return;
  if (hasTranscript(current) && !packReady(current)) {
    resumeStudyPack(current);
    return;
  }
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
  const raw = (current?.revision || current?.notes || "").trim();
  if (!raw) {
    $("jobLine").textContent = "Revision is not ready yet.";
    return;
  }
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) {
    $("jobLine").textContent = "PDF library failed to load.";
    return;
  }
  const doc = new JsPDF({ unit: "pt", format: "letter" });
  const safe = raw
    .replace(/[#*_`]/g, "")
    .replace(/[^\t\n\r\x20-\x7E]/g, " ")
    .replace(/[ \t]+\n/g, "\n");
  const lines = doc.splitTextToSize(safe, 500);
  doc.setFont("times", "normal");
  doc.setFontSize(11);
  let y = 48;
  lines.forEach((line) => {
    if (y > 740) {
      doc.addPage();
      y = 48;
    }
    try {
      doc.text(String(line || " "), 48, y);
    } catch {
      /* skip a line that the built-in font cannot draw */
    }
    y += 14;
  });
  doc.save(`${(current?.lectureId || "revision").slice(0, 40)}.pdf`);
});

chrome.storage.onChanged.addListener(loadCurrent);
loadCurrent();
