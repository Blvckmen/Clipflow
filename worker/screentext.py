"""Finds game event banners on screen (WASTED, MISSION PASSED, VICTORY ROYALE, ...) in a video.

Usage: python screentext.py <video> <out.json> [every_seconds=2] [ranges.json]

Samples one frame every `every_seconds` (only inside the [[from, to]] second ranges of ranges.json when given: reading
text is slow on a CPU), reads the text on it with RapidOCR (local), and keeps big text that matches a known game event
phrase: banners are large, the HUD is small. Writes {"events": [{"t", "text"}], "frames"}.
"""
import difflib, json, os, re, subprocess, sys, tempfile

PHRASES = [
    # GTA and other open-world games
    "WASTED", "BUSTED", "MISSION PASSED", "MISSION FAILED", "MISSION COMPLETE",
    # Battle royales
    "VICTORY ROYALE", "WINNER WINNER CHICKEN DINNER", "CHAMPION", "SQUAD WIPED", "ELIMINATED", "KNOCKED DOWN",
    # Shooters and MOBAs
    "TEAM ACE", "ACE", "CLUTCH", "FLAWLESS", "HEADSHOT", "DOUBLE KILL", "TRIPLE KILL", "QUADRA KILL", "PENTA KILL",
    "MULTI KILL", "KILLING SPREE", "RAMPAGE", "UNSTOPPABLE", "GODLIKE", "LEGENDARY", "VICTORY", "DEFEAT",
    # Souls-likes, fighting games and the rest
    "YOU DIED", "ENEMY FELLED", "GREAT ENEMY FELLED", "VICTORY ACHIEVED", "FATALITY", "KNOCKOUT", "PERFECT",
    "GAME OVER", "LEVEL UP", "NEW RECORD", "ACHIEVEMENT UNLOCKED", "YOU WIN", "YOU LOSE",
]
WIDTH, MIN_HEIGHT, MIN_SCORE, SAME_GAP = 640, 0.05, 0.6, 8.0


def match(text):
    """The phrase this OCR text reads as (allowing a misread letter or two), else None."""
    clean = re.sub(r"[^A-Z ]", "", text.upper()).strip()
    clean = re.sub(r" +", " ", clean)
    if len(clean) < 3:
        return None
    best, ratio = None, 0.0
    for phrase in PHRASES:
        r = difflib.SequenceMatcher(None, clean, phrase).ratio()
        # Short phrases must read exactly: "ACE" is one letter from lots of words.
        if len(phrase) <= 5 and clean != phrase:
            continue
        if r > ratio:
            best, ratio = phrase, r
    return best if ratio >= 0.85 else None


def events_in(boxes, height):
    found = []
    for box, text, score in boxes or []:
        ys = [p[1] for p in box]
        if float(score) < MIN_SCORE or (max(ys) - min(ys)) < MIN_HEIGHT * height:
            continue
        phrase = match(text)
        if phrase:
            found.append(phrase)
    return found


def reader():
    """RapidOCR without the angle classifier (banners are upright) and without upscaling small frames for detection."""
    import yaml
    import rapidocr_onnxruntime
    from rapidocr_onnxruntime import RapidOCR
    root = os.path.dirname(rapidocr_onnxruntime.__file__)
    with open(os.path.join(root, "config.yaml"), encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["Global"]["use_angle_cls"] = False
    cfg["Det"].update(limit_side_len=WIDTH, limit_type="max")
    for k in ("Det", "Cls", "Rec"):
        cfg[k]["model_path"] = os.path.join(root, cfg[k]["model_path"])
    fd, path = tempfile.mkstemp(suffix=".yaml")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f)
    try:
        return RapidOCR(config_path=path)
    finally:
        os.remove(path)


def main():
    video, out = sys.argv[1], sys.argv[2]
    every = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
    ranges = None
    if len(sys.argv) > 4:
        with open(sys.argv[4], encoding="utf-8") as f:
            ranges = [(float(a), float(b)) for a, b in json.load(f)]
    import numpy as np
    ocr = reader()
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video],
                           capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    height = int(round(h * WIDTH / w / 2) * 2)
    size, frames, events, last = WIDTH * height * 3, 0, [], {}
    for start, end in ranges if ranges is not None else [(0.0, None)]:
        seek = ["-ss", str(start)] if start else []
        length = ["-t", str(end - start)] if end is not None else []
        ff = subprocess.Popen(["ffmpeg", "-v", "error", *seek, "-i", video, *length, "-vf", f"fps=1/{every},scale={WIDTH}:{height}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                              stdout=subprocess.PIPE)
        i = 0
        while True:
            raw = ff.stdout.read(size)
            if len(raw) < size:
                break
            t = round(start + i * every, 1)
            i += 1
            boxes, _ = ocr(np.frombuffer(raw, dtype=np.uint8).reshape((height, WIDTH, 3)))
            for phrase in events_in(boxes, height):
                # One banner stays up for a few seconds: count it once.
                if t - last.get(phrase, -SAME_GAP * 2) >= SAME_GAP:
                    events.append({"t": t, "text": phrase})
                last[phrase] = t
        ff.wait()
        frames += i
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"events": events, "frames": frames, "every": every}, f)


if __name__ == "__main__":
    main()
