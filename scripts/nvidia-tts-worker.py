import argparse, io, json, os, sys, time, wave
from pathlib import Path
import grpc
import riva.client
import requests
from pypinyin import load_phrases_dict

sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def emit(payload): print(json.dumps(payload, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser()
    for name in ["endpoint", "function-id", "voice", "lexicon"]: parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--language", default="zh-CN"); parser.add_argument("--sample-rate", type=int, default=22050)
    parser.add_argument("--transport", choices=["auto", "grpc", "http"], default="auto")
    args = parser.parse_args(); api_key = os.environ.get("NVIDIA_API_KEY", "")
    if not api_key: raise RuntimeError("NVIDIA_API_KEY is not configured")
    lexicon = json.loads(Path(args.lexicon).read_text(encoding="utf-8"))
    load_phrases_dict({entry["phrase"]: [[syllable] for syllable in entry["pinyin"]] for entry in lexicon["entries"] if entry.get("enabled", True)})
    started = time.perf_counter()
    auth = riva.client.Auth(uri=args.endpoint, use_ssl=True, metadata_args=[["function-id", args.function_id], ["authorization", "Bearer " + api_key]])
    service = riva.client.SpeechSynthesisService(auth)
    http_endpoint = f"https://{args.function_id}.invocation.api.nvcf.nvidia.com/v1/audio/synthesize"
    emit({"type": "ready", "startupMs": round((time.perf_counter() - started) * 1000), "voice": args.voice, "customDictionary": True, "transport": args.transport, "httpFallback": args.transport == "auto"})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line); request_id = request["requestId"]
            synthesis_text = request["text"].encode("utf-8", "strict").decode("utf-8")
            http_synthesis_text = request.get("httpText") or synthesis_text
            custom_dictionary = request.get("customDictionary") or None
            request_started = time.perf_counter()
            output_path = Path(request["outputPath"]); output_path.parent.mkdir(parents=True, exist_ok=True)
            transport = args.transport
            if transport in {"auto", "grpc"}:
                try:
                    with wave.open(str(output_path), "wb") as output:
                        output.setnchannels(1); output.setsampwidth(2); output.setframerate(args.sample_rate)
                        grpc_text = request.get("textChunks") or synthesis_text
                        for response in service.synthesize_online(grpc_text, voice_name=args.voice, language_code=args.language, sample_rate_hz=args.sample_rate, custom_dictionary=custom_dictionary):
                            output.writeframes(response.audio)
                    transport = "grpc"
                except grpc.RpcError:
                    if args.transport == "grpc": raise
                    transport = "http"
            if transport == "http":
                http_chunks = request.get("httpTextChunks") or [http_synthesis_text]
                audio_frames = []
                for http_chunk in http_chunks:
                    form = {"text": http_chunk, "language": args.language, "voice": args.voice, "encoding": "LINEAR_PCM", "sample_rate_hz": str(args.sample_rate)}
                    response = None
                    for attempt in range(3):
                        response = requests.post(http_endpoint, headers={"Authorization": "Bearer " + api_key, "Accept": "audio/wav"}, files={key: (None, value) for key, value in form.items()}, timeout=180)
                        if response.status_code not in {408, 429, 500, 502, 503, 504} or attempt == 2: break
                        time.sleep(0.75 * (2 ** attempt))
                    response.raise_for_status()
                    if not response.content.startswith(b"RIFF"): raise RuntimeError("NVIDIA HTTP TTS returned a non-WAV response")
                    with wave.open(io.BytesIO(response.content), "rb") as source:
                        if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != args.sample_rate:
                            raise RuntimeError("NVIDIA HTTP TTS returned an incompatible WAV format")
                        audio_frames.append(source.readframes(source.getnframes()))
                with wave.open(str(output_path), "wb") as output:
                    output.setnchannels(1); output.setsampwidth(2); output.setframerate(args.sample_rate); output.writeframes(b"".join(audio_frames))
            emit({"type": "result", "requestId": request_id, "status": "succeeded", "outputPath": str(output_path), "requestMs": round((time.perf_counter() - request_started) * 1000), "synthesisText": http_synthesis_text if transport == "http" else synthesis_text, "appliedPronunciationPhrases": sorted((custom_dictionary or {}).keys()) if transport == "grpc" else [], "transport": transport, "continuousStream": transport == "grpc", "synthesisUnitCount": len(request.get("textChunks") or [synthesis_text]) if transport == "grpc" else len(http_chunks)})
        except grpc.RpcError as error:
            emit({"type": "result", "requestId": request.get("requestId", "unknown"), "status": "failed", "errorType": error.code().name.lower(), "retryable": error.code() in {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.DEADLINE_EXCEEDED}, "error": str(error.details())})
        except Exception as error:
            emit({"type": "result", "requestId": request.get("requestId", "unknown"), "status": "failed", "errorType": "worker_error", "retryable": False, "error": str(error)})

if __name__ == "__main__": main()
