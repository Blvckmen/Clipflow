"""Select the loudest sustained window. This is an audio-energy heuristic, not semantic AI."""
import array, json, math, subprocess, sys
source, target, output = sys.argv[1], int(sys.argv[2]), sys.argv[3]
audio = subprocess.run(["ffmpeg","-v","error","-i",source,"-vn","-ac","1","-ar","8000","-t","180","-f","s16le","pipe:1"], capture_output=True, timeout=60, check=True).stdout
samples = array.array("h", audio)
if sys.byteorder != "little": samples.byteswap()
energy = [sum(v*v for v in samples[i:i+8000])/max(1,len(samples[i:i+8000])) for i in range(0,len(samples),8000)]
span = min(target, len(energy))
start = 0
if span:
    score = best = sum(energy[:span])
    for index in range(span, len(energy)):
        score += energy[index] - energy[index-span]
        if score > best: best, start = score, index-span+1
with open(output,"w") as f: json.dump({"start":start,"method":"audio_energy"},f)
