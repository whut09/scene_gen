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


def resample_audio(samples, source_rate, target_rate):
    if source_rate == target_rate or samples.size == 0:
        return samples
    target_length = max(1, round(samples.size * target_rate / source_rate))
    source_positions = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    target_positions = np.linspace(0.0, 1.0, num=target_length, endpoint=False)
    return np.interp(target_positions, source_positions, samples).astype(np.float32)


def transcribe_whisper_with_confidence(recognizer, audio, language, include_words=False):
    with wave.open(audio, "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    samples /= 32768.0
    target_rate = int(getattr(recognizer.feature_extractor, "sampling_rate", 16000))
    samples = resample_audio(samples, sample_rate, target_rate)
    inputs = recognizer.feature_extractor(samples, sampling_rate=target_rate, return_tensors="pt")
    device = next(recognizer.model.parameters()).device
    input_features = inputs.input_features.to(device)
    generation_config = recognizer.model.generation_config
    decoder_input_ids = torch.ones((input_features.shape[0], 1), device=device, dtype=torch.long) * generation_config.decoder_start_token_id
    with torch.no_grad():
        language_logits = recognizer.model(input_features=input_features, decoder_input_ids=decoder_input_ids, use_cache=False).logits[:, -1]
    language_ids = list(generation_config.lang_to_id.values())
    language_probabilities = torch.softmax(language_logits[:, language_ids], dim=-1)
    detected_index = int(language_probabilities.argmax(dim=-1)[0].item())
    detected_language_id = language_ids[detected_index]
    detected_language = recognizer.tokenizer.decode([detected_language_id]).replace("<|", "").replace("|>", "")
    language_confidence = float(language_probabilities[0, detected_index].item())
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
    result = {
        "text": text,
        "confidence": max(0.0, min(1.0, confidence)) if confidence is not None else None,
        "detectedLanguage": detected_language,
        "languageConfidence": max(0.0, min(1.0, language_confidence)),
    }
    if include_words:
        timestamped = recognizer(
            {"array": samples, "sampling_rate": target_rate},
            return_timestamps="word",
            generate_kwargs={"language": language, "task": "transcribe"},
        )
        result["words"] = words_from_result(timestamped)
        if timestamped.get("text"):
            result["text"] = timestamped["text"].strip()
    return result


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
        if getattr(recognizer.model.config, "model_type", "") == "whisper":
            return transcribe_whisper_with_confidence(recognizer, audio, args.language, include_words)
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
        try:
            result = recognizer(audio, return_timestamps="word", generate_kwargs={"language": args.language, "task": "transcribe"})
        except (TypeError, ValueError):
            result = recognizer(audio, generate_kwargs={"language": args.language, "task": "transcribe"})
        return {"text": result.get("text", "").strip(), "confidence": confidence_from_result(result)}

    if args.request_file:
        with open(args.request_file, "r", encoding="utf-8-sig") as handle:
            request = json.load(handle)
        include_words = bool(request.get("wordTimestamps", False))
        segments = [{"sceneIndex": item["sceneIndex"], **transcribe(item["audio"], include_words)} for item in request.get("segments", [])]
        print(json.dumps({"segments": segments}, ensure_ascii=True))
    else:
        print(json.dumps(transcribe(args.audio), ensure_ascii=True))


if __name__ == "__main__":
    main()
