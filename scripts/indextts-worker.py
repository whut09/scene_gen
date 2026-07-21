import argparse, contextlib, json, os, random, sys, time
from pathlib import Path

import numpy as np

sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
PROTOCOL_STDOUT = sys.stdout

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), file=PROTOCOL_STDOUT, flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--ref-audio", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)
    import soundfile as sf
    import torch
    import torchaudio
    from indextts.utils.model_download import ensure_models_available
    from indextts.infer_v2 import IndexTTS2
    torchaudio.save = lambda path, wav, sample_rate, **_: sf.write(path, wav.squeeze().detach().cpu().numpy().astype("int16"), sample_rate, subtype="PCM_16")
    started = time.perf_counter()
    model_dir = str(Path(args.model_dir).resolve())
    with contextlib.redirect_stdout(sys.stderr):
        aux = ensure_models_available(model_dir)
        tts = IndexTTS2(cfg_path=str(Path(model_dir) / "config.yaml"), model_dir=model_dir, use_fp16=True, use_cuda_kernel=False, use_deepspeed=False, aux_paths=aux)
    emit({"type": "ready", "modelLoadMs": round((time.perf_counter() - started) * 1000), "model": "IndexTTS2", "fixedReference": True})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            output_path = Path(request["outputPath"])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            request_started = time.perf_counter()
            seed = int(request.get("seed", 20260721))
            random.seed(seed)
            np.random.seed(seed & 0xFFFFFFFF)
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
            with contextlib.redirect_stdout(sys.stderr):
                tts.infer(
                    spk_audio_prompt=str(Path(args.ref_audio).resolve()),
                    text=request["text"],
                    output_path=str(output_path),
                    use_random=False,
                    use_emo_text=False,
                    interval_silence=120,
                    top_p=float(request.get("topP", 0.65)),
                    top_k=int(request.get("topK", 20)),
                    temperature=float(request.get("temperature", 0.65)),
                    repetition_penalty=float(request.get("repetitionPenalty", 10.0)),
                    verbose=False,
                )
            emit({"type": "result", "requestId": request["requestId"], "status": "succeeded", "outputPath": str(output_path), "synthesisMs": round((time.perf_counter() - request_started) * 1000)})
        except Exception as error:
            emit({"type": "result", "requestId": request.get("requestId", "unknown"), "status": "failed", "errorType": "indextts_error", "retryable": False, "error": str(error)})

if __name__ == "__main__":
    main()
