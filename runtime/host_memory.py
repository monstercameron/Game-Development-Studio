"""Host RAM admission shared by the Forge workers.

The per-engine host budgets are uncalibrated estimates and weights are memory-mapped, so a busy
desktop must not block a job while the GPU has room. By default only a real shortage (below a
small floor) blocks. Set FORGE_HOST_MEMORY_POLICY=strict to enforce each engine's full budget.
"""

import os

HOST_MEMORY_FLOOR_BYTES = 2 * 1024**3


def host_bytes_needed(required_bytes):
    if os.environ.get("FORGE_HOST_MEMORY_POLICY", "").strip().lower() == "strict":
        return required_bytes
    return min(required_bytes, HOST_MEMORY_FLOOR_BYTES)
