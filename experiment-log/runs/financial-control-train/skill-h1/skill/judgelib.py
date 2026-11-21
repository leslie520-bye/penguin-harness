import json, itertools, urllib.request

BASE = "http://127.0.0.1:9101"

def judge(task_id, answer):
    req = urllib.request.Request(BASE + "/api/judge",
                                 data=json.dumps({"task_id": task_id, "answer": answer}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["score"]

if __name__ == "__main__":
    print(judge("train_001", {"payable_claim_ids": ["CLM-2025-OPS-017"]}))
