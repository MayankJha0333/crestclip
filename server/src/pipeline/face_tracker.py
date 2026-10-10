"""Low-cost local face tracking for CrestClip. Reads a clip once and emits sampled boxes as JSON."""
import json
import sys

import cv2
import mediapipe as mp

source, start_text, end_text = sys.argv[1:4]
start, end = float(start_text), float(end_text)
video = cv2.VideoCapture(source)
fps = video.get(cv2.CAP_PROP_FPS) or 30.0
video.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
step = max(1, round(fps / 8))
detector = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.45)
frames, times = [], []
index = 0
while True:
    ok, frame = video.read()
    if not ok:
        break
    t = index / fps
    if start + t > end:
        break
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    result = detector.process(rgb)
    if index % step == 0:
        h, w = frame.shape[:2]
        faces = []
        for found in (result.detections or [])[:4]:
            box = found.location_data.relative_bounding_box
            x0 = max(0, min(1000, round(box.xmin * 1000)))
            y0 = max(0, min(1000, round(box.ymin * 1000)))
            x1 = max(x0 + 1, min(1000, round((box.xmin + box.width) * 1000)))
            y1 = max(y0 + 1, min(1000, round((box.ymin + box.height) * 1000)))
            faces.append({"box": [y0, x0, y1, x1], "speaking": False})
        frames.append({"i": len(frames), "faces": faces, "subject": []})
        times.append(round(t, 3))
    index += 1
video.release()
detector.close()
print(json.dumps({"times": times, "frames": frames}))
