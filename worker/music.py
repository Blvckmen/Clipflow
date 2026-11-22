"""Splits a video's sound into the voice and everything else (music, game sound) with Demucs (htdemucs), for
turning background music down or off before a clip is rendered (worker/music.mjs).

    py music.py <video> <voice.wav> <rest.wav>

Writes two 44.1 kHz stereo WAV files the length of the video's sound. Exits 3 when Demucs isn't installed."""
import subprocess, sys

RATE = 44100

def main(source, voice_out, rest_out):
    try:
        import numpy as np
        import torch
        from demucs.apply import apply_model
        from demucs.pretrained import get_model
    except ImportError as error:
        print("Demucs isn't installed: py -m pip install demucs (" + str(error) + ")", file=sys.stderr)
        sys.exit(3)
    # Decode with ffmpeg: 32-bit float stereo at the model's rate.
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", source, "-vn", "-ac", "2", "-ar", str(RATE), "-f", "f32le", "pipe:1"], capture_output=True, timeout=300, check=True).stdout
    wav = torch.from_numpy(np.frombuffer(pcm, dtype="<f4").copy()).reshape(-1, 2).T
    if wav.shape[1] < RATE // 10:
        raise SystemExit("the video has (almost) no sound")
    model = get_model("htdemucs")
    model.eval()
    torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
    # Demucs works on normalised audio; the stems are scaled back afterwards.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        stems = apply_model(model, ((wav - mean) / std)[None], device="cpu", split=True, overlap=0.1, progress=False)[0]
    stems = stems * std + mean
    voice = stems[model.sources.index("vocals")]
    rest = wav - voice  # everything that isn't voice: music, game sound, effects
    for data, out in ((voice, voice_out), (rest, rest_out)):
        raw = data.clamp(-1, 1).T.contiguous().numpy().astype("<f4").tobytes()
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0", out], input=raw, timeout=300, check=True)

if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: music.py <video> <voice.wav> <rest.wav>")
    main(*sys.argv[1:])
