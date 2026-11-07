"""Exercise the compiled Windows ARM64 CuMesh CUDA extension."""

import cumesh
import torch

assert torch.cuda.is_available(), "CUDA is required."
vertices = torch.tensor(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=torch.float32, device="cuda"
)
faces = torch.tensor([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]], dtype=torch.int32, device="cuda")
mesh = cumesh.CuMesh()
mesh.init(vertices, faces)
mesh.compute_face_normals()
normals = mesh.read_face_normals()
torch.cuda.synchronize()
assert normals.is_cuda and normals.shape == (4, 3)
torch.testing.assert_close(torch.linalg.vector_norm(normals, dim=1), torch.ones(4, device="cuda"))
print("CuMesh face normals passed on CUDA.")
