#!/usr/bin/env python3
"""Run the transcription pipeline on a local .webm file (no HTTP server).

  cd backend
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  python test_pipeline.py /path/to/webcams.webm
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from pipeline import PipelineError, transcribe_webm

load_dotenv(Path(__file__).resolve().parent / ".env")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python test_pipeline.py /path/to/file.webm", file=sys.stderr)
        return 2

    webm = Path(sys.argv[1]).expanduser().resolve()
    print(f"Transcribing {webm} …")
    try:
        segments = transcribe_webm(webm)
    except PipelineError as exc:
        print(f"Pipeline error: {exc}", file=sys.stderr)
        return 1

    print(f"\n{len(segments)} segments:\n")
    for seg in segments:
        print(f"[{seg['start']:8.2f} -> {seg['end']:8.2f}] {seg['text']}")
    print("\nJSON:")
    print(json.dumps(segments, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
