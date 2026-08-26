from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

from faster_whisper import WhisperModel

from format_transcript import (
    clean_transcript,
    markdown_to_text,
    segments_to_markdown,
)
from importance import score_transcript
from study_pack import generate_study_pack

AUDIO_BITRATE = "16k"

_model: WhisperModel | None = None


class PipelineError(Exception):
    pass


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise PipelineError(
            f"Required binary not found: {cmd[0]}. Install ffmpeg/ffprobe."
        ) from exc
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or exc.stdout or str(exc)).strip()
        raise PipelineError(f"Command failed ({cmd[0]}): {err[-2000:]}") from exc


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        name = os.getenv("WHISPER_MODEL", "small")
        device = os.getenv("WHISPER_DEVICE", "cpu")
        compute = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        try:
            _model = WhisperModel(name, device=device, compute_type=compute)
        except Exception as exc:
            raise PipelineError(f"Failed to load faster-whisper model '{name}': {exc}") from exc
    return _model


def extract_audio(webm_path: Path, work_dir: Path) -> Path:
    """16 kHz mono WAV — local Whisper does not need a compressed upload."""
    out = work_dir / "audio.wav"
    _run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(webm_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(out),
        ]
    )
    if not out.exists() or out.stat().st_size == 0:
        raise PipelineError("ffmpeg produced an empty audio file")
    return out


def transcribe_audio(audio_path: Path) -> list[dict]:
    model = get_model()
    segments_iter, _info = model.transcribe(
        str(audio_path),
        vad_filter=True,
        word_timestamps=False,
    )
    segments: list[dict] = []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": text,
            }
        )
    return segments


def transcribe_webm(webm_path: str | Path, work_dir: str | Path | None = None) -> list[dict]:
    webm_path = Path(webm_path)
    if not webm_path.exists():
        raise PipelineError(f"Input file not found: {webm_path}")

    work = Path(work_dir) if work_dir else webm_path.parent / f"work_{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)

    try:
        audio = extract_audio(webm_path, work)
    except Exception as exc:
        raise PipelineError(f"Audio extraction failed: {exc}") from exc

    try:
        return transcribe_audio(audio)
    except PipelineError:
        raise
    except Exception as exc:
        raise PipelineError(f"faster-whisper transcription failed: {exc}") from exc


def _init_stages() -> dict:
    return {
        "transcript": "pending",
        "importance": "pending",
        "notes": "pending",
        "mcqs": "pending",
        "flashcards": "pending",
        "revision": "pending",
    }


def run_job(job_id: str, webm_path: str, jobs: dict) -> None:
    try:
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["error"] = None
        jobs[job_id]["stages"] = _init_stages()
        work_dir = Path(webm_path).parent / "work"

        jobs[job_id]["stages"]["transcript"] = "processing"
        segments = transcribe_webm(webm_path, work_dir=work_dir)
        raw_md = segments_to_markdown(segments)
        raw_txt = markdown_to_text(raw_md)
        clean_md, clean_error = clean_transcript(raw_md)
        jobs[job_id]["transcript"] = segments
        jobs[job_id]["raw"] = {
            "segments": segments,
            "markdown": raw_md,
            "text": raw_txt,
        }
        jobs[job_id]["clean"] = {
            "markdown": clean_md,
            "text": markdown_to_text(clean_md),
        }
        jobs[job_id]["cleanError"] = clean_error
        jobs[job_id]["stages"]["transcript"] = "done"

        jobs[job_id]["stages"]["importance"] = "processing"
        try:
            jobs[job_id]["importance"] = score_transcript(segments, clean_md)
            jobs[job_id]["importanceError"] = None
            jobs[job_id]["stages"]["importance"] = "done"
        except Exception as exc:
            jobs[job_id]["importance"] = []
            jobs[job_id]["importanceError"] = str(exc)
            jobs[job_id]["stages"]["importance"] = "error"

        def on_stage(name: str, state: str) -> None:
            jobs[job_id]["stages"][name] = state

        pack = generate_study_pack(
            segments,
            clean_md,
            jobs[job_id]["importance"] or [],
            on_stage=on_stage,
        )
        jobs[job_id]["notes"] = pack.get("notes")
        jobs[job_id]["mcqs"] = pack.get("mcqs")
        jobs[job_id]["flashcards"] = pack.get("flashcards")
        jobs[job_id]["revision"] = pack.get("revision")
        jobs[job_id]["studyPackError"] = pack.get("errors") or None
        jobs[job_id]["status"] = "done"
    except Exception as exc:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)
        jobs[job_id]["transcript"] = None
