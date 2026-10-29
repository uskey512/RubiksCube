"""Build NxN puzzle cubes as glTF files with one node per cubie.

blender -b --factory-startup -P scripts/build_cubes.py -- --sizes 3 4 5 6 10 15 20

Every size uses the same part meshes and textures, so they are written once (dist/cube_parts.bin,
textures/*.webp) and each dist/cube_NxN.gltf only says which part goes where.
"""
import argparse
import itertools
import json
import math
import os
import shutil
import sys
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_DIR = os.path.join(ROOT, "textures")
DIST_DIR = os.path.join(ROOT, "dist")
BLEND_DIR = os.path.join(ROOT, "blend")

PITCH = 1.0
BODY_HALF = 0.4975
BODY_BEVEL = 0.06
BODY_SEGMENTS = 5
BODY_VARIANTS = 6
BODY_TEX = 1024

STICKER_HALF = 0.425
STICKER_RADIUS = 0.07
STICKER_THICKNESS = 0.006
STICKER_EDGE = 0.0025
STICKER_CORNER_SEGMENTS = 8
STICKER_EDGE_SEGMENTS = 3
STICKER_VARIANTS = 8
STICKER_TEX = 2048
STICKER_UV_SPAN = 0.5
PARTS_SEED = 7

# Face letters and normals are in glTF space: +Y up, +Z toward the viewer.
FACES = {
    "R": ((1, 0, 0), "red", "CC1A1A"),
    "L": ((-1, 0, 0), "orange", "FF5800"),
    "U": ((0, 1, 0), "white", "F4F4F0"),
    "D": ((0, -1, 0), "yellow", "FFD500"),
    "F": ((0, 0, 1), "green", "009B48"),
    "B": ((0, 0, -1), "blue", "0046AD"),
}
PLASTIC_COLOR = (0.016, 0.016, 0.017)


def gl_to_bl(v):
    return Vector((v[0], -v[2], v[1]))


def srgb_hex_to_linear(hex_color):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(lin(int(hex_color[i:i + 2], 16) / 255) for i in (0, 2, 4))


# --- textures -----------------------------------------------------------------

def periodic_blur(a, sigma):
    f = np.fft.fftfreq(a.shape[0])
    k2 = f[:, None] ** 2 + f[None, :] ** 2
    return np.fft.ifft2(np.fft.fft2(a) * np.exp(-2 * (np.pi * sigma) ** 2 * k2)).real


def noise(rng, n, sigma):
    a = periodic_blur(rng.standard_normal((n, n)), sigma)
    return (a - a.mean()) / a.std()


def scratches(rng, n, count, length, sigma):
    pts, wts = [], []
    for _ in range(count):
        steps = max(2, int(rng.uniform(*length) * 2))
        heading = rng.uniform(0, 2 * np.pi) + np.cumsum(rng.normal(0, 0.004, steps))
        pts.append(rng.uniform(0, n, 2) + np.cumsum(0.5 * np.stack([np.cos(heading), np.sin(heading)], 1), 0))
        wts.append(rng.uniform(0.15, 1.0) ** 2 * np.sin(np.linspace(0, np.pi, steps)) ** 0.5)
    xy, w = np.concatenate(pts), np.concatenate(wts)
    i0 = np.floor(xy).astype(int)
    f = xy - i0
    field = np.zeros((n, n))
    for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        wy = f[:, 1] if dy else 1 - f[:, 1]
        np.add.at(field, ((i0[:, 1] + dy) % n, (i0[:, 0] + dx) % n), w * wx * wy)
    # Strokes deposit 2 samples per pixel; rescale so a full-strength stroke peaks at 1 after the blur.
    return np.clip(periodic_blur(field, sigma) * sigma * math.sqrt(2 * math.pi) / 2, 0, 1)


def slope_scaled(h, slope):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    return h * slope / gx.std()


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def height_to_normal(h):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nrm = np.stack([-dx, -dy, np.ones_like(h)], -1)
    return nrm / np.linalg.norm(nrm, axis=-1, keepdims=True) * 0.5 + 0.5


def orm(roughness):
    r = np.clip(roughness, 0.05, 1.0)
    return np.stack([np.ones_like(r), r, np.zeros_like(r)], -1)


def save_webp(name, pixels):
    """Write a texture as lossless WebP. Row 0 is the bottom, as in Blender.

    Lossy WebP is far smaller, but its error is as large as the normal maps' fine relief.
    """
    # Round to 8-bit steps here so Blender stores exactly these values.
    a = (np.round(np.clip(pixels, 0, 1) * 255) / 255).astype(np.float32)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, -1)
    h, w, _ = a.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.concatenate([a, np.ones((h, w, 1), np.float32)], -1).ravel())
    img.file_format = "WEBP"
    img.save(filepath=os.path.join(TEX_DIR, name + ".webp"), quality=100)
    bpy.data.images.remove(img)


def generate_textures():
    os.makedirs(TEX_DIR, exist_ok=True)
    rng = np.random.default_rng(1974)

    n = STICKER_TEX
    scr = scratches(rng, n, 50, (20, 450), 0.7)
    height = slope_scaled(noise(rng, n, 40), 0.006) + slope_scaled(noise(rng, n, 1.6), 0.007) - scr * 0.25
    save_webp("sticker_normal", height_to_normal(height))
    save_webp("sticker_orm", orm(0.17 + 0.07 * smoothstep(0.2, 1.6, noise(rng, n, 45)) + 0.3 * scr))
    save_webp("sticker_albedo", 1 - 0.035 * smoothstep(-1.5, 1.5, noise(rng, n, 90))
             - 0.01 * smoothstep(-2, 2, noise(rng, n, 10)))

    n = BODY_TEX
    scr = scratches(rng, n, 25, (15, 300), 0.7)
    height = slope_scaled(noise(rng, n, 2.0), 0.018) + slope_scaled(noise(rng, n, 60), 0.004) - scr * 0.15
    save_webp("plastic_normal", height_to_normal(height))
    save_webp("plastic_orm", orm(0.42 + 0.05 * noise(rng, n, 70) + 0.18 * scr))


# --- materials ----------------------------------------------------------------

def image_node(nodes, name, colorspace):
    node = nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(os.path.join(TEX_DIR, name + ".webp"), check_existing=True)
    node.image.colorspace_settings.name = colorspace
    return node


def make_material(name, tex_prefix, color, albedo_texture):
    mat = bpy.data.materials.new(name)
    mat.use_backface_culling = True
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])

    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(image_node(nodes, tex_prefix + "_orm", "Non-Color").outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(image_node(nodes, tex_prefix + "_normal", "Non-Color").outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    if albedo_texture:
        mix = nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        ins = {s.identifier: s for s in mix.inputs}
        ins["Factor_Float"].default_value = 1.0
        links.new(image_node(nodes, tex_prefix + "_albedo", "sRGB").outputs["Color"], ins["A_Color"])
        ins["B_Color"].default_value = (*color, 1.0)
        links.new({s.identifier: s for s in mix.outputs}["Result_Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    return mat


# --- meshes -------------------------------------------------------------------

def build_body_mesh(name, rng, material):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2 * BODY_HALF)
    bmesh.ops.bevel(bm, geom=bm.verts[:] + bm.edges[:], offset=BODY_BEVEL, segments=BODY_SEGMENTS,
                    profile=0.5, affect="EDGES")
    bm.normal_update()
    uv = bm.loops.layers.uv.new("UVMap")
    offsets = rng.uniform(0, 1, (6, 2))
    for face in bm.faces:
        n = face.normal
        axis = max(range(3), key=lambda i: abs(n[i]))
        sign = 1 if n[axis] > 0 else -1
        # The big faces stay flat-shaded so they do not inherit the tilt of the bevel normals.
        face.smooth = abs(n[axis]) < 0.9999
        u_axis, v_axis = (i for i in range(3) if i != axis)
        off = offsets[axis * 2 + (sign > 0)]
        for loop in face.loops:
            co = loop.vert.co
            loop[uv].uv = (co[u_axis] * sign + off[0], co[v_axis] + off[1])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return me


def build_sticker_mesh(name, rng, material):
    corner = STICKER_HALF - STICKER_RADIUS
    profile = [(STICKER_EDGE * (1 - math.sin(t)), STICKER_THICKNESS - STICKER_EDGE * (1 - math.cos(t)))
               for t in np.linspace(0, math.pi / 2, STICKER_EDGE_SEGMENTS + 1)]
    # Sunk slightly into the body so no light leaks under the sticker edge.
    profile.append((0.0, -0.001))

    bm = bmesh.new()
    rings = []
    for inset, z in profile:
        r = STICKER_RADIUS - inset
        ring = []
        for qx, qy, start in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
            for k in range(STICKER_CORNER_SEGMENTS + 1):
                a = math.radians(start + 90 * k / STICKER_CORNER_SEGMENTS)
                ring.append(bm.verts.new((qx * corner + r * math.cos(a), qy * corner + r * math.sin(a), z)))
        rings.append(ring)

    center = bm.verts.new((0, 0, STICKER_THICKNESS))
    m = len(rings[0])
    for i in range(m):
        bm.faces.new((center, rings[0][i], rings[0][(i + 1) % m])).smooth = False
    for upper, lower in zip(rings, rings[1:]):
        for i in range(m):
            j = (i + 1) % m
            bm.faces.new((upper[i], lower[i], lower[j], upper[j])).smooth = True

    uv = bm.loops.layers.uv.new("UVMap")
    off = rng.uniform(0, 1, 2)
    turns = int(rng.integers(4))
    scale = STICKER_UV_SPAN / (2 * STICKER_HALF)
    for face in bm.faces:
        for loop in face.loops:
            x, y = loop.vert.co.x, loop.vert.co.y
            for _ in range(turns):
                x, y = -y, x
            loop[uv].uv = (x * scale + off[0], y * scale + off[1])

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return me


# --- assembly -----------------------------------------------------------------

def build_parts():
    """The materials and every mesh variant. They are the same for every size."""
    rng = np.random.default_rng(PARTS_SEED)
    plastic = make_material("Plastic_Black", "plastic", PLASTIC_COLOR, albedo_texture=False)
    bodies = [build_body_mesh(f"CubieBody_{i}", rng, plastic) for i in range(BODY_VARIANTS)]
    stickers = {}
    for face, (_, color_name, hex_color) in FACES.items():
        mat = make_material(f"Sticker_{color_name.capitalize()}", "sticker",
                            srgb_hex_to_linear(hex_color), albedo_texture=True)
        stickers[face] = [build_sticker_mesh(f"Sticker_{color_name.capitalize()}_{i}", rng, mat)
                          for i in range(STICKER_VARIANTS)]
    return bodies, stickers


def layout(n):
    """The outer cubies of an NxN cube as (grid, body variant, [(face, sticker variant), ...])."""
    rng = np.random.default_rng(n)
    for grid in itertools.product(range(n), repeat=3):
        faces = [f for f, (normal, _, _) in FACES.items()
                 if any(c and g == (n - 1 if c > 0 else 0) for c, g in zip(normal, grid))]
        if faces:
            body = int(rng.integers(BODY_VARIANTS))
            yield grid, body, [(face, int(rng.integers(STICKER_VARIANTS))) for face in faces]


def export_parts(bodies, stickers):
    """Export every mesh once and return the glTF document minus its nodes, for the sizes to share."""
    scene = bpy.context.scene
    for me in [*bodies, *(m for variants in stickers.values() for m in variants)]:
        scene.collection.objects.link(bpy.data.objects.new(me.name, me))
    with tempfile.TemporaryDirectory() as tmp:
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(tmp, "cube_parts.gltf"),
            export_format="GLTF_SEPARATE",
            export_yup=True,
            export_tangents=False,
            export_cameras=False,
            export_lights=False,
            export_image_format="AUTO",
        )
        with open(os.path.join(tmp, "cube_parts.gltf")) as f:
            doc = json.load(f)
        (buffer,) = doc["buffers"]
        shutil.copyfile(os.path.join(tmp, buffer["uri"]), os.path.join(DIST_DIR, "cube_parts.bin"))
    for obj in list(scene.collection.objects):
        bpy.data.objects.remove(obj)

    buffer["uri"] = "cube_parts.bin"
    # Point at the shared lossless textures instead of the exporter's re-encoded copies.
    for image in doc["images"]:
        image["uri"] = "../textures/" + os.path.splitext(os.path.basename(image["uri"]))[0] + ".webp"
    for texture in doc["textures"]:
        source = texture.pop("source", None)
        webp = texture.setdefault("extensions", {}).setdefault("EXT_texture_webp", {})
        webp.setdefault("source", source)
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted(set(doc.get(key, [])) | {"EXT_texture_webp"})
    for key in ("scene", "scenes", "nodes"):
        doc.pop(key, None)
    return doc


def number(v):
    return int(v) if float(v).is_integer() else round(float(v), 7)


def write_gltf(n, parts):
    """An NxN cube as nodes over the shared parts."""
    mesh_index = {m["name"]: i for i, m in enumerate(parts["meshes"])}
    s = round(math.sqrt(0.5), 7)
    # Turns the sticker meshes, which face +Y, toward each face.
    rotations = {"R": [0, 0, -s, s], "L": [0, 0, s, s], "U": None, "D": [1, 0, 0, 0], "F": [s, 0, 0, s], "B": [-s, 0, 0, s]}
    offset = (n - 1) / 2
    root = {"name": f"Cube{n}x{n}", "extras": {"size": n, "pitch": PITCH}, "children": []}
    nodes = [root]
    for grid, body, faces in layout(n):
        name = "Cubie_{}_{}_{}".format(*grid)
        cubie = {"name": name, "mesh": mesh_index[f"CubieBody_{body}"],
                 "translation": [number((g - offset) * PITCH) for g in grid],
                 "extras": {"grid": list(grid), "stickers": "".join(f for f, _ in faces)}, "children": []}
        root["children"].append(len(nodes))
        nodes.append(cubie)
        for face, variant in faces:
            normal, color_name, _ = FACES[face]
            sticker = {"name": f"{name}_{face}", "mesh": mesh_index[f"Sticker_{color_name.capitalize()}_{variant}"],
                       "translation": [number(c * BODY_HALF) for c in normal], "extras": {"face": face, "color": color_name}}
            if rotations[face]:
                sticker["rotation"] = rotations[face]
            cubie["children"].append(len(nodes))
            nodes.append(sticker)
    doc = {"asset": parts["asset"], **{k: v for k, v in parts.items() if k != "asset"},
           "scene": 0, "scenes": [{"name": "Scene", "nodes": [0]}], "nodes": nodes}
    with open(os.path.join(DIST_DIR, f"cube_{n}x{n}.gltf"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))


def build_blend(n, bodies, stickers):
    """The same cube as a Blender scene for editing; textures stay in textures/."""
    scene = bpy.context.scene
    root = bpy.data.objects.new(f"Cube{n}x{n}", None)
    root["size"] = n
    root["pitch"] = PITCH
    scene.collection.objects.link(root)
    offset = (n - 1) / 2
    for grid, body, faces in layout(n):
        name = "Cubie_{}_{}_{}".format(*grid)
        cubie = bpy.data.objects.new(name, bodies[body])
        cubie.parent = root
        cubie.location = gl_to_bl([(g - offset) * PITCH for g in grid])
        cubie["grid"] = list(grid)
        cubie["stickers"] = "".join(f for f, _ in faces)
        scene.collection.objects.link(cubie)
        for face, variant in faces:
            normal, color_name, _ = FACES[face]
            sticker = bpy.data.objects.new(f"{name}_{face}", stickers[face][variant])
            sticker.parent = cubie
            sticker.location = gl_to_bl(normal) * BODY_HALF
            sticker.rotation_mode = "QUATERNION"
            sticker.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(gl_to_bl(normal))
            sticker["face"] = face
            sticker["color"] = color_name
            scene.collection.objects.link(sticker)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND_DIR, f"cube_{n}x{n}.blend"), compress=True)
    # Texture paths only become relative once the file has a location.
    bpy.ops.file.make_paths_relative()
    bpy.ops.wm.save_mainfile(compress=True)
    for obj in [root, *root.children_recursive]:
        bpy.data.objects.remove(obj)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", type=int, nargs="+", default=[3, 4, 5, 6, 10, 15, 20])
    parser.add_argument("--regen-textures", action="store_true")
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if args.regen_textures or not os.path.exists(os.path.join(TEX_DIR, "plastic_orm.webp")):
        generate_textures()
    os.makedirs(DIST_DIR, exist_ok=True)
    os.makedirs(BLEND_DIR, exist_ok=True)
    bodies, stickers = build_parts()
    parts = export_parts(bodies, stickers)
    for n in args.sizes:
        write_gltf(n, parts)
        build_blend(n, bodies, stickers)


main()
