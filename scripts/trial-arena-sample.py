"""Lists the arena dataset and saves its card, schema and a small sample (first pass: discovery only)."""
import json, os, sys
from huggingface_hub import HfApi, hf_hub_download

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
repo = "datapointai/vibe-landing-page-arena"
api = HfApi(token=os.environ["HF_TOKEN"])
files = api.list_repo_files(repo, repo_type="dataset")
info = api.dataset_info(repo, files_metadata=True)
sizes = {s.rfilename: s.size for s in info.siblings}
json.dump({"files": [{"path": f, "size": sizes.get(f)} for f in files]}, open(f"{out}/files.json", "w"), indent=1)
hf_hub_download(repo, "README.md", repo_type="dataset", local_dir=out)

import pyarrow.parquet as pq
for f in files:
    if f.endswith(".parquet") and (sizes.get(f) or 0) < 200_000_000:
        p = hf_hub_download(repo, f, repo_type="dataset", local_dir=f"{out}/raw")
        t = pq.read_table(p)
        meta = {"file": f, "rows": t.num_rows, "schema": str(t.schema)}
        cols = [c for c in t.column_names if "binary" not in str(t.schema.field(c).type) and not any(k in c.lower() for k in ("image", "screenshot", "png"))]
        meta["head"] = t.select(cols).slice(0, 3).to_pylist()
        json.dump(meta, open(f"{out}/{f.replace('/', '_')}.schema.json", "w"), indent=1, default=str)
        os.remove(p)
print("files:", len(files))
