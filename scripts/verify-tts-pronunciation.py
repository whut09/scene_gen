import argparse

from pypinyin import Style, lazy_pinyin
from tts_pronunciation import load_pronunciation_lexicon


def tone3(text: str) -> list[str]:
    return lazy_pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lexicon", required=True)
    args = parser.parse_args()
    payload = load_pronunciation_lexicon(args.lexicon)

    for entry in payload.get("entries", []):
        if not entry.get("enabled", False):
            continue
        actual = tone3(entry["phrase"])
        expected = entry["pinyin"]
        if actual != expected:
            raise AssertionError(f"{entry['phrase']}: expected {expected}, got {actual}")

    cases = {
        "重构系统": ["chong2", "gou4", "xi4", "tong3"],
        "对代码进行重构": ["dui4", "dai4", "ma3", "jin4", "xing2", "chong2", "gou4"],
        "重新构建": ["chong2", "xin1", "gou4", "jian4"],
        "系统重载模型": ["xi4", "tong3", "chong2", "zai4", "mo2", "xing2"],
        "执行函数重载": ["zhi2", "xing2", "han2", "shu4", "chong2", "zai4"],
        "开始重载运输": ["kai1", "shi3", "zhong4", "zai4", "yun4", "shu1"],
    }
    for text, expected in cases.items():
        actual = tone3(text)
        if actual != expected:
            raise AssertionError(f"{text}: expected {expected}, got {actual}")

    print(f"Verified {len(payload.get('entries', []))} pronunciation entries and {len(cases)} context cases.")


if __name__ == "__main__":
    main()
