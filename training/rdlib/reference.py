"""
Numbers straight from the live model, for the parity check.

Runs the real serving code rather than reading a saved file. Deliberately not
saved: a stored copy would keep passing after the served model changed, which is
the one failure this check exists to catch.
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
    Run the live model and return its numbers for each text.

    Needs the model on disk -- run `npm run fetch-model` if it is missing. The
    error names the command, the same way the app does.
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
