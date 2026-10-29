"""Build NxN puzzle cubes as glTF binaries with one node per cubie.

blender -b --factory-startup -P scripts/build_cubes.py -- --sizes 3 4 5 6
"""
import argparse
import itertools
import math
import os
import struct
import sys
import zlib

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


def save_png(name, pixels):
    """Write an 8-bit gray or RGB PNG (row 0 = bottom, as in Blender) with per-row adaptive filtering.

    The glTF exporter embeds PNG sources byte-for-byte, so this encoder decides the .glb size.
    """
    a = np.round(np.clip(pixels, 0, 1) * 255).astype(np.int16)[::-1]
    if a.ndim == 2:
        a = a[..., None]
    h, w, c = a.shape
    x = a.reshape(h, w * c)
    left = np.zeros_like(x)
    left[:, c:] = x[:, :-c]
    up = np.zeros_like(x)
    up[1:] = x[:-1]
    up_left = np.zeros_like(x)
    up_left[1:, c:] = x[:-1, :-c]
    p = left + up - up_left
    pa, pb, pc = np.abs(p - left), np.abs(p - up), np.abs(p - up_left)
    paeth = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, up, up_left))
    filtered = np.stack([x, x - left, x - up, x - (left + up) // 2, x - paeth]) % 256
    cost = np.abs(filtered.astype(np.uint8).view(np.int8).astype(np.int32)).sum(2)
    best = cost.argmin(0)
    rows = filtered[best, np.arange(h)].astype(np.uint8)
    raw = np.concatenate([best[:, None].astype(np.uint8), rows], 1).tobytes()

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    header = struct.pack(">IIBBBBB", w, h, 8, {1: 0, 3: 2}[c], 0, 0, 0)
    with open(os.path.join(TEX_DIR, name + ".png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9))
                + chunk(b"IEND", b""))


def generate_textures():
    os.makedirs(TEX_DIR, exist_ok=True)
    rng = np.random.default_rng(1974)

    n = STICKER_TEX
    scr = scratches(rng, n, 50, (20, 450), 0.7)
    height = slope_scaled(noise(rng, n, 40), 0.006) + slope_scaled(noise(rng, n, 1.6), 0.007) - scr * 0.25
    save_png("sticker_normal", height_to_normal(height))
    save_png("sticker_orm", orm(0.17 + 0.07 * smoothstep(0.2, 1.6, noise(rng, n, 45)) + 0.3 * scr))
    save_png("sticker_albedo", 1 - 0.035 * smoothstep(-1.5, 1.5, noise(rng, n, 90))
             - 0.01 * smoothstep(-2, 2, noise(rng, n, 10)))

    n = BODY_TEX
    scr = scratches(rng, n, 25, (15, 300), 0.7)
    height = slope_scaled(noise(rng, n, 2.0), 0.018) + slope_scaled(noise(rng, n, 60), 0.004) - scr * 0.15
    save_png("plastic_normal", height_to_normal(height))
    save_png("plastic_orm", orm(0.42 + 0.05 * noise(rng, n, 70) + 0.18 * scr))


# --- materials ----------------------------------------------------------------

def image_node(nodes, name, colorspace):
    node = nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(os.path.join(TEX_DIR, name + ".png"), check_existing=True)
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

def build_cube(n):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    rng = np.random.default_rng(n)

    plastic = make_material("Plastic_Black", "plastic", PLASTIC_COLOR, albedo_texture=False)
    bodies = [build_body_mesh(f"CubieBody_{i}", rng, plastic) for i in range(BODY_VARIANTS)]
    stickers = {}
    for face, (_, color_name, hex_color) in FACES.items():
        mat = make_material(f"Sticker_{color_name.capitalize()}", "sticker",
                            srgb_hex_to_linear(hex_color), albedo_texture=True)
        stickers[face] = [build_sticker_mesh(f"Sticker_{color_name.capitalize()}_{i}", rng, mat)
                          for i in range(STICKER_VARIANTS)]

    root = bpy.data.objects.new(f"Cube{n}x{n}", None)
    root["size"] = n
    root["pitch"] = PITCH
    scene.collection.objects.link(root)

    offset = (n - 1) / 2
    for grid in itertools.product(range(n), repeat=3):
        faces = [f for f, (normal, _, _) in FACES.items()
                 if any(c and g == (n - 1 if c > 0 else 0) for c, g in zip(normal, grid))]
        if not faces:
            continue
        name = "Cubie_{}_{}_{}".format(*grid)
        cubie = bpy.data.objects.new(name, bodies[rng.integers(BODY_VARIANTS)])
        cubie.parent = root
        cubie.location = gl_to_bl([(g - offset) * PITCH for g in grid])
        cubie["grid"] = list(grid)
        cubie["stickers"] = "".join(faces)
        scene.collection.objects.link(cubie)

        for face in faces:
            normal, color_name, _ = FACES[face]
            sticker = bpy.data.objects.new(f"{name}_{face}", stickers[face][rng.integers(STICKER_VARIANTS)])
            sticker.parent = cubie
            sticker.location = gl_to_bl(normal) * BODY_HALF
            sticker.rotation_mode = "QUATERNION"
            sticker.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(gl_to_bl(normal))
            sticker["face"] = face
            sticker["color"] = color_name
            scene.collection.objects.link(sticker)

    os.makedirs(DIST_DIR, exist_ok=True)
    os.makedirs(BLEND_DIR, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(DIST_DIR, f"cube_{n}x{n}.glb"),
        export_format="GLB",
        export_extras=True,
        export_yup=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_image_format="AUTO",
    )
    for img in bpy.data.images:
        img.pack()
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BLEND_DIR, f"cube_{n}x{n}.blend"), compress=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", type=int, nargs="+", default=[3, 4, 5, 6])
    parser.add_argument("--regen-textures", action="store_true")
    args = parser.parse_args(argv)

    if args.regen_textures or not os.path.exists(os.path.join(TEX_DIR, "plastic_orm.png")):
        generate_textures()
    for n in args.sizes:
        build_cube(n)


main()
