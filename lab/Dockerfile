# The portability half of this workspace. The PRIMARY environment is the host
# (`uv sync` + `uv run jupyter lab`), because Docker on macOS cannot pass
# through the Apple GPU — a container here is CPU-only. See README.md.
#
# Built from the SAME uv.lock as the host, so package versions cannot drift.
# The one thing that does differ is the torch wheel: linux-aarch64 here,
# macos-arm64 on the host. "It worked in the container" is therefore not proof
# it works natively, and vice versa.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

WORKDIR /workspace

# Dependencies get their own layer: editing a notebook must never trigger a
# reinstall of torch.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

EXPOSE 8888

# --ServerApp.token='' is safe only because the port is published to
# 127.0.0.1 in compose.yaml. Do not expose this to a network.
CMD ["jupyter", "lab", \
     "--ip=0.0.0.0", \
     "--port=8888", \
     "--no-browser", \
     "--allow-root", \
     "--ServerApp.root_dir=/workspace", \
     "--ServerApp.token=", \
     "--ServerApp.password="]
