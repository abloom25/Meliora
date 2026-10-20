# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "beat-this==1.1.0", "torch==2.14.1", "torchaudio==2.11.0",
#   "onnx==1.23.2", "onnxruntime==1.31.0", "numpy==2.5.4",
#   "einops==0.8.2", "rotary-embedding-torch==0.9.1",
# ]
# ///
"""Export the official Small and Standard Beat This! checkpoints for browsers.

Run: uv run scripts/export-beat-this.py

The checked-in assets are float32 ONNX, split into <= 8 MiB files so they fit
static hosting limits. Downloads are pinned by SHA-256 and torch.load uses
weights_only=True. This exports the actual upstream networks, not a substitute.

The graph preserves 30-second context and divides attention along independent
batch/head axes to keep individual score tensors under 72 MB. BatchNorm is
folded for inference. CPU ONNX output is compared with the unmodified official
PyTorch model before publishing any model parts. WebGPU requires a separate
device parity check: some Adreno drivers compute Conv/Transpose incorrectly.
"""

import copy
import hashlib
import inspect
import json
from pathlib import Path
import types
import urllib.request

import numpy as np
import onnx
from onnx import helper, numpy_helper
import onnxruntime as ort
import torch
from torch import nn

from beat_this.model.beat_tracker import BeatThis
from beat_this.model.roformer import Attend
from beat_this.preprocessing import LogMelSpect


ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".codex/beat-this-export"
OUTPUT = ROOT / "public/models/beat-this"
FIXTURES = ROOT / "src/tests/fixtures"
UPSTREAM_COMMIT = "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c"
CHECKPOINT_ROOT = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp"
CHECKPOINTS = {
    "small": ("small0", "6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b"),
    "standard": ("final0", "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"),
}
FRAMES = 1500
PART_BYTES = 8 * 1024 * 1024
MAX_ATTENTION_ELEMENTS = 18_000_000


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, path, expected_hash=None):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            path.write_bytes(response.read())
    data = path.read_bytes()
    if expected_hash and sha256(data) != expected_hash:
        raise ValueError(f"Pinned download SHA-256 mismatch: {path.name}")
    return data


class AffineBatchNorm(nn.Module):
    def __init__(self, module):
        super().__init__()
        scale = module.weight / torch.sqrt(module.running_var + module.eps)
        self.register_buffer("scale", scale.reshape(1, -1, 1))
        self.register_buffer("bias", (module.bias - module.running_mean * scale).reshape(1, -1, 1))

    def forward(self, x):
        return x * self.scale + self.bias


def split_attention(self, q, k, v):
    """Only split independent batch/head work; retain every 1500-frame key."""
    batch, heads, length, dim = map(int, q.shape)
    width = max(1, MAX_ATTENTION_ELEMENTS // (length * length))
    q = q.reshape(batch * heads, length, dim)
    k = k.reshape(batch * heads, length, dim)
    v = v.reshape(batch * heads, length, dim)
    scale = self.scale if self.scale is not None else dim ** -0.5
    chunks = []
    for start in range(0, batch * heads, width):
        stop = min(start + width, batch * heads)
        scores = torch.matmul(q[start:stop] * scale, k[start:stop].transpose(-2, -1))
        chunks.append(torch.matmul(torch.softmax(scores, dim=-1), v[start:stop]))
    return torch.cat(chunks, dim=0).reshape(batch, heads, length, dim)


class ExportModel(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = copy.deepcopy(model)
        stem = self.model.frontend.stem
        stem.bn1d = AffineBatchNorm(stem.bn1d)
        stem.conv2d = nn.utils.fusion.fuse_conv_bn_eval(stem.conv2d, stem.bn2d)
        stem.bn2d = nn.Identity()
        for block in self.model.frontend.blocks:
            block.conv2d = nn.utils.fusion.fuse_conv_bn_eval(block.conv2d, block.norm)
            block.norm = nn.Identity()
        for module in self.model.modules():
            if isinstance(module, Attend):
                module.forward = types.MethodType(split_attention, module)

    def forward(self, spect):
        outputs = self.model(spect)
        return outputs["beat"], outputs["downbeat"]


def lower_static_splits(model):
    """Avoid a known onnxruntime-web Split shader compilation failure."""
    constants = {value.name: numpy_helper.to_array(value) for value in model.graph.initializer}
    for node in model.graph.node:
        if node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value":
                    constants[node.output[0]] = numpy_helper.to_array(attr.t)
    nodes = []
    for index, node in enumerate(model.graph.node):
        if node.op_type != "Split":
            nodes.append(node)
            continue
        attrs = {attr.name: helper.get_attribute_value(attr) for attr in node.attribute}
        sizes = constants.get(node.input[1]) if len(node.input) > 1 else attrs.get("split")
        if sizes is None:
            raise ValueError(f"Unresolved Split: {node.name}")
        offset = 0
        for part, (output, size) in enumerate(zip(node.output, sizes, strict=True)):
            names = []
            for label, value in (("start", offset), ("end", offset + int(size)), ("axis", attrs.get("axis", 0))):
                name = f"static_split_{index}_{part}_{label}"
                model.graph.initializer.append(numpy_helper.from_array(np.array([value], dtype=np.int64), name))
                names.append(name)
            nodes.append(helper.make_node("Slice", [node.input[0], *names], [output], name=f"static_split_{index}_{part}"))
            offset += int(size)
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    # Split lowering leaves its shape constants unused; remove those before save.
    used = {name for node in model.graph.node for name in node.input}
    constants = [node for node in model.graph.node if node.op_type != "Constant" or any(name in used for name in node.output)]
    initializers = [value for value in model.graph.initializer if value.name in used]
    del model.graph.node[:]
    model.graph.node.extend(constants)
    del model.graph.initializer[:]
    model.graph.initializer.extend(initializers)
    return model


def asset_part(path):
    data = path.read_bytes()
    return {"url": "/models/beat-this/" + path.name, "bytes": len(data), "sha256": sha256(data)}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def export_frontend():
    frontend = LogMelSpect().eval()
    filterbank = frontend.spect_class.mel_scale.fb.detach().numpy().astype("<f4")
    assert filterbank.shape == (513, 128)
    path = OUTPUT / "mel-filterbank-v1.bin"
    path.write_bytes(filterbank.tobytes())
    # Integer formula is reproduced exactly in JS; samples stay exactly float32.
    samples = np.array([((i * 37) % 257 - 128) / 512 for i in range(4096)], dtype=np.float32)
    with torch.inference_mode():
        features = frontend(torch.from_numpy(samples)).numpy()
    write_json(FIXTURES / "beat-this-features.json", {
        "generator": "beat-this 1.1.0 official LogMelSpect (torchaudio float32)",
        "sampleCount": len(samples), "sampleRate": 22050,
        "sampleFormula": "((i * 37) % 257 - 128) / 512",
        "features": features.tolist(),
    })
    return asset_part(path)


def export_model(model_id, checkpoint_name, checkpoint_hash):
    source = CACHE / f"{checkpoint_name}.ckpt"
    checkpoint_data = fetch(f"{CHECKPOINT_ROOT}/{checkpoint_name}.ckpt", source, checkpoint_hash)
    checkpoint = torch.load(source, map_location="cpu", weights_only=True)
    parameters = inspect.signature(BeatThis).parameters
    model = BeatThis(**{k: v for k, v in checkpoint["hyper_parameters"].items() if k in parameters}).eval()
    state = {k.removeprefix("model."): v for k, v in checkpoint["state_dict"].items()}
    model.load_state_dict(state, strict=True)
    wrapper = ExportModel(model).eval()
    # This exact input can also be generated in the browser to detect GPU bugs.
    probe = np.array([((f * 17 + m * 37) % 101) / 32 for f in range(FRAMES) for m in range(128)], dtype=np.float32).reshape(1, FRAMES, 128)
    tensor = torch.from_numpy(probe)
    with torch.inference_mode():
        reference = model(tensor)
        adapted = wrapper(tensor)
    for i, key in enumerate(("beat", "downbeat")):
        error = float(torch.max(torch.abs(reference[key] - adapted[i])))
        if error > 0.0003:
            raise ValueError(f"{checkpoint_name} PyTorch rewrite parity failure: {key} {error}")
    onnx_path = CACHE / f"{checkpoint_name}-v1.onnx"
    torch.onnx.export(wrapper, tensor, str(onnx_path), dynamo=False, opset_version=17,
                      input_names=["spect"], output_names=["beat", "downbeat"],
                      do_constant_folding=True, external_data=False)
    graph = lower_static_splits(onnx.load(onnx_path))
    onnx.checker.check_model(graph)
    onnx.save(graph, onnx_path)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_mem_pattern = False
    options.log_severity_level = 3
    session = ort.InferenceSession(str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"])
    errors = {}
    for case, values in (("probe", probe), ("silence", np.zeros_like(probe))):
        with torch.inference_mode():
            expected = model(torch.from_numpy(values))
        actual = session.run(["beat", "downbeat"], {"spect": values})
        errors[case] = {}
        for key, output in zip(("beat", "downbeat"), actual, strict=True):
            error = float(np.max(np.abs(expected[key].numpy() - output)))
            errors[case][key] = error
            if not np.isfinite(output).all() or error > 0.0003:
                raise ValueError(f"{checkpoint_name} ONNX parity failure: {case} {key} {error}")
    probe_indices = [i * 47 for i in range(32)]
    write_json(FIXTURES / f"beat-this-{model_id}-parity.json", {
        "checkpointSha256": checkpoint_hash, "inputFormula": "((frame * 17 + mel * 37) % 101) / 32",
        "shape": [1, FRAMES, 128], "indices": probe_indices,
        "beat": [float(reference["beat"][0, i]) for i in probe_indices],
        "downbeat": [float(reference["downbeat"][0, i]) for i in probe_indices],
        "onnxMaxAbsErrors": errors,
    })
    data = onnx_path.read_bytes()
    parts = []
    for index, start in enumerate(range(0, len(data), PART_BYTES)):
        path = OUTPUT / f"{checkpoint_name}-v1-{index:02d}.bin"
        path.write_bytes(data[start:start + PART_BYTES])
        parts.append(asset_part(path))
    result = {
        "id": model_id, "label": "Beat This! Small" if model_id == "small" else "Beat This! 标准版",
        "version": f"beat-this-{checkpoint_name}-v1", "bytes": len(data), "sha256": sha256(data),
        "checkpoint": {"name": checkpoint_name, "bytes": len(checkpoint_data), "sha256": checkpoint_hash,
                       "url": f"{CHECKPOINT_ROOT}/{checkpoint_name}.ckpt"},
        "parts": parts, "parity": errors,
    }
    print(json.dumps(result), flush=True)
    return result


def main():
    torch.set_num_threads(2)
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    filterbank = export_frontend()
    models = [export_model(model_id, *checkpoint) for model_id, checkpoint in CHECKPOINTS.items()]
    license_data = fetch(f"https://raw.githubusercontent.com/CPJKU/beat_this/{UPSTREAM_COMMIT}/LICENSE", CACHE / "LICENSE")
    (OUTPUT / "LICENSE").write_bytes(license_data)
    (OUTPUT / "ATTRIBUTION.txt").write_text(
        "Beat This! by Francesco Foscarin, Jan Schlüter and Gerhard Widmer.\n"
        "Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria.\n"
        "Code and official pretrained weights: MIT (see LICENSE).\n"
        f"Source: https://github.com/CPJKU/beat_this/tree/{UPSTREAM_COMMIT}\n"
        "Reference package: beat-this 1.1.0.\n"
        "Conversion: scripts/export-beat-this.py; no retraining or quantization.\n"
        "Official small0 / final0 checkpoints; source and converted hashes in manifest.json.\n"
        "Attention is divided only across independent batch/head axes, keeping full 30s context.\n"
        "No affiliation with or endorsement by the original authors is implied.\n", encoding="utf-8")
    manifest = {
        "formatVersion": 1, "upstreamCommit": UPSTREAM_COMMIT, "package": "beat-this==1.1.0",
        "onnxOpset": 17, "input": {"name": "spect", "shape": [1, FRAMES, 128], "dtype": "float32"},
        "outputs": ["beat", "downbeat"], "fps": 50, "chunkSize": FRAMES, "borderSize": 6,
        "sampleRate": 22050, "nFft": 1024, "hopLength": 441, "center": True,
        "padMode": "reflect", "window": "periodic-hann", "magnitudeDivisor": 32,
        "logMultiplier": 1000, "filterbankShape": [513, 128], "filterbank": filterbank, "models": models,
    }
    write_json(OUTPUT / "manifest.json", manifest)
    public_models = {model["id"]: {key: model[key] for key in ("id", "label", "version", "parts")} for model in models}
    for model in models:
        public_models[model["id"]]["downloadBytes"] = model["bytes"] + filterbank["bytes"]
    metadata = """// Generated by scripts/export-beat-this.py; do not edit hashes by hand.
export type BeatThisModelId = 'small' | 'standard'
export interface BeatThisAssetPart { url: string; bytes: number; sha256: string }
export interface BeatThisModelAsset {
  id: BeatThisModelId
  label: string
  version: string
  /** Model parts plus the shared filterbank; runtime files are separate. */
  downloadBytes: number
  parts: readonly BeatThisAssetPart[]
}
"""
    metadata += "export const BEAT_THIS_MODELS: Record<BeatThisModelId, BeatThisModelAsset> = " + json.dumps(public_models, ensure_ascii=False, indent=2) + "\n"
    metadata += "export const BEAT_THIS_FILTERBANK: BeatThisAssetPart = " + json.dumps(filterbank, indent=2) + "\n"
    (ROOT / "src/core/analysis/beat-this-models.ts").write_text(metadata, encoding="utf-8")
    probes = {}
    for model_id in CHECKPOINTS:
        fixture = json.loads((FIXTURES / f"beat-this-{model_id}-parity.json").read_text(encoding="utf-8"))
        probes[model_id] = {key: fixture[key][:32] for key in ("beat", "downbeat")}
    probe_source = """// Generated by scripts/export-beat-this.py from the official PyTorch models.
// spect[frame * 128 + mel] = ((frame * 17 + mel * 37) % 101) / 32.
// Compare output at frame i * 47, i = 0..31, before trusting a GPU provider.
import type { BeatThisModelId } from './beat-this-models'

export const BEAT_THIS_PROBES: Record<BeatThisModelId, {
  beat: readonly number[]
  downbeat: readonly number[]
}> = """ + json.dumps(probes, indent=2) + "\n"
    (ROOT / "src/core/analysis/beat-this-probes.ts").write_text(probe_source, encoding="utf-8")


if __name__ == "__main__":
    main()
