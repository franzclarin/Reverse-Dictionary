"""
Reference vectors from the production embedder, for the encoder parity check.

Shells out to `training/tools/embed_reference.ts`, which imports the real
`lib/embedder.ts`. Deliberately NOT a committed fixture: a stored vector file
would keep passing after the served model changed, which is the one failure mode
this check exists to catch.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from .paths import REPO_ROOT, TRAINING_DIR

TOOL = TRAINING_DIR / "tools" / "embed_reference.ts"


def onnx_reference_vectors(texts: list[str] | None = None, timeout: int = 300) -> dict[str, list[float]]:
    """
    Run the served ONNX embedder and return `{text: vector}`.

    Requires `npx` and a populated `models/` directory -- run `npm run
    fetch-model` at the repo root if the model is missing. The thrown error
    names the command, matching how lib/embedder.ts reports the same problem.
    """
    if shutil.which("npx") is None:
        raise RuntimeError("npx not found on PATH; needed to run the TypeScript embedder")

    model_file = REPO_ROOT / "models" / "franzclarin" / "ReverseDictionary" / "onnx" / "model.onnx"
    if not model_file.exists():
        raise RuntimeError(
            f"{model_file} is missing. Run `npm run fetch-model` at the repo root -- "
            "the model is gitignored and fetched during build."
        )

    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "ref.json"
        cmd = ["npx", "tsx", str(TOOL), str(out_path), *(texts or [])]
        proc = subprocess.run(
            cmd,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0 or not out_path.exists():
            raise RuntimeError(
                f"embed_reference.ts failed (exit {proc.returncode}):\n"
                f"{(proc.stderr or proc.stdout)[-800:]}"
            )
        return json.loads(out_path.read_text(encoding="utf-8"))
