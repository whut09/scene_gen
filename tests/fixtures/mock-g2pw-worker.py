import json
import os
import sys
import time
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


counter = os.environ.get("MOCK_G2PW_START_FILE")
if counter:
    path = Path(counter)
    current = int(path.read_text(encoding="utf-8")) if path.exists() else 0
    path.write_text(str(current + 1), encoding="utf-8")

emit({"type": "ready", "status": "ready", "modelLoadMs": 1})
for line in sys.stdin:
    request = json.loads(line)
    if request.get("type") == "shutdown":
        break
    if request.get("text") == "hang":
        time.sleep(2)
    emit({"type": "result", "requestId": request["requestId"], "status": "succeeded", "predictions": [{"phrase": "重", "start": 0, "end": 1, "pinyin": ["chong2"], "confidence": 0.9}]})
