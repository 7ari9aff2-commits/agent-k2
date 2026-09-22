# n8n workflow backup — exports ALL workflows to backups/n8n/<stamp>/
# Run:  python tools/backup_n8n_workflows.py
# Commit the result to the private repo. Workflows carry no credential secrets.
import httpx, json, os, re, sys
from datetime import datetime, timezone

B = "https://n8n-production-33955.up.railway.app"
lines = [l for l in open("tools/n8n_owner.txt", encoding="utf-8")]
KEY = [l for l in lines if l.startswith("api_key_full")][0].split(": ")[1].strip()
H = {"X-N8N-API-KEY": KEY}


def main():
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M")
    out = os.path.join("backups", "n8n", stamp)
    os.makedirs(out, exist_ok=True)

    r = httpx.get(f"{B}/api/v1/workflows", headers=H, params={"limit": 100}, timeout=30)
    wfs = r.json()["data"]
    index = []
    for w in wfs:
        full = httpx.get(f"{B}/api/v1/workflows/{w['id']}", headers=H, timeout=30).json()
        safe = re.sub(r"[^\w\-]+", "_", w["name"])[:60]
        fp = os.path.join(out, f"{w['id']}__{safe}.json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(full, f, ensure_ascii=False, indent=1)
        index.append({"id": w["id"], "name": w["name"], "active": w.get("active")})
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"exported_at": stamp, "count": len(index), "workflows": index}, f, ensure_ascii=False, indent=1)
    print(f"backed up {len(index)} workflows -> {out}")
    print("active:", sum(1 for i in index if i.get("active")))


if __name__ == "__main__":
    main()
