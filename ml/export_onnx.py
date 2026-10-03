"""Export a trained LensUNet checkpoint to ONNX for the web app.

    python export_onnx.py runs/v1/best.pt ../public/models/lens_seg.onnx
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from train import LensUNet


def main(ckpt: str, out: str) -> None:
    model = LensUNet()
    if ckpt != "-":
        model.load_state_dict(torch.load(ckpt, map_location="cpu"))
    model.eval()
    x = torch.rand(1, 3, 416, 288)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (x,),
        out,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {2: "h", 3: "w"}, "logits": {2: "h", 3: "w"}},
        opset_version=17,
        dynamo=False,
    )
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    for shape in ((1, 3, 416, 288), (1, 3, 256, 256)):
        xi = torch.rand(*shape)
        ref = model(xi).detach().numpy()
        got = sess.run(None, {"image": xi.numpy()})[0]
        print(shape, "max abs diff", float(np.abs(ref - got).max()))
    print("wrote", out, f"{Path(out).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
