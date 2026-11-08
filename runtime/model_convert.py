"""Convert a 3D model file to another format. Writes new files; never changes the input.

Run by runtime/transcode.js with the Hunyuan3D virtual environment's Python (it ships trimesh).
Input (JSON on stdin): source, directory, stem, format. Output (JSON on stdout): the files written
into `directory`, named from `stem`, and a short list of notes about what the format cannot hold.

Lossless where it can be: GLB <-> glTF only repackages the container, so animations, skins and
WebP textures survive. Everything else goes through trimesh and keeps the mesh and its colour:
OBJ also gets a .mtl and PNG textures, PLY gets vertex colours baked from the texture, STL is
geometry only.
"""

import base64
import io
import json
import struct
import sys
from pathlib import Path

SOURCE_FORMATS = {".glb": "glb", ".gltf": "gltf", ".obj": "obj", ".ply": "ply", ".stl": "stl"}
TARGET_FORMATS = ("glb", "gltf", "obj", "ply", "stl")
MAX_SOURCE_BYTES = 512 * 1024 * 1024
GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
MIME_BY_SUFFIX = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


class ConversionError(Exception):
    """A problem the user can act on; its message is shown as is."""


def read_glb(data):
    if len(data) < 20:
        raise ConversionError("The GLB file is too short.")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length > len(data):
        raise ConversionError("This is not a valid GLB 2.0 file.")
    document, binary, offset = None, b"", 12
    while offset + 8 <= length:
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + size]
        if kind == JSON_CHUNK:
            document = json.loads(chunk.decode("utf-8"))
        elif kind == BIN_CHUNK and not binary:
            binary = bytes(chunk)
        offset += 8 + size + (-size % 4)
    if document is None:
        raise ConversionError("The GLB file has no JSON chunk.")
    return document, binary


def write_glb(document, binary):
    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    chunks = struct.pack("<II", len(payload), JSON_CHUNK) + payload
    if binary:
        padded = binary + b"\0" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(padded), BIN_CHUNK) + padded
    return struct.pack("<III", GLB_MAGIC, 2, 12 + len(chunks)) + chunks


def read_uri(uri, folder):
    """Bytes of a glTF buffer or image: a data URI or a file inside the model's own folder."""
    if uri.startswith("data:"):
        header, _, payload = uri.partition(",")
        if ";base64" not in header:
            raise ConversionError("Only base64 data URIs are supported inside glTF files.")
        return base64.b64decode(payload)
    if "://" in uri or uri.startswith(("/", "\\")) or ".." in Path(uri).parts:
        raise ConversionError("The glTF file refers to a file outside its own folder.")
    path = (folder / uri).resolve()
    if folder.resolve() not in path.parents:
        raise ConversionError("The glTF file refers to a file outside its own folder.")
    if not path.is_file():
        raise ConversionError(f"The glTF file needs {uri}, which is missing next to it.")
    return path.read_bytes()


def glb_to_gltf(data):
    """One self-contained .gltf with the binary data embedded as a base64 data URI."""
    document, binary = read_glb(data)
    if binary:
        encoded = base64.b64encode(binary).decode("ascii")
        buffers = document.setdefault("buffers", [{}])
        buffers[0] = {
            "byteLength": len(binary),
            "uri": "data:application/octet-stream;base64," + encoded,
        }
    return json.dumps(document, separators=(",", ":")).encode("utf-8")


def gltf_to_glb(source):
    """One .glb: every buffer and image file is folded into the single binary chunk."""
    path = Path(source)
    document = json.loads(path.read_text(encoding="utf-8"))
    folder = path.parent
    combined = bytearray()
    starts = []
    for buffer in document.get("buffers", []):
        uri = buffer.get("uri")
        data = read_uri(uri, folder) if uri else b""
        combined += b"\0" * (-len(combined) % 4)
        starts.append(len(combined))
        combined += data
    views = document.setdefault("bufferViews", [])
    for view in views:
        view["byteOffset"] = view.get("byteOffset", 0) + starts[view["buffer"]]
        view["buffer"] = 0
    for image in document.get("images", []):
        uri = image.pop("uri", None)
        if uri is None:
            continue
        data = read_uri(uri, folder)
        combined += b"\0" * (-len(combined) % 4)
        views.append({"buffer": 0, "byteOffset": len(combined), "byteLength": len(data)})
        combined += data
        image["bufferView"] = len(views) - 1
        image.setdefault("mimeType", MIME_BY_SUFFIX.get(Path(uri).suffix.lower(), "image/png"))
    if document.get("buffers") or combined:
        document["buffers"] = [{"byteLength": len(combined)}]
    if not views:
        document.pop("bufferViews", None)
    return write_glb(document, bytes(combined))


def prepare_glb_for_trimesh(data):
    """TRELLIS.2 writes WebP textures with EXT_texture_webp and no fallback source. trimesh only
    reads `source`, so point it at the WebP image (Pillow decodes WebP regardless of the label)."""
    document, binary = read_glb(data)
    changed = False
    for texture in document.get("textures", []):
        webp = (texture.get("extensions") or {}).get("EXT_texture_webp", {})
        if "source" not in texture and "source" in webp:
            texture["source"] = webp["source"]
            changed = True
    return write_glb(document, binary) if changed else data


def load_mesh(source, trimesh):
    path = Path(source)
    kind = SOURCE_FORMATS.get(path.suffix.lower())
    if kind is None:
        raise ConversionError("This file type cannot be converted.")
    if path.stat().st_size > MAX_SOURCE_BYTES:
        raise ConversionError("The model is too large to convert (over 512 MiB).")
    if kind == "glb":
        loaded = trimesh.load(
            io.BytesIO(prepare_glb_for_trimesh(path.read_bytes())),
            file_type="glb",
            process=False,
        )
    else:
        loaded = trimesh.load(str(path), process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [item for item in loaded.dump() if isinstance(item, trimesh.Trimesh)]
        if not meshes:
            raise ConversionError("The file has no triangle mesh to convert.")
        mesh = meshes[0] if len(meshes) == 1 else trimesh.util.concatenate(meshes)
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise ConversionError(
            "This file holds points or a splat, not a triangle mesh, so it cannot be converted."
        )
    if not len(mesh.vertices) or not len(mesh.faces):
        raise ConversionError("The file has no triangle mesh to convert.")
    return mesh


def has_texture(mesh):
    visual = mesh.visual
    return getattr(visual, "kind", None) == "texture" and getattr(visual, "uv", None) is not None


def write_obj(mesh, directory, stem):
    """OBJ plus an MTL and the base-colour texture as PNG, all named after `stem`."""
    from trimesh.exchange.obj import export_obj

    text, extras = export_obj(
        mesh,
        include_color=False,
        include_texture=True,
        return_texture=True,
        write_texture=False,
        mtl_name=f"{stem}.mtl",
        header=None,
    )
    names = {}
    for name in extras:
        if name.lower().endswith(".png"):
            names[name] = f"{stem}-texture-{len(names)}.png"
    files = []
    for name, data in extras.items():
        if name in names:
            (directory / names[name]).write_bytes(data)
            files.append({"name": names[name], "role": "texture"})
        else:
            mtl = data.decode("utf-8")
            for old, new in names.items():
                mtl = mtl.replace(old, new)
            (directory / name).write_text(mtl, encoding="utf-8")
            files.append({"name": name, "role": "material"})
    (directory / f"{stem}.obj").write_text(text, encoding="utf-8")
    return [{"name": f"{stem}.obj", "role": "main"}, *files]


def convert(source, directory, stem, target):
    if target not in TARGET_FORMATS:
        raise ConversionError("Choose a supported 3D format.")
    directory = Path(directory)
    source_kind = SOURCE_FORMATS.get(Path(source).suffix.lower())
    if source_kind == target:
        raise ConversionError("The file is already in that format.")
    notes = []
    if source_kind == "glb" and target == "gltf":
        (directory / f"{stem}.gltf").write_bytes(glb_to_gltf(Path(source).read_bytes()))
        return {
            "backend": "container repackage",
            "files": [{"name": f"{stem}.gltf", "role": "main"}],
            "notes": notes,
        }
    if source_kind == "gltf" and target == "glb":
        (directory / f"{stem}.glb").write_bytes(gltf_to_glb(source))
        return {
            "backend": "container repackage",
            "files": [{"name": f"{stem}.glb", "role": "main"}],
            "notes": notes,
        }
    import trimesh

    mesh = load_mesh(source, trimesh)
    textured = has_texture(mesh)
    if target == "obj":
        files = write_obj(mesh, directory, stem)
        if textured:
            notes.append(
                "OBJ keeps the base-colour texture; metallic and roughness maps are dropped."
            )
    elif target == "ply":
        if textured:
            mesh = mesh.copy()
            mesh.visual = mesh.visual.to_color()
            notes.append("PLY has no textures, so the texture was baked into vertex colours.")
        (directory / f"{stem}.ply").write_bytes(mesh.export(file_type="ply"))
        files = [{"name": f"{stem}.ply", "role": "main"}]
    elif target == "stl":
        (directory / f"{stem}.stl").write_bytes(mesh.export(file_type="stl"))
        files = [{"name": f"{stem}.stl", "role": "main"}]
        notes.append("STL holds geometry only; colours and textures are dropped.")
    else:
        # A mesh format (OBJ, PLY, STL) to glTF: export a GLB, then embed it for .gltf.
        data = trimesh.Scene(mesh).export(file_type="glb")
        if target == "gltf":
            data = glb_to_gltf(data)
        (directory / f"{stem}.{target}").write_bytes(data)
        files = [{"name": f"{stem}.{target}", "role": "main"}]
    return {"backend": f"trimesh {trimesh.__version__}", "files": files, "notes": notes}


def main():
    request = json.load(sys.stdin)
    try:
        result = convert(
            request["source"], request["directory"], request["stem"], request["format"]
        )
    except ConversionError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # Any parser failure becomes one readable line.
        print(f"Could not convert this model: {str(error).splitlines()[0][:300]}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
