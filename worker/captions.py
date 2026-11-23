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
MODELS = {}
def load(name):
    """A Whisper model, loaded once per process (`serve` keeps them between requests)."""
    from faster_whisper import WhisperModel
    if name not in MODELS:
        # One model at a time: switching Transcription quality frees the old one (about 0.5-1.5 GB) first.
        MODELS.clear()
        # "small" is far more accurate than "tiny" on stream audio (game sound, music, crosstalk, slang) and still runs
        # on a laptop CPU. WHISPER_MODEL=tiny brings back the fast, rough transcripts; WHISPER_THREADS sets the cores.
        MODELS[name]=WhisperModel(name,device="cpu",compute_type="int8",download_root=os.getenv("WHISPER_DIR","/data/models"),cpu_threads=int(os.getenv("WHISPER_THREADS","4")))
    return MODELS[name]
def clean_hint(hint):
    """The hint as text Whisper's tokenizer accepts: at most 200 characters, with any half of an emoji (a lone
    surrogate, e.g. from a title cut mid-emoji) replaced. The tokenizer refuses those with "TextInputSequence must
    be str"."""
    return str(hint or "").encode("utf-8","replace").decode("utf-8").strip()[:200]
def transcribe(source, target, hint="", model_name=None):
    """Writes {"segments": [{"start", "end", "words": [[start, end, text], ...]}]} for the whole file. `hint` (the
    streamer's name, the stream title) nudges Whisper towards spelling those words right."""
    import json
    import numpy as np
    # Decode with ffmpeg rather than faster-whisper's PyAV path, whose keyword arguments break across PyAV releases.
    pcm=subprocess.run(["ffmpeg","-v","error","-i",source,"-vn","-ac","1","-ar","16000","-f","s16le","pipe:1"],capture_output=True,timeout=120,check=True).stdout
    audio=np.frombuffer(pcm,dtype="<i2").astype(np.float32)/32768.0
    model=load(model_name or os.getenv("WHISPER_MODEL","small"))
    # Measured on a 4-core laptop: small with beam 1 runs faster than real time; beam 5 is slower than real time for
    # little gain. Keeping earlier text as context gives fuller punctuation (clip cuts snap to sentence ends);
    # WHISPER_CONTEXT=off trades that for fewer repeated lines in very noisy audio.
    segments,_=model.transcribe(audio,beam_size=int(os.getenv("WHISPER_BEAM","1")),vad_filter=True,word_timestamps=True,condition_on_previous_text=os.getenv("WHISPER_CONTEXT","on")!="off",hotwords=clean_hint(hint) or None)
    out=[{"start":s.start,"end":s.end,"words":[[w.start,w.end,w.word] for w in (s.words or [])]} for s in segments]
    with open(target,"w",encoding="utf-8") as f: json.dump({"segments":out},f)
def window(segments, start, end):
    """Words fully inside [start, end], shifted to start at 0, grouped by segment."""
    return [[(ws-start, we-start, text) for ws, we, text in seg["words"] if ws >= start and we <= end] for seg in segments]
def write_srt(words_file, start, end, target):
    import json
    with open(words_file,encoding="utf-8") as f: segments=json.load(f)["segments"]
    with open(target,"w",encoding="utf-8") as f:
        for index,(s,e,text) in enumerate(chunk(window(segments,start,end)),1):
            f.write(f"{index}\n{stamp(s)} --> {stamp(e)}\n{text}\n\n")
def serve():
    """One request per line on stdin, {"id", "source", "target", "hint", "model"}, answered with one line on stdout,
    {"id", "ok"} or {"id", "ok": false, "error"}. Models stay loaded between requests (worker/whisper.mjs). Exits when
    stdin closes, so it never outlives the worker that started it."""
    import json
    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try:
            req=json.loads(line)
        except ValueError:
            continue
        try:
            transcribe(req["source"],req["target"],req.get("hint",""),req.get("model"))
            reply={"id":req.get("id"),"ok":True}
        except Exception as error:
            reply={"id":req.get("id"),"ok":False,"error":(type(error).__name__+": "+str(error))[:300]}
        sys.stdout.write(json.dumps(reply)+"\n"); sys.stdout.flush()
if __name__ == "__main__":
    # captions.py words <media> <words.json> [hint]  |  captions.py srt <words.json> <start> <end> <out.srt>  |  captions.py serve
    if sys.argv[1] == "serve": serve()
    elif sys.argv[1] == "words": transcribe(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
    elif sys.argv[1] == "srt": write_srt(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5])
    else: sys.exit("usage: captions.py words <media> <out.json> | srt <words.json> <start> <end> <out.srt>")
