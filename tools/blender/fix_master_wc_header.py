"""Close the wall above the master ensuite WC door in the v16 .blend.

Run in Blender with 27PR_CGI_v16_hidden_door_placed.blend open:
Scripting workspace -> Open this file -> Run Script.
Or from a shell:
    blender 27PR_CGI_v16_hidden_door_placed.blend --background --python fix_master_wc_header.py

The partition Wall_FF_Master_DryWet stops at the WC door jamb, so the space
from the WC door frame head up to the ceiling is open. The coving on both
faces of the partition also stops at the wall end.

The script:
  1. adds Wall_FF_Master_DryWet_Header, a box of the same thickness and material as
     the partition, from the door frame head to the top of the partition, and from
     the partition end to the side wall face;
  2. moves the square-cut ends of CGI_Coving90x60_Profile_398 / _402 to the side
     wall face, so the coving runs across the doorway;
  3. hides CGI_Coving90x60_Profile_400, the return at the old wall end, which is
     now buried inside the wall;
  4. saves the result as a new file (..._v17_wc_header.blend) beside the source.
     The source file is not overwritten.

Every measurement comes from the objects in the file. Before changing anything
it checks them against the values measured from the web export and stops if
they differ by more than 2 cm.
"""
import os

import bmesh
import bpy
from mathutils import Vector

WALL = "Wall_FF_Master_DryWet"
SIDE_WALLS = ("Wall_FF_013_V2", "Wall_FF_014_V2")
COVES = ("CGI_Coving90x60_Profile_398", "CGI_Coving90x60_Profile_402")
COVE_RETURN = "CGI_Coving90x60_Profile_400"
HEADER = "Wall_FF_Master_DryWet_Header"
# Top of the WC door frame head (F25 frame), Blender world Z, from the web export.
DOOR_HEAD_TOP_Z = 5.1872
# Blender world values measured from the web export, used only as a sanity check.
EXPECT = {"wall_end_x": 0.343, "wall_y0": 1.310, "wall_y1": 1.430, "wall_top_z": 5.706, "side_face_x": 1.083}
TOL = 0.02


def obj(name):
    o = bpy.data.objects.get(name)
    if o is None:
        raise SystemExit("Object not found: %s" % name)
    return o


def world_bounds(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    pts = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    return Vector([min(p[i] for p in pts) for i in range(3)]), Vector([max(p[i] for p in pts) for i in range(3)])


def check(label, got):
    want = EXPECT[label]
    print("  %-12s %.4f (expected %.3f)" % (label, got, want))
    if abs(got - want) > TOL:
        raise SystemExit("%s is %.4f, expected about %.3f. The file does not match the v16 export; nothing was changed." % (label, got, want))


if HEADER in bpy.data.objects:
    raise SystemExit("%s already exists; this file is already fixed." % HEADER)

wall = obj(WALL)
wmin, wmax = world_bounds(wall)
side_face_x = min(world_bounds(obj(n))[0].x for n in SIDE_WALLS)
print("Measured:")
check("wall_end_x", wmax.x)
check("wall_y0", wmin.y)
check("wall_y1", wmax.y)
check("wall_top_z", wmax.z)
check("side_face_x", side_face_x)

# 1. Header over the WC door.
x0, x1 = wmax.x, side_face_x
y0, y1 = wmin.y, wmax.y
z0, z1 = DOOR_HEAD_TOP_Z, wmax.z
me = bpy.data.meshes.new(HEADER)
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
for v in bm.verts:
    v.co = Vector((x0 if v.co.x < 0 else x1, y0 if v.co.y < 0 else y1, z0 if v.co.z < 0 else z1))
# Box-project UVs at 1 m per unit, like the walls.
uv = bm.loops.layers.uv.new("UVMap")
for f in bm.faces:
    n = f.normal
    a, b = (1, 2) if abs(n.x) >= max(abs(n.y), abs(n.z)) else (0, 2) if abs(n.y) >= abs(n.z) else (0, 1)
    for loop in f.loops:
        loop[uv].uv = (loop.vert.co[a], loop.vert.co[b])
bm.to_mesh(me)
bm.free()
for m in wall.data.materials if wall.type == "MESH" else []:
    me.materials.append(m)
header = bpy.data.objects.new(HEADER, me)
for c in wall.users_collection:
    c.objects.link(header)
for k in wall.keys():  # carry the export tags (solid, walkSurface, ...) over
    if k not in ("_RNA_UI",):
        header[k] = wall[k]
print("Added %s: x %.3f..%.3f  y %.3f..%.3f  z %.3f..%.3f" % (HEADER, x0, x1, y0, y1, z0, z1))

# 2. Run the coving to the side wall face.
for name in COVES:
    o = obj(name)
    mw, mi = o.matrix_world, o.matrix_world.inverted()
    if o.type == "MESH":
        if o.data.users > 1:
            o.data = o.data.copy()
        vs = o.data.vertices
        end = max((mw @ v.co).x for v in vs)
        moved = 0
        for v in vs:
            p = mw @ v.co
            if abs(p.x - end) < 1e-4:
                p.x = side_face_x
                v.co = mi @ p
                moved += 1
        o.data.update()
    elif o.type == "CURVE":
        if o.data.users > 1:
            o.data = o.data.copy()
        pts = [p for s in o.data.splines for p in list(s.bezier_points) + list(s.points)]
        co = lambda p: mw @ Vector(p.co[:3])
        end = max(co(p).x for p in pts)
        moved = 0
        for p in pts:
            w = co(p)
            if abs(w.x - end) < 1e-4:
                w.x = side_face_x
                if hasattr(p, "handle_left"):
                    d = w - co(p)
                    p.handle_left = mi @ (mw @ p.handle_left + d)
                    p.handle_right = mi @ (mw @ p.handle_right + d)
                    p.co = mi @ w
                else:
                    p.co = tuple(mi @ w) + (p.co[3],)
                moved += 1
    else:
        raise SystemExit("%s is a %s; expected a mesh or curve." % (name, o.type))
    print("Extended %s end from x %.3f to %.3f (%d points)" % (name, end, side_face_x, moved))

# 3. The return at the old wall end is inside the wall now.
ret = bpy.data.objects.get(COVE_RETURN)
if ret is not None:
    ret.hide_render = True
    ret.hide_viewport = True
    print("Hid %s" % COVE_RETURN)

# 4. Save as a new file.
src = bpy.data.filepath
if src:
    out = os.path.join(os.path.dirname(src), "27PR_CGI_v17_wc_header.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print("Saved %s" % out)
else:
    print("File has never been saved; save it yourself.")
