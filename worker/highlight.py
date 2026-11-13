"""Writes per-second audio energy for a media file. Window choice happens in highlights.mjs."""
import array, json, subprocess, sys
source, output = sys.argv[1], sys.argv[2]
audio = subprocess.run(["ffmpeg","-v","error","-i",source,"-vn","-ac","1","-ar","8000","-t","600","-f","s16le","pipe:1"], capture_output=True, timeout=120, check=True).stdout
samples = array.array("h", audio)
if sys.byteorder != "little": samples.byteswap()
energy = [round(sum(v*v for v in samples[i:i+8000])/max(1,len(samples[i:i+8000])), 1) for i in range(0,len(samples),8000)]
with open(output,"w") as f: json.dump({"energy":energy,"method":"audio_energy"},f)
