"""Finds a streamer's webcam overlay in a clip, for the "Facecam + gameplay" and picture-in-picture layouts.

Usage: facecam.py <video> <out.json> <model.onnx>
Writes {"box": {"x","y","w","h"}} (fractions of the frame) around the webcam, or {"box": null, "reason": ...} when
there's no overlay to cut out: no steady face, or a face filling the picture (an IRL or camera-only stream).
Uses OpenCV's YuNet face detector (models/face_detection_yunet_2023mar.onnx, downloaded once by the worker)."""
import json, sys

def main(video, out, model):
    import cv2
    cap = cv2.VideoCapture(video)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if total < 2 or W < 64 or H < 64:
        return write(out, None, "unreadable video")
    scale = 640 / W
    detector = cv2.FaceDetectorYN.create(model, "", (640, int(H * scale)), 0.75, 0.3, 50)
    samples, faces = 10, []
    for i in range(samples):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / samples))
        ok, frame = cap.read()
        if not ok:
            continue
        small = cv2.resize(frame, (640, int(H * scale)))
        _, found = detector.detect(small)
        for f in (found if found is not None else []):
            x, y, w, h = (float(v) / scale for v in f[:4])
            faces.append((x / W, y / H, w / W, h / H))
    cap.release()
    if not faces:
        return write(out, None, "no face found")
    # A face this big is the whole picture (IRL / camera-only): there is no overlay to cut out.
    big = [f for f in faces if f[2] > 0.3]
    if len(big) >= max(2, len(faces) // 2):
        return write(out, None, "the camera fills the picture")
    # The webcam overlay stays put: group faces by where they are and keep the steadiest group.
    groups = []
    for f in faces:
        cx, cy = f[0] + f[2] / 2, f[1] + f[3] / 2
        for g in groups:
            gx, gy = g["cx"], g["cy"]
            if abs(cx - gx) < 0.08 and abs(cy - gy) < 0.08:
                g["faces"].append(f); break
        else:
            groups.append({"cx": cx, "cy": cy, "faces": [f]})
    best = max(groups, key=lambda g: len(g["faces"]))
    if len(best["faces"]) < 3:
        return write(out, None, "no steady face")
    # A webcam overlay shows the streamer in (nearly) every frame, and their face moves little within it, measured
    # against the face's own size. On real streams overlays moved at most 0.17 face-widths (leaning included); people
    # walking about in camera-only (IRL) streams usually much more.
    import statistics
    seen = len(best["faces"]) / max(1, samples)
    drift = statistics.pstdev([f[0] + f[2] / 2 for f in best["faces"]]) / max(1e-6, statistics.mean(f[2] for f in best["faces"]))
    if seen < 0.8 or drift > 0.25:
        return write(out, None, "the face moves around like in a camera-only stream")
    med = lambda k: sorted(f[k] for f in best["faces"])[len(best["faces"]) // 2]
    fx, fy, fw, fh = med(0), med(1), med(2), med(3)
    # Head and shoulders: about 3.2 face-widths across and 2.6 face-heights tall, centred a little below the face.
    w, h = min(1.0, fw * 3.2), min(1.0, fh * 2.6)
    cx, cy = fx + fw / 2, fy + fh / 2 + fh * 0.35
    x, y = min(max(0.0, cx - w / 2), 1 - w), min(max(0.0, cy - h / 2), 1 - h)
    # Webcam overlays sit against the left or right side (often in a corner); a face out in the middle is a person
    # in a camera-only (IRL) stream, even one standing still, which has no overlay to cut out.
    if min(x, 1 - (x + w)) > 0.1:
        return write(out, None, "the face isn't in a webcam overlay")
    write(out, {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}, None)

def write(out, box, reason):
    with open(out, "w") as f:
        json.dump({"box": box, **({"reason": reason} if reason else {})}, f)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
