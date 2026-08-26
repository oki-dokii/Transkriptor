from __future__ import annotations

import json
import os
import re
from statistics import median

import numpy as np

from format_transcript import format_clock, segments_to_blocks

WEIGHTS = {
    "explicit": 0.25,
    "repetition": 0.25,
    "duration": 0.20,
    "semantic": 0.30,
}

TIER_THRESHOLDS = {
    "high": 0.60,
    "medium": 0.33,
}

REPETITION_SIMILARITY = 0.72
EMBED_MODEL = os.getenv("EMBED_MODEL", "all-MiniLM-L6-v2")

EXPLICIT_CUES = [
    "important",
    "remember this",
    "remember that",
    "exam",
    "you should know",
    "make sure you",
    "this is key",
    "this is critical",
    "don't forget",
    "must know",
    "very important",
    "pay attention",
    "write this down",
    "this will be on",
]

SEMANTIC_HIGH_CUES = [
    "definition",
    "defined as",
    "theorem",
    "lemma",
    "formula",
    "equation",
    "proof",
    "corollary",
    "axiom",
    "algorithm",
]

_embedder = None


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def score_explicit_cues(text: str) -> tuple[float, list[str]]:
    lowered = text.lower()
    hits = [cue for cue in EXPLICIT_CUES if cue in lowered]
    if not hits:
        return 0.0, []
    score = _clip01(len(hits) / 2.0)
    return score, [f"explicit cue: “{cue}”" for cue in hits]


def _token_vectors(texts: list[str]) -> np.ndarray:
    vocab: dict[str, int] = {}
    tokenized: list[list[str]] = []
    for text in texts:
        toks = re.findall(r"[a-z0-9]+", text.lower())
        tokenized.append(toks)
        for tok in toks:
            if tok not in vocab:
                vocab[tok] = len(vocab)
    if not vocab:
        return np.zeros((len(texts), 1), dtype=np.float32)
    mat = np.zeros((len(texts), len(vocab)), dtype=np.float32)
    for i, toks in enumerate(tokenized):
        for tok in toks:
            mat[i, vocab[tok]] += 1.0
        norm = np.linalg.norm(mat[i])
        if norm:
            mat[i] /= norm
    return mat


def _st_vectors(texts: list[str]) -> np.ndarray:
    global _embedder
    from sentence_transformers import SentenceTransformer

    if _embedder is None:
        _embedder = SentenceTransformer(EMBED_MODEL)
    vectors = _embedder.encode(texts, normalize_embeddings=True)
    return np.asarray(vectors, dtype=np.float32)


def embed_texts(texts: list[str]) -> np.ndarray:
    try:
        return _st_vectors(texts)
    except Exception:
        return _token_vectors(texts)


def score_repetition(texts: list[str]) -> list[tuple[float, list[str]]]:
    n = len(texts)
    if n <= 1:
        return [(0.0, []) for _ in texts]
    vectors = embed_texts(texts)
    sims = vectors @ vectors.T
    results: list[tuple[float, list[str]]] = []
    for i in range(n):
        matches = [
            j
            for j in range(n)
            if j != i and float(sims[i, j]) >= REPETITION_SIMILARITY
        ]
        score = _clip01(len(matches) / 2.0)
        reasons = []
        if matches:
            reasons.append(
                f"repeated vs {len(matches)} other block(s) "
                f"(sim ≥ {REPETITION_SIMILARITY})"
            )
        results.append((score, reasons))
    return results


def score_duration(durations: list[float]) -> list[tuple[float, list[str]]]:
    if not durations:
        return []
    med = median(durations) or 1.0
    results: list[tuple[float, list[str]]] = []
    for dur in durations:
        score = _clip01(dur / (2.0 * med))
        reasons = []
        if dur > med * 1.05:
            reasons.append(f"duration {dur:.1f}s vs median {med:.1f}s")
        results.append((score, reasons))
    return results


def _parse_semantic_json(raw: str) -> list[dict]:
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    return json.loads(text)


def _semantic_fallback(texts: list[str]) -> list[tuple[float, str, str]]:
    out: list[tuple[float, str, str]] = []
    for text in texts:
        lowered = text.lower()
        hits = [c for c in SEMANTIC_HIGH_CUES if c in lowered]
        if len(hits) >= 2 or ("definition" in lowered and "formula" in lowered):
            out.append((1.0, "high", f"concept cues: {', '.join(hits)}"))
        elif hits:
            out.append((0.55, "medium", f"concept cue: {hits[0]}"))
        else:
            out.append((0.2, "low", "anecdote/background heuristic"))
    return out


def score_semantic_importance(blocks: list[dict]) -> list[tuple[float, list[str]]]:
    label_to_score = {"high": 1.0, "medium": 0.55, "low": 0.2}
    texts = [b["text"] for b in blocks]
    api_key = os.getenv("OPENAI_API_KEY")
    model = os.getenv("CLEAN_MODEL", "gpt-4o-mini")

    if not api_key:
        return [
            (score, [f"semantic {label}: {reason}"])
            for score, label, reason in _semantic_fallback(texts)
        ]

    numbered = "\n\n".join(
        f"[{i}] {format_clock(b['start'])} {b['text'][:1200]}"
        for i, b in enumerate(blocks)
    )
    prompt = (
        "Score lecture topic blocks by conceptual centrality. "
        "Definitions, formulas, theorems, and algorithms are high. "
        "Worked examples are medium. Anecdotes, logistics, and background are low. "
        "Return ONLY a JSON list of objects: "
        '{"block_index": int, "importance": "high"|"medium"|"low", "reason": str}. '
        "Include every block_index.\n\n"
        f"{numbered}"
    )
    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": "You label lecture blocks. Reply with JSON only.",
                },
                {"role": "user", "content": prompt},
            ],
        )
        parsed = _parse_semantic_json(response.choices[0].message.content or "[]")
        by_index = {
            int(item["block_index"]): item
            for item in parsed
            if "block_index" in item
        }
        results: list[tuple[float, list[str]]] = []
        for i, _block in enumerate(blocks):
            item = by_index.get(i) or {}
            label = str(item.get("importance") or "low").lower()
            if label not in label_to_score:
                label = "low"
            reason = str(item.get("reason") or label)
            results.append((label_to_score[label], [f"semantic {label}: {reason}"]))
        return results
    except Exception:
        return [
            (score, [f"semantic {label}: {reason}"])
            for score, label, reason in _semantic_fallback(texts)
        ]


def _tier_for(score: float) -> str:
    if score >= TIER_THRESHOLDS["high"]:
        return "high"
    if score >= TIER_THRESHOLDS["medium"]:
        return "medium"
    return "low"


def _tier_emoji(tier: str) -> str:
    return {"high": "🔥", "medium": "🟡", "low": "⚪"}[tier]


def score_blocks(blocks: list[dict]) -> list[dict]:
    if not blocks:
        return []
    texts = [b["text"] for b in blocks]
    durations = [max(0.0, float(b["end"]) - float(b["start"])) for b in blocks]
    explicit = [score_explicit_cues(t) for t in texts]
    repetition = score_repetition(texts)
    duration = score_duration(durations)
    semantic = score_semantic_importance(blocks)

    w = WEIGHTS
    ranked: list[dict] = []
    for i, block in enumerate(blocks):
        e, e_why = explicit[i]
        r, r_why = repetition[i]
        d, d_why = duration[i]
        s, s_why = semantic[i]
        score = _clip01(
            w["explicit"] * e
            + w["repetition"] * r
            + w["duration"] * d
            + w["semantic"] * s
        )
        tier = _tier_for(score)
        ranked.append(
            {
                "block_index": block.get("block_index", i),
                "start": round(float(block["start"]), 3),
                "score": round(score, 3),
                "tier": tier,
                "label": f"{_tier_emoji(tier)} {tier}",
                "reasons": e_why + r_why + d_why + s_why,
                "signals": {
                    "explicit": round(e, 3),
                    "repetition": round(r, 3),
                    "duration": round(d, 3),
                    "semantic": round(s, 3),
                },
            }
        )
    return ranked


def score_transcript(segments: list[dict], clean_markdown: str | None = None) -> list[dict]:
    blocks = segments_to_blocks(segments)
    if clean_markdown:
        md_texts = _markdown_block_texts(clean_markdown)
        for i, block in enumerate(blocks):
            if i < len(md_texts) and md_texts[i]:
                block["text"] = md_texts[i]
    return score_blocks(blocks)


def _markdown_block_texts(markdown: str) -> list[str]:
    texts: list[str] = []
    for block in re.split(r"\n(?=## )", markdown.strip()):
        block = block.strip()
        match = re.match(r"^##\s+\d{2}:\d{2}:\d{2}\s*", block)
        body = block[match.end() :].strip() if match else block
        if body:
            texts.append(body)
    return texts
