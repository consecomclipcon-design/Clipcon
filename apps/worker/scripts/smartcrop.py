import json
import sys

import cv2


def detect(video_path, start, duration):
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError("smart crop could not open video")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError("smart crop could not read video dimensions")
    face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    people = cv2.HOGDescriptor()
    people.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    sample_step = 0.5
    keyframes = []
    previous = width / 2.0
    frame_index = max(0, int(start * fps))
    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
    next_sample = start
    end = start + duration
    while next_sample <= end + 0.01:
        capture.set(cv2.CAP_PROP_POS_MSEC, next_sample * 1000.0)
        ok, frame = capture.read()
        if not ok:
            break
        scale = min(1.0, 640.0 / max(frame.shape[1], 1))
        small = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        candidates = []
        for x, y, w, h in face.detectMultiScale(gray, 1.1, 5, minSize=(32, 32)):
            candidates.append((x + w / 2.0, w * h, "face"))
        if not candidates:
            rects, weights = people.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
            for index, (x, y, w, h) in enumerate(rects):
                confidence = float(weights[index]) if len(weights) > index else 0.0
                if confidence > 0.1:
                    candidates.append((x + w / 2.0, w * h, "person"))
        if candidates:
            target = min(candidates, key=lambda item: (abs((item[0] / scale) - previous), -item[1]))
            observed = target[0] / scale
            previous = previous * 0.7 + observed * 0.3
            target_type = target[2]
        else:
            target_type = "fallback"
        keyframes.append({"time": round(next_sample - start, 3), "center": round(previous / width, 6), "target": target_type})
        next_sample += sample_step
    capture.release()
    if not keyframes:
        keyframes = [{"time": 0, "center": 0.5, "target": "fallback"}]
    return {"width": width, "height": height, "keyframes": keyframes, "tracked": any(item["target"] != "fallback" for item in keyframes)}


if __name__ == "__main__":
    result = detect(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))
    print(json.dumps(result, separators=(",", ":")))
