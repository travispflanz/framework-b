"""Builds the judge-calibration set from the CC-BY-4.0 Vibe Landing Page Arena (datapointai).

From one comparisons shard, takes the "aesthetic" dimension and samples:
  - 16 pairs with a clear human majority (>= 11 of 15 votes), to measure agreement;
  - 8 near-ties (8-7), to measure order consistency only.
Each pair becomes two composite images (A|B and B|A) of the first screens, shuffled.
The answer key goes in a separate file, so the judge can't see it while judging.
"""
import io, json, os, random, sys
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download
from PIL import Image, ImageDraw

out = sys.argv[1]
os.makedirs(f"{out}/pairs", exist_ok=True)
repo = "datapointai/vibe-landing-page-arena"
path = hf_hub_download(repo, "comparisons/train-00000-of-00006.parquet", repo_type="dataset")
t = pq.read_table(path, columns=["image_a", "image_b", "prompt_id", "category", "tone", "dimension", "votes_a", "votes_b"])
rows = [r for r in t.to_pylist() if r["dimension"] == "aesthetic"]
rng = random.Random(20261022)
clear = [r for r in rows if max(r["votes_a"], r["votes_b"]) >= 11]
close = [r for r in rows if {r["votes_a"], r["votes_b"]} == {7, 8}]
sample = rng.sample(clear, min(16, len(clear))) + rng.sample(close, min(8, len(close)))

def first_screens(img_struct, width=560, height_px=1350):
    im = Image.open(io.BytesIO(img_struct["bytes"])).convert("RGB")
    im = im.crop((0, 0, im.width, min(im.height, round(im.width * height_px / 1440))))
    return im.resize((width, round(im.height * width / im.width)))

def composite(left, right):
    gap, label = 24, 40
    h = max(left.height, right.height) + label
    c = Image.new("RGB", (left.width + right.width + gap, h), "white")
    d = ImageDraw.Draw(c)
    d.text((10, 10), "LEFT", fill="black")
    d.text((left.width + gap + 10, 10), "RIGHT", fill="black")
    c.paste(left, (0, label))
    c.paste(right, (left.width + gap, label))
    return c

items, key = [], {}
for i, r in enumerate(sample):
    a, b = first_screens(r["image_a"]), first_screens(r["image_b"])
    human = "A" if r["votes_a"] > r["votes_b"] else "B"
    strength = "clear" if max(r["votes_a"], r["votes_b"]) >= 11 else "close"
    for order in ("AB", "BA"):
        items.append((f"p{i:02d}-{order}", composite(a, b) if order == "AB" else composite(b, a)))
        key[f"p{i:02d}-{order}"] = {"pair": i, "order": order, "human": human, "votes": [r["votes_a"], r["votes_b"]], "strength": strength,
                                    "category": r["category"], "tone": r["tone"], "prompt_id": r["prompt_id"]}
rng.shuffle(items)
for n, (name, img) in enumerate(items):
    img.save(f"{out}/pairs/{n:03d}.jpg", quality=80)
    key[name]["file"] = f"{n:03d}.jpg"
json.dump(key, open(f"{out}/answer-key.json", "w"), indent=1)
open(f"{out}/ATTRIBUTION.txt", "w").write("Screenshots and votes: Vibe Landing Page Arena, datapointai, CC-BY-4.0.\n")
print("pairs:", len(sample), "images:", len(items), "clear available:", len(clear), "close available:", len(close))
