#!/usr/bin/env python3
"""Score topic blocks from the Phase 3 sample transcript.

  cd backend
  source .venv/bin/activate
  python test_importance.py
  python test_importance.py /path/to/segments.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from format_transcript import segments_to_blocks
from importance import WEIGHTS, score_transcript

load_dotenv(Path(__file__).resolve().parent / ".env")

# Exact segments printed by Phase 3 `test_pipeline.py sample.webm`.
PHASE3_SAMPLE_SEGMENTS = [
    {
        "start": 0.0,
        "end": 3.08,
        "text": "This is a test lecture about data structures.",
    },
    {
        "start": 3.08,
        "end": 6.88,
        "text": "Today, we will discuss binary trees, hash maps, and recursion.",
    },
]

# Extra blocks so cue / repetition / duration signals are visible.
SANITY_SEGMENTS = [
    {
        "start": 20.0,
        "end": 26.0,
        "text": "A binary tree is a hierarchical data structure where each node has at most two children.",
    },
    {
        "start": 40.0,
        "end": 48.0,
        "text": "Remember this definition: a hash map stores key value pairs and gives expected constant time lookup.",
    },
    {
        "start": 70.0,
        "end": 95.0,
        "text": (
            "This is key for the exam. Make sure you can implement hash maps and "
            "trace collisions. You should know the load factor formula."
        ),
    },
    {
        "start": 120.0,
        "end": 128.0,
        "text": "By the way the classroom wifi was down yesterday so we will skip attendance.",
    },
    {
        "start": 160.0,
        "end": 168.0,
        "text": "A binary tree is a hierarchical data structure and each node has at most two children, as we said.",
    },
    {
        "start": 200.0,
        "end": 208.0,
        "text": "Hash maps again: key value pairs with expected constant time lookup. This is important.",
    },
]


def load_segments(path: Path | None) -> list[dict]:
    if path:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and "transcript" in data:
            return data["transcript"]
        if isinstance(data, dict) and "segments" in data:
            return data["segments"]
        return data
    return PHASE3_SAMPLE_SEGMENTS + SANITY_SEGMENTS


def main() -> int:
    path = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else None
    segments = load_segments(path)
    print(f"Weights: {WEIGHTS}")
    print(f"Segments: {len(segments)}")
    blocks = segments_to_blocks(segments)
    print(f"Topic blocks: {len(blocks)}\n")

    ranked = score_transcript(segments)
    by_tier: dict[str, list[dict]] = {"high": [], "medium": [], "low": []}
    for item in ranked:
        by_tier[item["tier"]].append(item)

    for tier in ("high", "medium", "low"):
        rows = by_tier[tier]
        emoji = {"high": "🔥", "medium": "🟡", "low": "⚪"}[tier]
        print(f"{emoji} {tier.upper()} ({len(rows)})")
        for item in rows:
            preview = blocks[item["block_index"]]["text"][:90].replace("\n", " ")
            print(
                f"  [{item['block_index']:>2}] t={item['start']:7.1f}s  "
                f"score={item['score']:.3f}  {preview}"
            )
            for reason in item["reasons"]:
                print(f"       - {reason}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
