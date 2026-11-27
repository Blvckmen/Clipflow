"""Writes per-second audio energy for a media file. Window choice happens in highlights.mjs.
Usage: highlight.py <media> <out.json> [max_seconds (0 = all, default 600)] [sample_rate (default 8000)].
Whole recordings are measured at a low sample rate: loudness per second needs no more."""
import array, json, subprocess, sys
source, output = sys.argv[1], sys.argv[2]
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 600
rate = int(sys.argv[4]) if len(sys.argv) > 4 else 8000
args = ["ffmpeg","-v","error","-i",source,"-vn","-ac","1","-ar",str(rate)] + (["-t",str(limit)] if limit > 0 else []) + ["-f","s16le","pipe:1"]
audio = subprocess.run(args, capture_output=True, timeout=None if limit <= 0 else 120, check=True).stdout
samples = array.array("h", audio)
if sys.byteorder != "little": samples.byteswap()
energy = [round(sum(v*v for v in samples[i:i+rate])/max(1,len(samples[i:i+rate])), 1) for i in range(0,len(samples),rate)]
with open(output,"w") as f: json.dump({"energy":energy,"method":"audio_energy"},f)
