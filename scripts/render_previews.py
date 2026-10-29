"""Render preview images of the built cubes with Cycles.

blender -b --factory-startup -P scripts/render_previews.py -- --sizes 3 4 5 6
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLEND_DIR = os.path.join(ROOT, "blend")
PREVIEW_DIR = os.path.join(ROOT, "previews")
HERO_DIRECTION = Vector((1.0, -1.3, 0.95)).normalized()


def setup_render(scene, samples):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
    except TypeError:
        scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 960
    # Same curve as three.js NeutralToneMapping, so colors match the WebGL viewer.
    scene.view_settings.view_transform = "Khronos PBR Neutral"


def setup_world(scene):
    world = bpy.data.worlds.new("Preview")
    if world.node_tree is None:
        world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()
    env = nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(
        os.path.join(bpy.utils.system_resource("DATAFILES"), "studiolights", "world", "interior.exr"))
    lit = nodes.new("ShaderNodeBackground")
    lit.inputs["Strength"].default_value = 1.2
    links.new(env.outputs["Color"], lit.inputs["Color"])
    backdrop = nodes.new("ShaderNodeBackground")
    backdrop.inputs["Color"].default_value = (0.32, 0.33, 0.35, 1)
    mix = nodes.new("ShaderNodeMixShader")
    links.new(nodes.new("ShaderNodeLightPath").outputs["Is Camera Ray"], mix.inputs["Fac"])
    links.new(lit.outputs["Background"], mix.inputs[1])
    links.new(backdrop.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes.new("ShaderNodeOutputWorld").inputs["Surface"])
    scene.world = world


def place_camera(scene, target, direction, distance, lens):
    cam = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    cam.data.lens = lens
    cam.location = target + direction * distance
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def turn_layer(root, gl_axis, index, degrees):
    bl_axis = ("X", "Z", "Y")[gl_axis]
    sign = -1 if gl_axis == 2 else 1
    rot = Matrix.Rotation(math.radians(degrees) * sign, 4, bl_axis)
    for cubie in root.children:
        if cubie["grid"][gl_axis] == index:
            cubie.matrix_basis = rot @ cubie.matrix_basis


def render(scene, name):
    scene.render.filepath = os.path.join(PREVIEW_DIR, name + ".png")
    bpy.ops.render.render(write_still=True)


def open_cube(n, samples):
    bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND_DIR, f"cube_{n}x{n}.blend"))
    scene = bpy.context.scene
    setup_render(scene, samples)
    setup_world(scene)
    return scene, bpy.data.objects[f"Cube{n}x{n}"]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", type=int, nargs="+", default=[3, 4, 5, 6])
    parser.add_argument("--samples", type=int, default=128)
    args = parser.parse_args(argv)
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    for n in args.sizes:
        scene, root = open_cube(n, args.samples)
        place_camera(scene, Vector(), HERO_DIRECTION, 5.4 * n, 85)
        render(scene, f"cube_{n}x{n}")

        turn_layer(root, 1, n - 1, 30)
        if n > 3:
            turn_layer(root, 1, 1, -20)
        render(scene, f"cube_{n}x{n}_turning")

        if n == 3:
            # Fine normal detail reads as noise to the denoiser at low sample counts.
            scene, root = open_cube(n, args.samples * 4)
            place_camera(scene, Vector((0.95, -1.45, 1.45)), Vector((0.75, -1.0, 0.85)).normalized(), 2.4, 85)
            render(scene, "cube_3x3_closeup")


main()
