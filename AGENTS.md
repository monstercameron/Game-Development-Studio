# Working on Forge

Forge is a local React asset studio with a durable render queue and separately supervised model processes. Start with [agent setup](docs/AGENT_SETUP.md), the [runtime map](runtime/README.md), and the [test guide](test/README.md). Model origins, downloads, and platform patches are documented in [model sources](docs/MODEL_SOURCES.md) and [Windows ARM64 notes](docs/WINDOWS_ARM64.md).

## Boundaries

- Target native Windows ARM64 and NVIDIA CUDA for local inference; do not introduce WSL or silently fall back to CPU inference. CPU preprocessing and file operations are separate from inference.
- A source checkout alone does not contain model weights, compiled engines, external Desktop applications, Python environments, project assets, credentials, or runtime state. Do not describe it as a complete one-command model installation.
- Before starting, stopping, or loading a model, inspect live queue and service state. Preserve active jobs and unrelated applications; do not assume a documented process is still running or owned by Forge.
- Treat Windows commit/system memory and GPU memory as distinct constraints. Do not present a memory estimate or reachable service as proof of successful inference.
- Keep credentials, tokens, local databases, logs, generated assets, downloaded binaries, weights, and Python caches out of Git. Do not print or paste secrets or unreviewed private logs.
- Preserve durable queue semantics, project isolation, local-only service boundaries, and recoverable artifact deletion. Avoid making a network call or large download an implicit render side effect.

## Changes and validation

- Use existing design tokens and shared React patterns. Put navigable panels and dialog state in the URL where appropriate.
- Follow a request through UI, API validation, durable queue, worker, and artifact handling before claiming that a control is wired up. Maintain model-specific parameter semantics and copyable errors.
- Run focused tests for changed behavior and a production build for React changes. Use the commands in the test guide; read expensive GPU tests before running them.
- Separate substitute-worker tests, real GPU inference, and visual/audio quality checks in reports. Record the tested model, inputs, hardware and limitations; never claim a real render from a mock test.
- Update the relevant docs when model sources, required environment, platform workarounds, endpoints, or verification status change.
