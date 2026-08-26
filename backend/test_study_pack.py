#!/usr/bin/env python3
"""Full pipeline on the Phase 3 sample: transcribe → importance → study pack.

  cd backend
  source .venv/bin/activate
  python test_study_pack.py
  python test_study_pack.py /path/to/file.webm
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from format_transcript import clean_transcript, segments_to_markdown
from importance import score_transcript
from pipeline import PipelineError, transcribe_webm
from study_pack import generate_study_pack

load_dotenv(Path(__file__).resolve().parent / ".env")

ROOT = Path(__file__).resolve().parent
DEFAULT_SAMPLE = ROOT / "sample.webm"


def main() -> int:
    webm = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else DEFAULT_SAMPLE
    if not webm.exists():
        print(f"Missing sample file: {webm}", file=sys.stderr)
        return 2

    print(f"1/3 Transcribing {webm} …")
    try:
        segments = transcribe_webm(webm)
    except PipelineError as exc:
        print(f"Pipeline error: {exc}", file=sys.stderr)
        return 1

    raw_md = segments_to_markdown(segments)
    clean_md, clean_error = clean_transcript(raw_md)
    if clean_error:
        print(f"(clean fallback: {clean_error[:120]})")

    print("2/3 Scoring importance …")
    importance = score_transcript(segments, clean_md)
    print("   tiers:", {t: sum(1 for i in importance if i["tier"] == t) for t in ("high", "medium", "low")})

    print("3/3 Generating study pack …")
    pack = generate_study_pack(segments, clean_md, importance)

    print("\n===== NOTES =====\n")
    print(pack.get("notes") or "")
    print("\n===== MCQs =====\n")
    print(json.dumps(pack.get("mcqs"), indent=2))
    print("\n===== FLASHCARDS =====\n")
    print(json.dumps(pack.get("flashcards"), indent=2))
    print("\n===== 10-MINUTE REVISION =====\n")
    print(pack.get("revision") or "")
    if pack.get("errors"):
        print("\n(stage errors / fallbacks)", pack["errors"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
