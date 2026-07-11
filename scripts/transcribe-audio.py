import argparse
import json
import os

import torch
from transformers import pipeline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", default=os.getenv("ASR_MODEL", "openai/whisper-tiny"))
    parser.add_argument("--language", default="chinese")
    args = parser.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    device = 0 if torch.cuda.is_available() else -1
    recognizer = pipeline(
        "automatic-speech-recognition",
        model=args.model,
        device=device,
    )
    result = recognizer(
        args.audio,
        generate_kwargs={"language": args.language, "task": "transcribe"},
    )
    print(json.dumps({"text": result.get("text", "").strip()}, ensure_ascii=True))


if __name__ == "__main__":
    main()
