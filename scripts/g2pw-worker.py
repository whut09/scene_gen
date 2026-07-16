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
    polyphonic = set("重行长乐朝薄差藏曾处传弹调都发供冠和划会几假降角觉空累量露落难宁强曲少数说宿汤提为系鲜相校血咽要应载着种转")
    pinyin = lazy_pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)
    return [{"phrase": character, "start": index, "end": index + 1, "pinyin": [pinyin[index]], "confidence": 0.55} for index, character in enumerate(text) if character in polyphonic]


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
