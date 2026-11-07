# Tests and verification

Run commands from `C:\Users\mreca\Desktop\Game Development Studio`. Automated tests use temporary projects, substitute workers, or loopback services where practical; read a test before running it to understand what it starts. Existing external GPU engines and project files should not be stopped or altered for a test.

## JavaScript service and UI logic

```powershell
node --test 'test/*.test.js'
node node_modules\vite\bin\vite.js build
```

The suite covers queue persistence/recovery, lease fencing, model-load barriers, GPU-memory admission, worker protocols, project assets and trash, model inventory/removal, HTTP, and MCP. Tests that use fake engines establish protocol behavior; they do not prove real GPU generation or visual/audio quality. The build only checks bundling; it is not a visual accessibility or device-layout review.

To run a focused group, pass the filenames after `node --test`, for example `test/model-inventory.test.js`, `test/model-removal.test.js`, and `test/project-workflow-mcp.test.js`.

For World studio changes, `node --test test/world-queue.test.js test/world-mcp.test.js test/nav-queue-status.test.js` covers the queue adapter, MCP and page indicators using substitute services. The WorldGen LoRA and perspective-ray helpers and Windows memory guard also have Python unit tests; see [agent setup](../docs/AGENT_SETUP.md#4-validate-the-right-layer) for the commands and environment paths. These tests do not run full GPU inference.

## Native TRELLIS component suite

```powershell
cmd /c runtime\trellis-native-tests.cmd
```

This uses the current Visual Studio ARM64 and CUDA environment and checks CuMesh, FlexGEMM, O-Voxel, nvdiffrast, OpenCV preprocessing, sparse SDPA, and native imports. The CUDA component checks operate on small inputs; they do not load a full TRELLIS.2 checkpoint or generate a mesh. `runtime/trellis-native-probe.cmd` and `runtime/trellis-triton-probe.cmd` separately exercise a native CUDA kernel and a Triton GPU kernel.

## Real model checks

The following tests can load gigabytes of local weights and use the GPU. Check current free **system and GPU** memory and other running work before executing them. These checks use the installed Windows ARM64 Python environment and model files; they are not necessary for a docs-only change.

```powershell
& '.\.forge-runtime\trellis2-venv\Scripts\python.exe' '.\test\trellis_dinov3_cuda_test.py'
& '.\.forge-runtime\trellis2-venv\Scripts\python.exe' '.\test\trellis_pipeline_load_test.py'
```

The first loads and executes the real DINOv3 encoder on CUDA. The second loads the offline 512 TRELLIS.2 pipeline and runs its image encoder, but does **not** generate a 3D asset. Each test has its own minimum available system-memory check. Full TRELLIS.2 generation and its peak memory are still unverified. `test/trellis_backend_test.py` checks transparent-reference validation and parameter forwarding using a substitute renderer; it is not a real GPU render.

See the [model source guide](../docs/MODEL_SOURCES.md) for exact checkpoint locations and the [Windows build guide](../docs/WINDOWS_ARM64.md) for compiled dependency details.
