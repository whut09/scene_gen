import argparse
import contextlib
import ctypes
import hashlib
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from tts_pronunciation import load_pronunciation_lexicon, read_pronunciation_lexicon


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def lexicon_hash(file_path: str) -> str:
    payload = read_pronunciation_lexicon(file_path)
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def classify_error(error: BaseException) -> tuple[str, bool]:
    message = str(error).lower()
    if "out of memory" in message or "cuda" in message and "memory" in message:
        return "resource_exhausted", False
    if isinstance(error, (ValueError, TypeError, FileNotFoundError)):
        return "invalid_request", False
    if isinstance(error, OSError):
        return "io_error", True
    return "worker_error", False


def parent_is_alive(parent_pid: int) -> bool:
    if sys.platform == "win32":
        process = ctypes.windll.kernel32.OpenProcess(0x1000, False, parent_pid)
        if not process:
            return False
        exit_code = ctypes.c_ulong()
        try:
            return bool(ctypes.windll.kernel32.GetExitCodeProcess(process, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(process)
    try:
        os.kill(parent_pid, 0)
        return True
    except OSError:
        return False


def monitor_parent(parent_pid: int) -> None:
    while True:
        time.sleep(1)
        if not parent_is_alive(parent_pid):
            os._exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", required=True)
    parser.add_argument("--lexicon", required=True)
    parser.add_argument("--default-nfe-step", type=int, default=16)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()

    threading.Thread(target=monitor_parent, args=(args.parent_pid,), daemon=True).start()

    startup_started = time.perf_counter()
    ref_audio = str(Path(args.ref_audio).resolve())
    if not Path(ref_audio).is_file():
        raise FileNotFoundError(f"Reference audio does not exist: {ref_audio}")
    ref_text = args.ref_text
    load_pronunciation_lexicon(args.lexicon)
    current_lexicon_hash = lexicon_hash(args.lexicon)

    model_started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        from f5_tts.api import F5TTS
        from f5_tts.infer.utils_infer import preprocess_ref_audio_text

        api = F5TTS(model=args.model, device=args.device)
        _, ref_text = preprocess_ref_audio_text(ref_audio, ref_text, show_info=lambda message: print(message, file=sys.stderr))
    model_load_ms = round((time.perf_counter() - model_started) * 1000)
    worker_startup_ms = round((time.perf_counter() - startup_started) * 1000)
    emit({
        "type": "ready",
        "status": "ready",
        "pid": os.getpid(),
        "model": args.model,
        "device": args.device,
        "pronunciationLexiconHash": current_lexicon_hash,
        "workerStartupMs": worker_startup_ms,
        "modelLoadMs": model_load_ms,
    })

    for line in sys.stdin:
        if not line.strip():
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                emit({"type": "shutdown", "status": "stopped"})
                return
            if request.get("type") != "synthesize":
                raise ValueError("Unknown worker request type.")
            if request.get("pronunciationLexiconHash") != current_lexicon_hash:
                raise ValueError("Pronunciation lexicon hash does not match the loaded worker lexicon.")

            request_id = str(request["requestId"])
            scene_index = int(request["sceneIndex"])
            text = str(request["text"])
            output_path = str(Path(request["outputPath"]).resolve())
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            synthesis_started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                wave, sample_rate, _ = api.infer(
                    ref_file=ref_audio,
                    ref_text=ref_text,
                    gen_text=text,
                    file_wave=output_path,
                    nfe_step=int(request.get("nfeStep", args.default_nfe_step)),
                    speed=float(request.get("speed", 1.0)),
                    seed=int(request.get("seed", -1)),
                    show_info=lambda message: print(message, file=sys.stderr),
                    progress=None,
                )
            synthesis_ms = round((time.perf_counter() - synthesis_started) * 1000)
            duration_seconds = float(len(wave) / sample_rate) if sample_rate else 0.0
            emit({
                "type": "result",
                "requestId": request_id,
                "sceneIndex": scene_index,
                "status": "succeeded",
                "outputPath": output_path,
                "durationSeconds": duration_seconds,
                "synthesisMs": synthesis_ms,
                "errorType": None,
                "retryable": False,
                "error": None,
            })
        except BaseException as error:
            error_type, retryable = classify_error(error)
            emit({
                "type": "result",
                "requestId": str(request.get("requestId", "unknown")),
                "sceneIndex": int(request.get("sceneIndex", -1)),
                "status": "failed",
                "outputPath": str(request.get("outputPath", "")),
                "durationSeconds": 0,
                "synthesisMs": 0,
                "errorType": error_type,
                "retryable": retryable,
                "error": f"{type(error).__name__}: {error}",
                "traceback": traceback.format_exc(limit=5),
            })


if __name__ == "__main__":
    main()
