# Transkriptor

Chrome extension plus local API that turns **CodeTantra** lecture webcam audio into a study pack: transcript, notes, MCQs, flashcards, and a 10-minute revision sheet.

Works on `*.codetantra.com` lecture pages. The toolbar icon opens a **side panel** (not a popup).

## How it works

1. A content script finds the lecture `webcams.webm` URL (the player often lives in a cross-origin iframe).
2. Authenticated fetch + upload run from that iframe so the HTTPS lecture page does not have to POST to `http://127.0.0.1`.
3. The FastAPI backend converts audio with **ffmpeg**, transcribes with **faster-whisper**, then scores importance and builds the study pack.
4. The side panel polls job status and stores results in IndexedDB so you can reopen previous lectures.

If Gemini is missing or returns quota errors, cleaning and study-pack steps fall back to local heuristics.

## Requirements

- Google Chrome (Manifest V3)
- Python 3.11+ (3.14 is fine)
- [ffmpeg](https://ffmpeg.org/) on your `PATH` (`brew install ffmpeg` on macOS)
- Optional: `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) for better cleanup, notes, MCQs, and flashcards

## Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env`:

```
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
CLEAN_MODEL=gemini-2.5-flash
GEMINI_API_KEY=          # optional, from Google AI Studio
```

First Whisper / sentence-transformers downloads can take a few minutes.

Start the API and **leave it running** while you use the extension:

```bash
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8000
```

Jobs live in memory. Restarting uvicorn drops in-progress and finished jobs (the extension still keeps copies in IndexedDB).

## Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this repository root (the folder that contains `manifest.json`)
4. Pin **Transcripts for CodeTantra Lectures**

The extension talks to `http://127.0.0.1:8000` (`config.js`). Reload the extension after you pull code changes, then refresh the lecture tab.

## Usage

1. Start the backend.
2. Open a CodeTantra lecture and wait until video is playing (webcam media detected).
3. Click **Generate Study Pack** on the player (bottom-right), or open the side panel from the toolbar and use **Generate study pack**.
4. Keep that lecture tab open while audio uploads and transcribes. Long lectures can take a while on CPU (`small` model).
5. Use the side panel tabs: Transcript, Notes, MCQs, Flashcards, Revision. Export `.txt` / `.md` / `.srt` / PDF when ready.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Multipart `file`, `lectureId`, `kind` → `{ "jobId" }` |
| `GET` | `/status/{jobId}` | Transcript, stages, study-pack fields |
| `GET` | `/export/{jobId}?format=txt\|md\|srt` | Downloadable export |

## Tests

```bash
cd backend
source .venv/bin/activate
python -m unittest test_pipeline test_importance test_study_pack
```

`backend/sample.webm` is a small fixture for pipeline tests.

## Repo layout

```
manifest.json          Chrome MV3 manifest
content.js             Detect media, FAB, iframe upload
background.js          Job orchestration, side panel, downloads
sidepanel.*            Study pack UI
idb.js                 IndexedDB lecture store
config.js              Backend URL
backend/app.py        FastAPI
backend/pipeline.py   ffmpeg + Whisper
backend/study_pack.py Notes / MCQs / flashcards / revision
```

`.env`, `.venv`, and uploaded lecture files are gitignored. Do not commit API keys.
