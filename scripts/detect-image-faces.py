import json
import os
from pathlib import Path
import sys

import cv2


def detect_faces(image):
    height, width = image.shape[:2]
    model_path = Path(os.environ.get("ASSET_FACE_DETECTOR_MODEL", Path(__file__).resolve().parents[1] / "config" / "models" / "face_detection_yunet_2023mar.onnx"))
    if hasattr(cv2, "FaceDetectorYN_create"):
        if not model_path.exists():
            raise RuntimeError(f"YuNet model not found: {model_path}")
        detector = cv2.FaceDetectorYN_create(str(model_path), "", (width, height))
        detector.setInputSize((width, height))
        _, detections = detector.detect(image)
        return [] if detections is None else detections
    if hasattr(cv2, "CascadeClassifier"):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        minimum = max(36, min(height, width) // 14)
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_alt2.xml")
        return cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=6, minSize=(minimum, minimum))
    raise RuntimeError("No supported face detector is available")


def main():
    image = cv2.imread(sys.argv[1])
    if image is None:
        raise RuntimeError("image cannot be decoded")
    height, width = image.shape[:2]
    detections = detect_faces(image)
    boxes = [(int(face[0]), int(face[1]), int(face[2]), int(face[3])) for face in detections]
    largest = max((face_width * face_height for _, _, face_width, face_height in boxes), default=0)
    print(json.dumps({"faces": len(boxes), "largestAreaRatio": largest / max(1, width * height)}))


if __name__ == "__main__":
    main()
