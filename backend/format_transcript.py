from __future__ import annotations

import re

GAP_SECONDS = 3.0
MAX_WORDS = 150
FILLER_RE = re.compile(
    r"(?:^|\s)(?:um+|uh+|er+|ah+|hmm+)(?:[,\.]?)(?=\s|$)",
    re.IGNORECASE,
)
FALSE_START_RE = re.compile(r"\b(\w+)(?:\s+\1){1,3}\b", re.IGNORECASE)

CLEAN_SYSTEM = """You clean lecture transcripts for later study and for LLM use.
Remove filler words (um, uh, er, ah, hmm), false starts, and obvious ASR errors.
Do not summarize, do not add facts, and do not drop real content.
Keep every "## HH:MM:SS" heading in the same order.

When the speaker dictates mathematics, rewrite it as LaTeX — not spoken English.
Use \\( ... \\) for inline math and \\[ ... \\] for displayed equations.
Examples: "x squared plus 1 over n" → \\( x^{2} + 1/n \\);
"integral from 0 to 1 of f of x dx" → \\( \\int_{0}^{1} f(x)\\,dx \\);
"sigma from i equals 1 to n" → \\( \\sum_{i=1}^{n} \\).
Leave ordinary English prose as English. If you are unsure of a symbol, keep the words.

Return only the cleaned Markdown."""


def format_clock(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def srt_timestamp(seconds: float) -> str:
    ms_total = max(0, int(round(float(seconds) * 1000)))
    h, rem = divmod(ms_total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _word_count(text: str) -> int:
    return len(text.split())


def group_segments(segments: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    words = 0
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if current:
            gap = float(seg["start"]) - float(current[-1]["end"])
            next_words = _word_count(text)
            if gap > GAP_SECONDS or words + next_words > MAX_WORDS:
                groups.append(current)
                current = []
                words = 0
        current.append(seg)
        words += _word_count(text)
    if current:
        groups.append(current)
    return groups


def segments_to_blocks(segments: list[dict]) -> list[dict]:
    """Collapse Whisper segments into paragraph topic blocks."""
    blocks: list[dict] = []
    for i, group in enumerate(group_segments(segments)):
        text = " ".join((s.get("text") or "").strip() for s in group).strip()
        if not text:
            continue
        blocks.append(
            {
                "block_index": i,
                "start": float(group[0]["start"]),
                "end": float(group[-1]["end"]),
                "text": text,
            }
        )
    return blocks


def segments_to_markdown(segments: list[dict]) -> str:
    blocks: list[str] = []
    for group in group_segments(segments):
        header = format_clock(float(group[0]["start"]))
        body = " ".join((s.get("text") or "").strip() for s in group).strip()
        if body:
            blocks.append(f"## {header}\n\n{body}")
    return "\n\n".join(blocks)


def markdown_to_text(markdown: str) -> str:
    parts: list[str] = []
    for block in re.split(r"\n(?=## )", markdown.strip()):
        block = block.strip()
        if not block:
            continue
        match = re.match(r"^##\s+(\d{2}:\d{2}:\d{2})\s*\n*", block)
        if match:
            rest = block[match.end() :].strip()
            parts.append(f"[{match.group(1)}]\n{rest}")
        else:
            parts.append(block)
    return "\n\n".join(parts)


def segments_to_srt(segments: list[dict]) -> str:
    lines: list[str] = []
    index = 1
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = srt_timestamp(seg["start"])
        end = srt_timestamp(seg["end"])
        lines.append(f"{index}\n{start} --> {end}\n{text}\n")
        index += 1
    return "\n".join(lines).strip() + ("\n" if lines else "")


def heuristic_clean(markdown: str) -> str:
    cleaned_blocks: list[str] = []
    for block in re.split(r"\n(?=## )", markdown.strip()):
        block = block.strip()
        match = re.match(r"^(##\s+\d{2}:\d{2}:\d{2})\s*", block)
        if not match:
            cleaned_blocks.append(block)
            continue
        header = match.group(1)
        body = block[match.end() :].strip()
        body = FILLER_RE.sub(" ", body)
        body = FALSE_START_RE.sub(r"\1", body)
        body = re.sub(r"\s{2,}", " ", body).strip()
        cleaned_blocks.append(f"{header}\n\n{body}" if body else header)
    return "\n\n".join(cleaned_blocks)


def _split_markdown_chunks(markdown: str, max_chars: int = 8000) -> list[str]:
    blocks = re.split(r"\n(?=## )", markdown.strip())
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        if current and size + len(block) > max_chars:
            chunks.append("\n\n".join(current))
            current = []
            size = 0
        current.append(block)
        size += len(block)
    if current:
        chunks.append("\n\n".join(current))
    return chunks or [markdown]


def llm_clean(markdown: str) -> str:
    from llm_client import chat_complete

    cleaned_parts: list[str] = []
    for chunk in _split_markdown_chunks(markdown):
        text = chat_complete(
            [
                {"role": "system", "content": CLEAN_SYSTEM},
                {"role": "user", "content": chunk},
            ],
            temperature=0,
        )
        if text:
            cleaned_parts.append(text)
    result = "\n\n".join(cleaned_parts).strip()
    if not result:
        raise RuntimeError("LLM returned an empty clean transcript")
    return result


def clean_transcript(markdown: str) -> tuple[str, str | None]:
    """Return (cleaned_markdown, error_message_if_fell_back)."""
    if not markdown.strip():
        return markdown, None
    try:
        return llm_clean(markdown), None
    except Exception as exc:
        return heuristic_clean(markdown), str(exc)
