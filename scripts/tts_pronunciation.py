import json
from pathlib import Path
from typing import Any


def read_pronunciation_lexicon(file_path: str) -> dict[str, Any]:
    return json.loads(Path(file_path).read_text(encoding="utf-8"))


def enabled_phrase_dictionary(payload: dict[str, Any]) -> dict[str, list[list[str]]]:
    return {
        entry["phrase"]: [[syllable] for syllable in entry["pinyin"]]
        for entry in payload.get("entries", [])
        if entry.get("enabled", False)
    }


def load_pronunciation_lexicon(file_path: str) -> dict[str, Any]:
    from pypinyin import load_phrases_dict

    payload = read_pronunciation_lexicon(file_path)
    load_phrases_dict(enabled_phrase_dictionary(payload))
    return payload
