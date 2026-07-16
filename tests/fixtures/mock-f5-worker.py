import argparse
import hashlib
import json
import os
import sys
import time
import wave
from pathlib import Path


def append_counter(name: str, value: str) -> None:
    file_path = os.environ.get(name)
    if not file_path:
        return
    with open(file_path, "a", encoding="utf-8") as handle:
        handle.write(value + "\n")


def update_metrics(mutator) -> None:
    file_path = os.environ.get("MOCK_F5_METRICS_FILE")
    if not file_path:
        return
    target = Path(file_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        metrics = json.loads(target.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        metrics = {"workerStarts": 0, "modelLoads": 0, "activeRequests": 0, "maxConcurrency": 0, "sceneRequests": {}}
    mutator(metrics)
    temporary = target.with_suffix(target.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(metrics, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_wav(file_path: str) -> float:
    output = Path(file_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = 24000
    frames = sample_rate // 5
    with wave.open(str(output), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(b"\0\0" * frames)
    return frames / sample_rate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--lexicon", required=True)
    parser.add_argument("--default-nfe-step", required=True)
    parser.add_argument("--parent-pid", required=True)
    args = parser.parse_args()

    append_counter("MOCK_F5_START_COUNT_FILE", args.device)
    update_metrics(lambda metrics: metrics.update({
        "workerStarts": metrics.get("workerStarts", 0) + 1,
        "modelLoads": metrics.get("modelLoads", 0) + 1,
    }))
    mode = os.environ.get("MOCK_F5_MODE", "normal")
    if mode == "no-ready":
        time.sleep(60)
        return
    if mode == "delayed-ready":
        time.sleep(int(os.environ.get("MOCK_F5_DELAY_MS", "1000")) / 1000)

    lexicon = json.loads(Path(args.lexicon).read_text(encoding="utf-8"))
    canonical = json.dumps(lexicon, ensure_ascii=False, separators=(",", ":"))
    lexicon_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    emit({
        "type": "ready",
        "status": "ready",
        "pid": os.getpid(),
        "model": args.model,
        "device": args.device,
        "pronunciationLexiconHash": lexicon_hash,
        "workerStartupMs": 7,
        "modelLoadMs": 5,
    })

    for line in sys.stdin:
        request = json.loads(line)
        if request.get("type") == "shutdown":
            return
        append_counter("MOCK_F5_REQUEST_COUNT_FILE", str(request["sceneIndex"]))
        def request_started(metrics: dict) -> None:
            scene_key = str(request["sceneIndex"])
            metrics["activeRequests"] = metrics.get("activeRequests", 0) + 1
            metrics["maxConcurrency"] = max(metrics.get("maxConcurrency", 0), metrics["activeRequests"])
            requests = metrics.setdefault("sceneRequests", {})
            requests[scene_key] = requests.get(scene_key, 0) + 1
        update_metrics(request_started)
        if mode == "crash-first":
            state_path = Path(os.environ["MOCK_F5_CRASH_STATE_FILE"])
            if not state_path.exists():
                state_path.write_text("crashed", encoding="utf-8")
                os._exit(17)
        delay_ms = int(os.environ.get("MOCK_F5_DELAY_MS", "0"))
        if delay_ms:
            time.sleep(delay_ms / 1000)
        started = time.perf_counter()
        duration = write_wav(request["outputPath"])
        update_metrics(lambda metrics: metrics.update({"activeRequests": max(0, metrics.get("activeRequests", 1) - 1)}))
        emit({
            "type": "result",
            "requestId": request["requestId"],
            "sceneIndex": request["sceneIndex"],
            "status": "succeeded",
            "outputPath": str(Path(request["outputPath"]).resolve()),
            "durationSeconds": duration,
            "synthesisMs": max(1, round((time.perf_counter() - started) * 1000)),
            "errorType": None,
            "retryable": False,
            "error": None,
        })


if __name__ == "__main__":
    main()
