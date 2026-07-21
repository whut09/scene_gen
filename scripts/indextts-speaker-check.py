import argparse, json, sys
from pathlib import Path
import soundfile as sf
import torch, torchaudio

def load_audio(path):
    data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.mean(axis=1)).unsqueeze(0), sample_rate

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--ranges", required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.root).resolve()))
    from indextts.s2mel.modules.campplus.DTDNN import CAMPPlus
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
    model.eval()
    def embedding(wav, sample_rate):
        wav = torchaudio.transforms.Resample(sample_rate, 16000)(wav)
        feat = torchaudio.compliance.kaldi.fbank(wav, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat = feat - feat.mean(dim=0, keepdim=True)
        with torch.no_grad():
            return torch.nn.functional.normalize(model(feat.unsqueeze(0)).squeeze(0), dim=0)
    reference_wav, reference_rate = load_audio(args.reference)
    reference = embedding(reference_wav, reference_rate)
    audio, sample_rate = load_audio(args.audio)
    similarities = []
    for item in json.loads(args.ranges):
        start = int(item["startSeconds"] * sample_rate)
        end = min(audio.shape[1], start + int(item["durationSeconds"] * sample_rate))
        similarities.append(float(torch.dot(reference, embedding(audio[:, start:end], sample_rate))))
    print(json.dumps({"similarities": similarities, "minimum": min(similarities) if similarities else 1, "average": sum(similarities) / len(similarities) if similarities else 1}))

if __name__ == "__main__":
    main()
