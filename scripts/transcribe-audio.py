import argparse
import json
import math
import os
import wave

import numpy as np
import torch
from transformers import pipeline


def confidence_from_result(result):
    values = []
    for chunk in result.get("chunks", []):
        value = chunk.get("confidence", chunk.get("score"))
        if isinstance(value, (int, float)):
            values.append(float(value))
    value = result.get("confidence", result.get("score"))
    if isinstance(value, (int, float)):
        values.append(float(value))
    if not values:
        return None
    return max(0.0, min(1.0, sum(values) / len(values)))


def words_from_result(result):
    words = []
    for chunk in result.get("chunks", []):
        timestamp = chunk.get("timestamp")
        if not isinstance(timestamp, (list, tuple)) or len(timestamp) != 2:
            continue
        start, end = timestamp
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        confidence = chunk.get("confidence", chunk.get("score"))
        word = {
            "text": str(chunk.get("text", "")).strip(),
            "startSeconds": max(0.0, float(start)),
            "endSeconds": max(float(start), float(end)),
        }
        if isinstance(confidence, (int, float)):
            word["confidence"] = max(0.0, min(1.0, float(confidence)))
        words.append(word)
    return words


def transcribe_whisper_with_confidence(recognizer, audio, language):
    with wave.open(audio, "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    samples /= 32768.0
    inputs = recognizer.feature_extractor(samples, sampling_rate=sample_rate, return_tensors="pt")
    device = next(recognizer.model.parameters()).device
    input_features = inputs.input_features.to(device)
    generated = recognizer.model.generate(
        input_features,
        language=language,
        task="transcribe",
        return_dict_in_generate=True,
        output_scores=True,
    )
    transition_scores = recognizer.model.compute_transition_scores(
        generated.sequences,
        generated.scores,
        beam_indices=getattr(generated, "beam_indices", None),
        normalize_logits=True,
    )
    finite_scores = transition_scores[torch.isfinite(transition_scores)]
    confidence = math.exp(float(finite_scores.mean().item())) if finite_scores.numel() else None
    text = recognizer.tokenizer.batch_decode(generated.sequences, skip_special_tokens=True)[0].strip()
    return {"text": text, "confidence": max(0.0, min(1.0, confidence)) if confidence is not None else None}


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--audio")
    source.add_argument("--request-file")
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
    def transcribe(audio, include_words=False):
        if include_words:
            try:
                result = recognizer(audio, return_timestamps="word", generate_kwargs={"language": args.language, "task": "transcribe"})
                return {
                    "text": result.get("text", "").strip(),
                    "confidence": confidence_from_result(result),
                    "words": words_from_result(result),
                }
            except (TypeError, ValueError):
                pass
        if getattr(recognizer.model.config, "model_type", "") == "whisper":
            try:
                return transcribe_whisper_with_confidence(recognizer, audio, args.language)
            except RuntimeError as error:
                if "out of memory" in str(error).lower():
                    raise
            except (AttributeError, TypeError, ValueError):
                pass
        try:
            result = recognizer(audio, return_timestamps="word", generate_kwargs={"language": args.language, "task": "transcribe"})
        except (TypeError, ValueError):
            result = recognizer(audio, generate_kwargs={"language": args.language, "task": "transcribe"})
        return {"text": result.get("text", "").strip(), "confidence": confidence_from_result(result)}

    if args.request_file:
        with open(args.request_file, "r", encoding="utf-8") as handle:
            request = json.load(handle)
        include_words = bool(request.get("wordTimestamps", False))
        segments = [{"sceneIndex": item["sceneIndex"], **transcribe(item["audio"], include_words)} for item in request.get("segments", [])]
        print(json.dumps({"segments": segments}, ensure_ascii=True))
    else:
        print(json.dumps(transcribe(args.audio), ensure_ascii=True))


if __name__ == "__main__":
    main()
