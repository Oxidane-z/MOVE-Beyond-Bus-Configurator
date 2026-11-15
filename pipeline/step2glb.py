#!/usr/bin/env python3
"""把 ECAD 导出的 PCB STEP 转成查看器用的 GLB。

元器件按占板尺寸分三档：
  large  完整三角化，保留 B-rep 棱线
  medium 简化成包围盒，带棱线
  small  压平成贴在板面上的色块，不带棱线

输出 <out>.glb（网格与线段）和 <out>.json（板尺寸与元器件清单）。

用法：
  python pipeline/step2glb.py cad/board.step public/models/board
"""
import argparse
import json
import math
import struct
import sys

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GeomAbs import GeomAbs_Plane
from OCP.GeomLProp import GeomLProp_SLProps
from OCP.gp import gp_Pnt
from OCP.Quantity import Quantity_Color
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

try:  # OCP 8 把序列类型移到了 collections
    from OCP.collections import Sequence_TDF_Label as LabelSeq
except ImportError:
    from OCP.TDF import TDF_LabelSequence as LabelSeq

DEFAULT_COLOR = (0.6, 0.6, 0.6)
SMOOTH_ANGLE = math.radians(20)   # 两面夹角小于此值的棱不画线
MIN_SOLID = 0.6                   # large 件内部小于此尺寸的实体（焊球等）丢弃
MIN_HOLE_EDGE = 2.2               # 板上小于此尺寸的闭合棱（过孔）不画线
MIN_EDGE = 0.35                   # 短于此长度的棱不画线，屏幕上不足一两个像素
THIN_SOLID = 0.45                 # 第二长边小于此值的实体（引脚）简化成不描边的包围盒
ANGULAR_DEFL = 0.9                # 三角化角度偏差（弧度）


# ---------- XCAF 辅助 ----------

def label_name(label):
    n = TDataStd_Name()
    return n.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), n) else ''


def bbox(shape):
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b)
    lo, hi = b.CornerMin(), b.CornerMax()
    return np.array([lo.X(), lo.Y(), lo.Z()]), np.array([hi.X(), hi.Y(), hi.Z()])


def trsf_matrix(loc):
    t = loc.Transformation()
    m = np.eye(4)
    for r in range(3):
        for c in range(4):
            m[r, c] = t.Value(r + 1, c + 1)
    return m


def explore(shape, kind):
    e = TopExp_Explorer(shape, kind)
    while e.More():
        yield e.Current()
        e.Next()


class Colors:
    def __init__(self, tool):
        self.tool = tool

    def of(self, target):
        c = Quantity_Color()
        for t in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
            try:
                if self.tool.GetColor(target, t, c):
                    return (c.Red(), c.Green(), c.Blue())   # OCC 内部颜色是线性空间
            except Exception:
                pass
        return None


# ---------- 三角化与棱线 ----------

def face_normal_fn(face):
    surf = BRep_Tool.Surface_s(face)
    flip = -1.0 if face.Orientation() == TopAbs_REVERSED else 1.0

    def normal(u, v):
        p = GeomLProp_SLProps(surf, u, v, 1, 1e-6)
        if not p.IsNormalDefined():
            return None
        d = p.Normal()
        return np.array([d.X(), d.Y(), d.Z()]) * flip
    return normal


def tessellate(shape, colors, base_color, lin_defl, skip_small=None, hole_edge=None):
    """返回 (positions, normals, colors, indices, edge_segments)，坐标在 shape 自身坐标系。"""
    BRepMesh_IncrementalMesh(shape, lin_defl, False, ANGULAR_DEFL, True)
    P, N, C, I, E = [], [], [], [], []
    base = 0

    solids = list(explore(shape, TopAbs_SOLID)) or [shape]
    for solid in solids:
        lo, hi = bbox(solid)
        dims = np.sort(hi - lo)
        if skip_small is not None and dims[2] < skip_small:
            continue
        solid_color = colors.of(solid) or base_color

        if skip_small is not None and dims[1] < THIN_SOLID:
            pin_color = solid_color
            if colors.of(solid) is None:
                pin_color = next((c for c in (colors.of(f) for f in explore(solid, TopAbs_FACE)) if c), solid_color)
            bp, bn, bc, bi, _ = box_mesh(lo, hi, np.eye(4), pin_color)
            P.append(bp)
            N.append(bn)
            C.append(bc)
            I.extend((bi + base).tolist())
            base += len(bp)
            continue

        for f in explore(solid, TopAbs_FACE):
            face = TopoDS.Face_s(f)
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is None:
                continue
            m = trsf_matrix(loc)
            n_nodes = tri.NbNodes()
            pts = np.array([[tri.Node(i).X(), tri.Node(i).Y(), tri.Node(i).Z()] for i in range(1, n_nodes + 1)])
            pts = pts @ m[:3, :3].T + m[:3, 3]

            normal = face_normal_fn(face)
            planar = BRepAdaptor_Surface(face).GetType() == GeomAbs_Plane
            nrm = np.zeros((n_nodes, 3))
            if tri.HasUVNodes():
                if planar:
                    uv = tri.UVNode(1)
                    n0 = normal(uv.X(), uv.Y())
                    if n0 is not None:
                        nrm[:] = n0
                else:
                    for i in range(1, n_nodes + 1):
                        uv = tri.UVNode(i)
                        n0 = normal(uv.X(), uv.Y())
                        if n0 is not None:
                            nrm[i - 1] = n0
            nrm = nrm @ m[:3, :3].T

            reversed_ = face.Orientation() == TopAbs_REVERSED
            for t in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(t).Get()
                if reversed_:
                    b, c = c, b
                I.append((base + a - 1, base + b - 1, base + c - 1))

            # 三角化没给出有效法线时，退回到三角面法线
            bad = np.linalg.norm(nrm, axis=1) < 1e-9
            if bad.any():
                for a, b, c in I[-tri.NbTriangles():]:
                    fn = np.cross(pts[b - base] - pts[a - base], pts[c - base] - pts[a - base])
                    for k in (a, b, c):
                        if bad[k - base]:
                            nrm[k - base] += fn
            ln = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = nrm / np.where(ln < 1e-12, 1, ln)

            color = colors.of(face) or solid_color
            P.append(pts)
            N.append(nrm)
            C.append(np.tile(color, (n_nodes, 1)))
            base += n_nodes

        E.extend(feature_edges(solid, hole_edge))

    if not P:
        return None
    return (np.vstack(P), np.vstack(N), np.vstack(C), np.array(I, dtype=np.uint32),
            np.array(E).reshape(-1, 3) if E else np.zeros((0, 3)))


def feature_edges(solid, hole_edge):
    """取 B-rep 棱线，跳过缝合边和切线连续的边。返回线段端点列表。"""
    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(solid, TopAbs_EDGE, TopAbs_FACE, emap)
    segs = []
    for i in range(1, emap.Extent() + 1):
        edge = TopoDS.Edge_s(emap.FindKey(i))
        if BRep_Tool.Degenerated_s(edge):
            continue
        faces = [TopoDS.Face_s(f) for f in emap.FindFromIndex(i)]
        if not faces:
            continue
        if len(faces) == 1 and BRep_Tool.IsClosed_s(edge, faces[0]):
            continue  # 缝合边

        polys = []
        for face in faces[:2]:
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is None:
                continue
            poly = BRep_Tool.PolygonOnTriangulation_s(edge, tri, loc)
            if poly is None:
                continue
            polys.append((face, tri, loc, [poly.Node(k) for k in range(1, poly.NbNodes() + 1)]))
        if not polys:
            continue

        if len(polys) == 2 and polys[0][0].IsSame(polys[1][0]):
            continue  # 同一个面的缝合边
        if len(polys) == 2:
            ns = []
            for face, tri, loc, idx in polys:
                if not tri.HasUVNodes():
                    break
                uv = tri.UVNode(idx[len(idx) // 2])
                n = face_normal_fn(face)(uv.X(), uv.Y())
                if n is None:
                    break
                ns.append(trsf_matrix(loc)[:3, :3] @ n)
            if len(ns) == 2:
                cosang = float(np.clip(np.dot(ns[0], ns[1]), -1, 1))
                if math.acos(cosang) < SMOOTH_ANGLE:
                    continue

        face, tri, loc, idx = polys[0]
        m = trsf_matrix(loc)
        pts = np.array([[tri.Node(k).X(), tri.Node(k).Y(), tri.Node(k).Z()] for k in idx])
        pts = pts @ m[:3, :3].T + m[:3, 3]
        extent = (pts.max(axis=0) - pts.min(axis=0)).max()
        closed = np.allclose(pts[0], pts[-1], atol=1e-6)
        if extent < MIN_EDGE or (hole_edge is not None and closed and extent < hole_edge):
            continue
        for a, b in zip(pts[:-1], pts[1:]):
            segs.append(a)
            segs.append(b)
    return segs


def dominant_color(shape, colors, base_color):
    """取体积最大的实体的颜色，作为简化件的单一颜色。"""
    best, best_v = base_color, -1.0
    for solid in explore(shape, TopAbs_SOLID):
        lo, hi = bbox(solid)
        v = float(np.prod(np.maximum(hi - lo, 1e-3)))
        c = colors.of(solid)
        if c is None:
            for f in explore(solid, TopAbs_FACE):
                c = colors.of(f)
                if c:
                    break
        if c is not None and v > best_v:
            best, best_v = c, v
    return best


BOX_FACES = [((0, 1, 3, 2), (0, 0, -1)), ((4, 6, 7, 5), (0, 0, 1)), ((0, 4, 5, 1), (0, -1, 0)),
             ((2, 3, 7, 6), (0, 1, 0)), ((0, 2, 6, 4), (-1, 0, 0)), ((1, 5, 7, 3), (1, 0, 0))]
BOX_EDGES = [(0, 1), (1, 3), (3, 2), (2, 0), (4, 5), (5, 7), (7, 6), (6, 4), (0, 4), (1, 5), (2, 6), (3, 7)]


def box_mesh(lo, hi, m, color):
    corners = np.array([[x, y, z] for z in (lo[2], hi[2]) for y in (lo[1], hi[1]) for x in (lo[0], hi[0])])
    corners = corners @ m[:3, :3].T + m[:3, 3]
    P, N, I = [], [], []
    for quad, n in BOX_FACES:
        b = len(P)
        nn = m[:3, :3] @ np.array(n, dtype=float)
        for k in quad:
            P.append(corners[k])
            N.append(nn)
        I += [(b, b + 2, b + 1), (b, b + 3, b + 2)]   # 逆时针朝外
    E = [corners[k] for a, b in BOX_EDGES for k in (a, b)]
    P = np.array(P)
    return P, np.array(N), np.tile(color, (len(P), 1)), np.array(I, dtype=np.uint32), np.array(E)


# ---------- GLB 输出 ----------

class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors, self.meshes, self.nodes = [], [], [], []

    def _accessor(self, arr, ctype, atype, target=None, normalized=False, minmax=False):
        while len(self.bin) % 4:
            self.bin.append(0)
        data = arr.tobytes()
        view = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            view['target'] = target
        self.bin += data
        self.views.append(view)
        acc = {'bufferView': len(self.views) - 1, 'componentType': ctype, 'count': len(arr), 'type': atype}
        if normalized:
            acc['normalized'] = True
        if minmax:
            acc['min'] = arr.min(axis=0).tolist()
            acc['max'] = arr.max(axis=0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_mesh(self, name, P, N, C, I):
        attrs = {'POSITION': self._accessor(P.astype('<f4'), 5126, 'VEC3', 34962, minmax=True),
                 'NORMAL': self._accessor(N.astype('<f4'), 5126, 'VEC3', 34962)}
        rgba = np.hstack([np.clip(C, 0, 1), np.ones((len(C), 1))])
        attrs['COLOR_0'] = self._accessor((rgba * 255 + 0.5).astype('u1'), 5121, 'VEC4', 34962, normalized=True)
        idx = self._accessor(I.reshape(-1).astype('<u4'), 5125, 'SCALAR', 34963)
        self._node(name, {'attributes': attrs, 'indices': idx, 'mode': 4})

    def add_lines(self, name, segs):
        attrs = {'POSITION': self._accessor(segs.astype('<f4'), 5126, 'VEC3', 34962, minmax=True)}
        self._node(name, {'attributes': attrs, 'mode': 1})

    def _node(self, name, prim):
        self.meshes.append({'name': name, 'primitives': [prim]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1})

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        doc = {'asset': {'version': '2.0', 'generator': 'step2glb'}, 'scene': 0,
               'scenes': [{'nodes': list(range(len(self.nodes)))}], 'nodes': self.nodes, 'meshes': self.meshes,
               'accessors': self.accessors, 'bufferViews': self.views, 'buffers': [{'byteLength': len(self.bin)}]}
        js = json.dumps(doc, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack('<I4s', len(js), b'JSON'))
            f.write(js)
            f.write(struct.pack('<I4s', len(self.bin), b'BIN\0'))
            f.write(self.bin)


class Bucket:
    def __init__(self):
        self.P, self.N, self.C, self.I, self.E, self.n = [], [], [], [], [], 0

    def add(self, P, N, C, I, E=None):
        self.P.append(P)
        self.N.append(N)
        self.C.append(C)
        self.I.append(I + self.n)
        self.n += len(P)
        if E is not None and len(E):
            self.E.append(E)

    def tris(self):
        return sum(len(i) for i in self.I)

    def emit(self, glb, name, xf, edges_name=None):
        if self.P:
            P = np.vstack(self.P) @ xf[:3, :3].T + xf[:3, 3]
            glb.add_mesh(name, P, np.vstack(self.N) @ xf[:3, :3].T, np.vstack(self.C), np.vstack(self.I))
        if edges_name and self.E:
            glb.add_lines(edges_name, np.vstack(self.E) @ xf[:3, :3].T + xf[:3, 3])


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step')
    ap.add_argument('out', help='输出路径前缀，不带扩展名')
    ap.add_argument('--board', default='Board', help='PCB 基板的元件名')
    ap.add_argument('--small', type=float, default=2.2, help='占板最大边小于此值（mm）压平成色块')
    ap.add_argument('--large', type=float, default=6.0, help='占板最大边不小于此值（mm）保留完整几何')
    ap.add_argument('--tall', type=float, default=3.0, help='高度不小于此值（mm）也保留完整几何')
    ap.add_argument('--deflection', type=float, default=0.12, help='三角化线性偏差（mm）')
    args = ap.parse_args()

    doc = TDocStd_Document(TCollection_ExtendedString('step'))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if int(reader.ReadFile(args.step)) != 1:
        sys.exit('读取 STEP 失败: ' + args.step)
    reader.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = Colors(XCAFDoc_DocumentTool.ColorTool_s(doc.Main()))

    free = LabelSeq()
    st.GetFreeShapes(free)
    comps = LabelSeq()
    st.GetComponents_s(free.Value(1), comps)

    items = []
    for i in range(1, comps.Length() + 1):
        comp = comps.Value(i)
        ref = TDF_Label()
        if not st.GetReferredShape_s(comp, ref):
            continue
        local = st.GetShape_s(ref)                 # 元件自身坐标系
        placed = st.GetShape_s(comp)               # 带装配位置
        m = trsf_matrix(placed.Location())
        llo, lhi = bbox(local)
        wlo, whi = bbox(placed)
        items.append({'name': label_name(ref) or label_name(comp), 'ref': ref, 'local': local, 'm': m,
                      'llo': llo, 'lhi': lhi, 'wlo': wlo, 'whi': whi})

    board = next((it for it in items if it['name'] == args.board), None) or \
        max(items, key=lambda it: (it['whi'] - it['wlo'])[:2].prod())
    b_lo, b_hi = board['wlo'], board['whi']
    z_top, z_bot = b_hi[2], b_lo[2]

    buckets = {k: Bucket() for k in ('board', 'parts', 'blocks', 'decals')}
    manifest = []
    all_lo, all_hi = b_lo.copy(), b_hi.copy()
    for it in items:
        base = colors.of(it['ref']) or DEFAULT_COLOR
        size = it['lhi'] - it['llo']
        foot = float(max(size[0], size[1]))
        height = float(size[2])
        side = 'top' if (it['wlo'][2] + it['whi'][2]) / 2 > (z_top + z_bot) / 2 else 'bottom'
        all_lo, all_hi = np.minimum(all_lo, it['wlo']), np.maximum(all_hi, it['whi'])
        m = it['m']

        if it is board:
            kind = 'board'
            mesh = tessellate(it['local'], colors, base, args.deflection, hole_edge=MIN_HOLE_EDGE)
        elif foot >= args.large or height >= args.tall:
            kind = 'parts'
            mesh = tessellate(it['local'], colors, base, args.deflection, skip_small=MIN_SOLID)
        elif foot >= args.small:
            kind = 'blocks'
            mesh = box_mesh(it['llo'], it['lhi'], np.eye(4), dominant_color(it['local'], colors, base))
        else:
            kind = 'decals'
            z = (z_top + 0.03) if side == 'top' else (z_bot - 0.03)
            lo, hi = it['llo'].copy(), it['lhi'].copy()
            P, N, C, I, _ = box_mesh(lo, hi, m, dominant_color(it['local'], colors, base))
            face = slice(4, 8) if side == 'top' else slice(0, 4)   # 朝外的那一面
            P, N, C = P[face].copy(), N[face], C[face]
            P[:, 2] = z
            buckets[kind].add(P, N, C, np.array([(0, 2, 1), (0, 3, 2)], dtype=np.uint32))
            mesh = None

        if mesh is not None:
            P, N, C, I, E = mesh
            if kind != 'decals':
                P = P @ m[:3, :3].T + m[:3, 3]
                N = N @ m[:3, :3].T
                E = E @ m[:3, :3].T + m[:3, 3] if len(E) else E
            buckets[kind].add(P, N, C, I, E)
        manifest.append({'name': it['name'], 'kind': kind, 'side': side,
                         'size': [round(float(v), 3) for v in size],
                         'triangles': int(len(mesh[3])) if mesh is not None else 2,
                         'edgeSegments': int(len(mesh[4]) // 2) if mesh is not None else 0})

    # 输出坐标系：X 沿板宽并以板中心为原点，Y 向上并以整体最低点为 0，Z 为板法线并以板厚中心为 0
    xf = np.eye(4)
    xf[:3, 3] = [-(b_lo[0] + b_hi[0]) / 2, -all_lo[1], -(z_top + z_bot) / 2]

    glb = Glb()
    buckets['board'].emit(glb, 'board', xf, 'board_edges')
    buckets['parts'].emit(glb, 'parts', xf, 'parts_edges')
    buckets['blocks'].emit(glb, 'blocks', xf, 'blocks_edges')
    buckets['decals'].emit(glb, 'decals', xf)
    glb.write(args.out + '.glb')

    def tx(p):
        return [round(float(v), 3) for v in (np.asarray(p) + xf[:3, 3])]
    meta = {'source': args.step.replace('\\', '/').split('/')[-1],
            'bounds': {'min': tx(all_lo), 'max': tx(all_hi)},
            'board': {'min': tx(b_lo), 'max': tx(b_hi)},
            'counts': {k: sum(1 for c in manifest if c['kind'] == k) for k in buckets},
            'triangles': {k: b.tris() for k, b in buckets.items()},
            'components': sorted(manifest, key=lambda c: c['name'])}
    with open(args.out + '.json', 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: meta[k] for k in ('bounds', 'board', 'counts', 'triangles')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
