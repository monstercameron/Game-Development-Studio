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

# Hole filling adds one vertex per boundary loop at the loop's centroid. An uninitialised CUB
# accumulator once offset every such vertex by garbage (z ~ 1e16), which later produced long
# "curtain" spikes in TRELLIS.2 meshes.
open_faces = faces[:3].contiguous()
mesh = cumesh.CuMesh()
mesh.init(vertices, open_faces)
mesh.fill_holes(max_hole_perimeter=10.0)
filled_vertices, filled_faces = mesh.read()
torch.cuda.synchronize()
assert filled_vertices.shape[0] == 5 and filled_faces.shape[0] == 6
expected = torch.full((3,), 1 / 3, device="cuda")
torch.testing.assert_close(filled_vertices[4], expected, atol=1e-5, rtol=0)
print("CuMesh hole filling placed the new vertex at the loop centroid.")
