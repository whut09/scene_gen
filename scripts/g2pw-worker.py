import argparse
import json
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_converter(model_dir):
    from g2pw import G2PWConverter
    options = {"use_onnx": True}
    if model_dir:
        options["model_dir"] = model_dir
    return G2PWConverter(**options)


def predictions(converter, text):
    result = converter(text, return_confidence=True)
    if isinstance(result, tuple):
        pinyin, confidence = result
    else:
        pinyin, confidence = result, [1.0] * len(result)
    output = []
    for index, syllable in enumerate(pinyin):
        if syllable and syllable != text[index]:
            output.append({"phrase": text[index], "start": index, "end": index + 1, "pinyin": [syllable], "confidence": float(confidence[index])})
    return output


def pypinyin_predictions(text):
    from pypinyin import Style, lazy_pinyin
    polyphonic = {chr(codepoint) for codepoint in (0x91CD, 0x884C, 0x957F, 0x4E50, 0x671D, 0x8584, 0x5DEE, 0x85CF, 0x66FE, 0x5904, 0x4F20, 0x5F39, 0x8C03, 0x90FD, 0x53D1, 0x4F9B, 0x51A0, 0x548C, 0x5212, 0x4F1A, 0x51E0, 0x5047, 0x964D, 0x89D2, 0x89C9, 0x7A7A, 0x7D2F, 0x91CF, 0x9732, 0x843D, 0x96BE, 0x5B81, 0x5F3A, 0x66F2, 0x5C11, 0x6570, 0x8BF4, 0x5BBF, 0x6C64, 0x63D0, 0x4E3A, 0x7CFB, 0x9C9C, 0x76F8, 0x6821, 0x8840, 0x54BD, 0x8981, 0x5E94, 0x8F7D, 0x7740, 0x79CD, 0x8F6C)}
    output = []
    for index, character in enumerate(text):
        if character not in polyphonic:
            continue
        syllables = lazy_pinyin(character, style=Style.TONE3, neutral_tone_with_five=True)
        if syllables:
            output.append({"phrase": character, "start": index, "end": index + 1, "pinyin": [syllables[0]], "confidence": 0.55})
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir")
    parser.add_argument("--pypinyin-only", action="store_true")
    args = parser.parse_args()
    started = time.perf_counter()
    try:
        converter = None if args.pypinyin_only else load_converter(args.model_dir)
        pypinyin_predictions("")
        emit({"type": "ready", "status": "ready", "modelLoadMs": round((time.perf_counter() - started) * 1000)})
    except Exception as error:
        emit({"type": "ready", "status": "unavailable", "modelLoadMs": round((time.perf_counter() - started) * 1000), "error": str(error)})
        return
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("type") == "shutdown":
            return
        try:
            mode = request.get("mode", "g2pw")
            result = pypinyin_predictions(request["text"]) if mode == "pypinyin" else predictions(converter, request["text"])
            emit({"type": "result", "requestId": request["requestId"], "status": "succeeded", "predictions": result})
        except Exception as error:
            emit({"type": "result", "requestId": request.get("requestId", ""), "status": "failed", "predictions": [], "error": str(error)})


if __name__ == "__main__":
    main()
