from __future__ import annotations

import re
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from format_transcript import segments_to_srt
from pipeline import load_jobs, persist_job, run_job, run_study_from_transcript

load_dotenv()

ROOT = Path(__file__).resolve().parent
UPLOAD_ROOT = ROOT / "uploads"
UPLOAD_ROOT.mkdir(exist_ok=True)

jobs: dict[str, dict] = load_jobs()

app = FastAPI(title="Lecture transcripts")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value or "lecture").strip("_")
    return cleaned[:80] or "lecture"


@app.post("/upload")
async def upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    lectureId: str = Form(...),
    kind: str = Form(...),
):
    job_id = str(uuid.uuid4())
    job_dir = UPLOAD_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    dest = job_dir / f"input{suffix}"
    dest.write_bytes(await file.read())

    jobs[job_id] = {
        "status": "processing",
        "transcript": None,
        "raw": None,
        "clean": None,
        "cleanError": None,
        "importance": None,
        "importanceError": None,
        "notes": None,
        "mcqs": None,
        "flashcards": None,
        "revision": None,
        "studyPackError": None,
        "stages": {
            "transcript": "pending",
            "importance": "pending",
            "notes": "pending",
            "mcqs": "pending",
            "flashcards": "pending",
            "revision": "pending",
        },
        "error": None,
        "lectureId": lectureId,
        "kind": kind,
    }
    background_tasks.add_task(run_job, job_id, str(dest), jobs)
    persist_job(job_id, jobs)
    return {"jobId": job_id}


@app.post("/from-transcript")
async def from_transcript(background_tasks: BackgroundTasks, body: dict = Body(...)):
    lecture_id = str(body.get("lectureId") or "lecture")
    segments = body.get("segments") or (body.get("raw") or {}).get("segments")
    if not isinstance(segments, list) or not segments:
        raise HTTPException(status_code=400, detail="segments required")
    clean = body.get("clean") or {}
    clean_md = clean.get("markdown") or body.get("cleanMarkdown") or ""
    raw = body.get("raw") if isinstance(body.get("raw"), dict) else None
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "processing",
        "transcript": segments,
        "raw": raw,
        "clean": clean if clean else None,
        "cleanError": None,
        "importance": None,
        "importanceError": None,
        "notes": None,
        "mcqs": None,
        "flashcards": None,
        "revision": None,
        "studyPackError": None,
        "stages": {
            "transcript": "done",
            "importance": "pending",
            "notes": "pending",
            "mcqs": "pending",
            "flashcards": "pending",
            "revision": "pending",
        },
        "error": None,
        "lectureId": lecture_id,
        "kind": "transcript",
    }
    persist_job(job_id, jobs)
    background_tasks.add_task(run_study_from_transcript, job_id, segments, clean_md, jobs)
    return {"jobId": job_id}


@app.get("/status/{job_id}")
def status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown jobId")

    body: dict = {"status": job["status"]}
    if job.get("transcript") is not None:
        body["transcript"] = job["transcript"]
    if job.get("raw") is not None:
        body["raw"] = job["raw"]
    if job.get("clean") is not None:
        body["clean"] = job["clean"]
    if job.get("cleanError"):
        body["cleanError"] = job["cleanError"]
    if job.get("importance") is not None:
        body["importance"] = job["importance"]
    if job.get("importanceError"):
        body["importanceError"] = job["importanceError"]
    if job.get("stages") is not None:
        body["stages"] = job["stages"]
    if job.get("notes") is not None:
        body["notes"] = job["notes"]
    if job.get("mcqs") is not None:
        body["mcqs"] = job["mcqs"]
    if job.get("flashcards") is not None:
        body["flashcards"] = job["flashcards"]
    if job.get("revision") is not None:
        body["revision"] = job["revision"]
    if job.get("studyPackError"):
        body["studyPackError"] = job["studyPackError"]
    if job.get("error"):
        body["error"] = job["error"]
    return body


@app.get("/export/{job_id}")
def export_transcript(job_id: str, format: str = "md", version: str = "clean"):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown jobId")
    if job.get("status") != "done":
        raise HTTPException(status_code=409, detail="Job is not done")

    fmt = format.lower().strip()
    ver = version.lower().strip()
    if fmt not in {"txt", "md", "srt"}:
        raise HTTPException(status_code=400, detail="format must be txt, md, or srt")
    if ver not in {"raw", "clean"}:
        raise HTTPException(status_code=400, detail="version must be raw or clean")

    lecture = _safe_name(str(job.get("lectureId") or job_id))

    if fmt == "srt":
        segments = (job.get("raw") or {}).get("segments") or job.get("transcript") or []
        body = segments_to_srt(segments)
        filename = f"{lecture}.srt"
        media = "application/x-subrip"
    else:
        bundle = job.get(ver) or job.get("raw") or {}
        if fmt == "md":
            body = bundle.get("markdown") or ""
            filename = f"{lecture}-{ver}.md"
            media = "text/markdown; charset=utf-8"
        else:
            body = bundle.get("text") or ""
            filename = f"{lecture}-{ver}.txt"
            media = "text/plain; charset=utf-8"

    return PlainTextResponse(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
