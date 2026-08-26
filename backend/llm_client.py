from __future__ import annotations

import os

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL = "gemini-2.5-flash"


def llm_api_key() -> str:
    key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return key


def llm_model() -> str:
    return (os.getenv("CLEAN_MODEL") or os.getenv("LLM_MODEL") or DEFAULT_MODEL).strip()


def chat_complete(
    messages: list[dict],
    *,
    temperature: float = 0.2,
    json_mode: bool = False,
) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=llm_api_key(), base_url=GEMINI_OPENAI_BASE)
    kwargs: dict = {
        "model": llm_model(),
        "temperature": temperature,
        "messages": messages,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    try:
        response = client.chat.completions.create(**kwargs)
    except Exception:
        if not json_mode:
            raise
        kwargs.pop("response_format", None)
        response = client.chat.completions.create(**kwargs)
    text = (response.choices[0].message.content or "").strip()
    if not text:
        raise RuntimeError("LLM returned an empty response")
    return text
