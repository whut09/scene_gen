import argparse, json, os, sys, time, wave
from pathlib import Path
import grpc
import riva.client
from pypinyin import load_phrases_dict

sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def emit(payload): print(json.dumps(payload, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser()
    for name in ["endpoint", "function-id", "voice", "lexicon"]: parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--language", default="zh-CN"); parser.add_argument("--sample-rate", type=int, default=22050)
    args = parser.parse_args(); api_key = os.environ.get("NVIDIA_API_KEY", "")
    if not api_key: raise RuntimeError("NVIDIA_API_KEY is not configured")
    lexicon = json.loads(Path(args.lexicon).read_text(encoding="utf-8"))
    load_phrases_dict({entry["phrase"]: [[syllable] for syllable in entry["pinyin"]] for entry in lexicon["entries"] if entry.get("enabled", True)})
    started = time.perf_counter()
    auth = riva.client.Auth(uri=args.endpoint, use_ssl=True, metadata_args=[["function-id", args.function_id], ["authorization", "Bearer " + api_key]])
    service = riva.client.SpeechSynthesisService(auth)
    emit({"type": "ready", "startupMs": round((time.perf_counter() - started) * 1000), "voice": args.voice, "customDictionary": True})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line); request_id = request["requestId"]
            synthesis_text = request["text"].encode("utf-8", "strict").decode("utf-8")
            custom_dictionary = request.get("customDictionary") or None
            request_started = time.perf_counter()
            response = service.synthesize(synthesis_text, voice_name=args.voice, language_code=args.language, sample_rate_hz=args.sample_rate, custom_dictionary=custom_dictionary)
            output_path = Path(request["outputPath"]); output_path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(output_path), "wb") as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(args.sample_rate); output.writeframes(response.audio)
            emit({"type": "result", "requestId": request_id, "status": "succeeded", "outputPath": str(output_path), "requestMs": round((time.perf_counter() - request_started) * 1000), "synthesisText": synthesis_text, "appliedPronunciationPhrases": sorted((custom_dictionary or {}).keys())})
        except grpc.RpcError as error:
            emit({"type": "result", "requestId": request.get("requestId", "unknown"), "status": "failed", "errorType": error.code().name.lower(), "retryable": error.code() in {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.DEADLINE_EXCEEDED}, "error": str(error.details())})
        except Exception as error:
            emit({"type": "result", "requestId": request.get("requestId", "unknown"), "status": "failed", "errorType": "worker_error", "retryable": False, "error": str(error)})

if __name__ == "__main__": main()
