from __future__ import annotations

import json
import os
import re

from format_transcript import format_clock, segments_to_blocks

STUDY_MODEL = os.getenv("CLEAN_MODEL", "gpt-4o-mini")

MCQ_PER_TIER = {
    "high": (5, 8),
    "medium": (2, 3),
    "low": (0, 1),
}
FLASHCARDS_PER_TIER = {
    "high": (4, 6),
    "medium": (1, 2),
    "low": (0, 1),
}
MAX_MCQS = 40
MAX_FLASHCARDS = 40
MIN_MCQS = 1
MIN_FLASHCARDS = 1

TIER_EMOJI = {"high": "🔥", "medium": "🟡", "low": "⚪"}


def _clock_link(seconds: float) -> str:
    clock = format_clock(seconds)
    return f"[{clock}](#)"


def _parse_timestamp(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    match = re.match(r"^(\d{1,2}):(\d{2}):(\d{2})$", text)
    if match:
        h, m, s = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
        return h * 3600 + m * 60 + s
    try:
        return float(text)
    except ValueError:
        return None


def _quota(importance: list[dict], per_tier: dict[str, tuple[int, int]], cap: int, minimum: int) -> int:
    total = 0
    for item in importance:
        lo, hi = per_tier.get(item.get("tier") or "low", (0, 1))
        total += hi if item.get("tier") == "high" else (lo + hi) // 2
    total = max(minimum, min(cap, total))
    return total


def build_context(clean_markdown: str, blocks: list[dict], importance: list[dict]) -> str:
    by_idx = {item["block_index"]: item for item in importance}
    parts = ["# Clean transcript\n", clean_markdown.strip(), "\n\n# Topic blocks with importance\n"]
    for block in blocks:
        item = by_idx.get(block["block_index"], {})
        tier = item.get("tier") or "low"
        emoji = TIER_EMOJI.get(tier, "⚪")
        clock = format_clock(block["start"])
        reasons = "; ".join(item.get("reasons") or [])
        parts.append(
            f"\n## {emoji} block {block['block_index']} score={item.get('score', 0)} "
            f"{_clock_link(block['start'])}\n{block['text']}\n"
            f"(reasons: {reasons})\n"
        )
    return "".join(parts)


def _extract_json(raw: str):
    text = (raw or "").strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    return json.loads(text)


def _llm(system: str, user: str, *, json_mode: bool) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    kwargs = {
        "model": STUDY_MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    response = client.chat.completions.create(**kwargs)
    return (response.choices[0].message.content or "").strip()


def _llm_json(system: str, user: str, validator):
    last_error = None
    for _ in range(2):
        try:
            raw = _llm(system, user, json_mode=True)
            data = _extract_json(raw)
            return validator(data)
        except Exception as exc:
            last_error = exc
            user = user + f"\n\nPrevious output was invalid ({exc}). Return valid JSON only."
    raise RuntimeError(f"JSON validation failed: {last_error}")


def validate_mcqs(data) -> list[dict]:
    rows = data.get("mcqs") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise ValueError("expected a non-empty mcqs list")
    out = []
    for item in rows:
        options = item.get("options")
        if not isinstance(options, list) or len(options) != 4:
            raise ValueError("each MCQ needs exactly 4 options")
        idx = int(item.get("correct_index"))
        if idx < 0 or idx > 3:
            raise ValueError("correct_index must be 0-3")
        ts = _parse_timestamp(item.get("source_timestamp"))
        if ts is None:
            raise ValueError("source_timestamp missing")
        question = str(item.get("question") or "").strip()
        if not question:
            raise ValueError("question empty")
        out.append(
            {
                "question": question,
                "options": [str(o) for o in options],
                "correct_index": idx,
                "explanation": str(item.get("explanation") or "").strip(),
                "source_timestamp": ts,
            }
        )
    return out


def validate_flashcards(data) -> list[dict]:
    rows = data.get("flashcards") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise ValueError("expected a non-empty flashcards list")
    out = []
    for item in rows:
        front = str(item.get("front") or "").strip()
        back = str(item.get("back") or "").strip()
        if not front or not back:
            raise ValueError("flashcard missing front/back")
        tier = str(item.get("tier") or "medium").lower()
        if tier not in TIER_EMOJI:
            tier = "medium"
        ts = _parse_timestamp(item.get("source_timestamp"))
        if ts is None:
            raise ValueError("source_timestamp missing")
        out.append(
            {
                "front": front,
                "back": back,
                "tier": tier,
                "source_timestamp": ts,
            }
        )
    return out


def fallback_notes(blocks: list[dict], importance: list[dict]) -> str:
    by_idx = {item["block_index"]: item for item in importance}
    lines = ["# Lecture notes\n"]
    for block in blocks:
        item = by_idx.get(block["block_index"], {})
        tier = item.get("tier") or "low"
        emoji = TIER_EMOJI[tier]
        clock = format_clock(block["start"])
        heading = f"{emoji} " if tier == "high" else ""
        lines.append(f"## {heading}{clock}\n")
        lines.append(f"{_clock_link(block['start'])}\n")
        lines.append(f"{block['text']}\n")
    return "\n".join(lines)


def fallback_mcqs(blocks: list[dict], importance: list[dict]) -> list[dict]:
    by_idx = {item["block_index"]: item for item in importance}
    out = []
    for block in blocks:
        item = by_idx.get(block["block_index"], {})
        if item.get("tier") == "low" and out:
            continue
        snippet = block["text"][:80]
        out.append(
            {
                "question": f"What was discussed around {format_clock(block['start'])}?",
                "options": [
                    snippet or "Core concept from this block",
                    "Attendance and classroom logistics only",
                    "Unrelated historical anecdote",
                    "None of the above",
                ],
                "correct_index": 0,
                "explanation": "Drawn from the lecture block at this timestamp.",
                "source_timestamp": float(block["start"]),
            }
        )
        if len(out) >= max(MIN_MCQS, 3):
            break
    return out or [
        {
            "question": "What is this lecture mainly about?",
            "options": ["The recorded topic", "Sports scores", "Weather", "None"],
            "correct_index": 0,
            "explanation": "Fallback question from the transcript.",
            "source_timestamp": 0.0,
        }
    ]


def fallback_flashcards(blocks: list[dict], importance: list[dict]) -> list[dict]:
    by_idx = {item["block_index"]: item for item in importance}
    cards = []
    for block in blocks:
        item = by_idx.get(block["block_index"], {})
        tier = item.get("tier") or "low"
        if tier == "low" and cards:
            continue
        sentence = re.split(r"(?<=[.!?])\s+", block["text"].strip())[0]
        cards.append(
            {
                "front": sentence[:140] or f"Point at {format_clock(block['start'])}",
                "back": block["text"][:400],
                "tier": tier,
                "source_timestamp": float(block["start"]),
            }
        )
    return cards[:MAX_FLASHCARDS]


def fallback_revision(blocks: list[dict], importance: list[dict]) -> str:
    by_idx = {item["block_index"]: item for item in importance}
    lines = ["# 10-minute revision\n", "_Low-importance material omitted._\n"]
    for block in blocks:
        item = by_idx.get(block["block_index"], {})
        if item.get("tier") not in {"high", "medium"}:
            continue
        emoji = TIER_EMOJI[item["tier"]]
        lines.append(f"- {emoji} {_clock_link(block['start'])}: {block['text'][:280]}\n")
    if len(lines) == 2:
        lines.append("- No 🔥/🟡 blocks; review the notes for the main thread.\n")
    return "\n".join(lines)


def generate_notes(context: str, blocks: list[dict], importance: list[dict]) -> str:
    system = (
        "You write concise lecture notes in Markdown. "
        "Organize by the given topic blocks. Prefix 🔥 high-importance headings. "
        "Include a timestamp link of the form [HH:MM:SS](#) for each section. "
        "Do not invent content."
    )
    user = f"Write notes from this lecture context.\n\n{context}"
    try:
        return _llm(system, user, json_mode=False)
    except Exception:
        return fallback_notes(blocks, importance)


def generate_mcqs(context: str, blocks: list[dict], importance: list[dict]) -> list[dict]:
    n = _quota(importance, MCQ_PER_TIER, MAX_MCQS, MIN_MCQS)
    system = (
        "You write multiple-choice questions. Return JSON only: "
        '{"mcqs":[{"question":str,"options":[str,str,str,str],"correct_index":int,'
        '"explanation":str,"source_timestamp":number}]}. '
        "correct_index is 0-3. source_timestamp is seconds from lecture start."
    )
    user = (
        f"Create about {n} MCQs. Allocate more to 🔥 high blocks "
        f"(target {MCQ_PER_TIER['high'][0]}-{MCQ_PER_TIER['high'][1]} per high block), "
        f"{MCQ_PER_TIER['medium'][0]}-{MCQ_PER_TIER['medium'][1]} per medium block, "
        f"{MCQ_PER_TIER['low'][0]}-{MCQ_PER_TIER['low'][1]} per low block.\n\n{context}"
    )
    try:
        return _llm_json(system, user, validate_mcqs)
    except Exception:
        return fallback_mcqs(blocks, importance)


def generate_flashcards(context: str, blocks: list[dict], importance: list[dict]) -> list[dict]:
    n = _quota(importance, FLASHCARDS_PER_TIER, MAX_FLASHCARDS, MIN_FLASHCARDS)
    system = (
        "You write study flashcards. Return JSON only: "
        '{"flashcards":[{"front":str,"back":str,"tier":"high"|"medium"|"low",'
        '"source_timestamp":number}]}. Weight toward high-importance blocks.'
    )
    user = f"Create about {n} flashcards from this lecture.\n\n{context}"
    try:
        return _llm_json(system, user, validate_flashcards)
    except Exception:
        return fallback_flashcards(blocks, importance)


def generate_revision(context: str, blocks: list[dict], importance: list[dict]) -> str:
    system = (
        "You write a 10-minute revision summary in Markdown. "
        "Cover only 🔥 high and 🟡 medium content. Explicitly skip ⚪ low material. "
        "Use [HH:MM:SS](#) timestamp links."
    )
    user = f"Write the revision summary.\n\n{context}"
    try:
        return _llm(system, user, json_mode=False)
    except Exception:
        return fallback_revision(blocks, importance)


def generate_study_pack(
    segments: list[dict],
    clean_markdown: str,
    importance: list[dict],
    on_stage=None,
) -> dict:
    blocks = segments_to_blocks(segments)
    context = build_context(clean_markdown, blocks, importance)
    pack = {"notes": None, "mcqs": None, "flashcards": None, "revision": None, "errors": {}}

    def run(name, fn):
        if on_stage:
            on_stage(name, "processing")
        try:
            pack[name] = fn()
            if on_stage:
                on_stage(name, "done")
        except Exception as exc:
            pack["errors"][name] = str(exc)
            if on_stage:
                on_stage(name, "error")

    run("notes", lambda: generate_notes(context, blocks, importance))
    run("mcqs", lambda: generate_mcqs(context, blocks, importance))
    run("flashcards", lambda: generate_flashcards(context, blocks, importance))
    run("revision", lambda: generate_revision(context, blocks, importance))
    return pack
