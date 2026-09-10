import json
import sys

from rapidocr_onnxruntime import RapidOCR


def main():
    engine = RapidOCR()
    result, _ = engine(sys.argv[1])
    text = " ".join(str(item[1]) for item in (result or []) if len(item) > 1)
    print(json.dumps({"text": text}, ensure_ascii=True))


if __name__ == "__main__":
    main()
