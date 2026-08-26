const TRANSCRIPT_DB = "codetantra-transcripts";
const TRANSCRIPT_STORE = "transcripts";

function openTranscriptDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TRANSCRIPT_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRANSCRIPT_STORE)) {
        db.createObjectStore(TRANSCRIPT_STORE, { keyPath: "lectureId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLectureTranscript(record) {
  const db = await openTranscriptDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, "readwrite");
    tx.objectStore(TRANSCRIPT_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadLectureTranscript(lectureId) {
  if (!lectureId) return null;
  const db = await openTranscriptDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, "readonly");
    const req = tx.objectStore(TRANSCRIPT_STORE).get(lectureId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function listLectureTranscripts() {
  const db = await openTranscriptDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSCRIPT_STORE, "readonly");
    const req = tx.objectStore(TRANSCRIPT_STORE).getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

async function mergeLectureRecord(lectureId, patch) {
  const prev = (await loadLectureTranscript(lectureId)) || { lectureId };
  const next = { ...prev, lectureId, savedAt: Date.now() };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) next[key] = value;
  }
  await saveLectureTranscript(next);
  return next;
}
