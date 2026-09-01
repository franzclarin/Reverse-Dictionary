# The portable half of this workspace. The primary environment is the host
# machine, because Docker on macOS cannot reach the Apple GPU — a container here
# uses the CPU only. See README.md.
#
# Built from the same locked versions as the host, so packages cannot drift. The
# one thing that does differ is which build of the machine-learning library gets
# installed, so "it worked in the container" is not proof it works natively, or
# the other way round.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

WORKDIR /workspace

# Dependencies get their own layer: editing a notebook must never trigger a
# reinstall of everything.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

# A login shell resets the path, so opening one would silently get the base
# image's python with none of the packages. Many editors and terminals open a
# login shell by default.
RUN printf 'export PATH=/opt/venv/bin:$PATH\n' > /etc/profile.d/10-venv.sh

# Register it under the same name the host uses, so a committed notebook opens
# without asking which environment to use.
RUN python -m ipykernel install --name reverse-dictionary-lab \
        --display-name "reverse-dictionary-lab" --prefix /opt/venv

EXPOSE 8888

# Running without a password is safe only because the port is restricted to this
# machine. Do not expose this to a network.
CMD ["jupyter", "lab", \
     "--ip=0.0.0.0", \
     "--port=8888", \
     "--no-browser", \
     "--allow-root", \
     "--ServerApp.root_dir=/workspace", \
     "--ServerApp.token=", \
     "--ServerApp.password="]
