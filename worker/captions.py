import os, subprocess, sys
MAX_WORDS, MAX_CHARS, MAX_GAP, MAX_SPAN, MIN_SHOW = 4, 24, 0.6, 2.5, 0.4
def stamp(t):
    n=max(0,round(t*1000)); return f"{n//3600000:02}:{n//60000%60:02}:{n//1000%60:02},{n%1000:03}"
def clean(text):
    # Braces and backslashes are libass override syntax; angle brackets are HTML-ish SRT tags.
    return "".join(ch for ch in text if ch not in "<>{}\\").replace("\n"," ").strip()
def chunk(segments):
    """Group each segment's (start, end, text) words into short cues, breaking on size, pauses, sentence ends, and segment ends."""
    cues = []
    for words in segments:
        cur = []
        for start, end, text in words:
            text = clean(text)
            if not text: continue
            if cur and (len(cur) >= MAX_WORDS or len(" ".join(w[2] for w in cur)) + 1 + len(text) > MAX_CHARS or start - cur[-1][1] > MAX_GAP or end - cur[0][0] > MAX_SPAN):
                cues.append(cur); cur = []
            cur.append((start, end, text))
            if text[-1] in ".?!": cues.append(cur); cur = []
        if cur: cues.append(cur)
    out = []
    for i, cue in enumerate(cues):
        start, end = cue[0][0], max(cue[-1][1], cue[0][0] + MIN_SHOW)
        if i + 1 < len(cues): end = min(end, cues[i + 1][0][0])
        out.append((start, end, " ".join(w[2] for w in cue)))
    return out
def main(source, target):
    import numpy as np
    from faster_whisper import WhisperModel
    # Decode with ffmpeg rather than faster-whisper's PyAV path, whose keyword arguments break across PyAV releases.
    pcm=subprocess.run(["ffmpeg","-v","error","-i",source,"-vn","-ac","1","-ar","16000","-f","s16le","pipe:1"],capture_output=True,timeout=120,check=True).stdout
    audio=np.frombuffer(pcm,dtype="<i2").astype(np.float32)/32768.0
    model=WhisperModel(os.getenv("WHISPER_MODEL","tiny"),device="cpu",compute_type="int8",download_root=os.getenv("WHISPER_DIR","/data/models"),cpu_threads=1)
    segments,_=model.transcribe(audio,beam_size=1,vad_filter=True,word_timestamps=True)
    words=[[(w.start, w.end, w.word) for w in (segment.words or [])] for segment in segments]
    with open(target,"w",encoding="utf-8") as f:
        for index,(start,end,text) in enumerate(chunk(words),1):
            f.write(f"{index}\n{stamp(start)} --> {stamp(end)}\n{text}\n\n")
if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
