#!/usr/bin/env python3
"""把 ECAD 导出的 PCB STEP 转成查看器用的 GLB。

支持两种 STEP 结构：
  装配式  一个根装配，每个元器件是一个带位号的子件（如 Altium 导出）
  平铺式  没有装配层级，每个实体单独成件，名字形如 <封装>__Importiert<体号>_<实例号>；
          脚本按封装和实例号把实体归并成元器件

元器件按占板尺寸分三档：
  large  完整三角化，保留 B-rep 棱线
  medium 简化成包围盒，带棱线
  small  压平成贴在板面上的色块，不带棱线

输出 <out>.glb（网格与线段）和 <out>.json（板尺寸与元器件清单）。

用法：
  python pipeline/step2glb.py cad/board.step public/models/board --annotations boards/board.json

--mate PREFIX 指出插入背板的连接器（按名称前缀匹配）。给了它，脚本会自动定向：
连接器朝下，板卡主体偏向 +X 一侧（Iteration 2 的连接器不在板宽正中），原点落在连接器上。
占两个槽的板卡以 Z 较小的那个连接器为原点。STEP 原本朝哪个方向都可以。
--split NAME=PREFIX|PREFIX 把名称匹配的零件拆出去，单独写成同目录下的 NAME.glb（坐标系相同），
用于支架这类可选件。
--split-board PREFIX 配合 --split：拆出去的是一块扩展板（第二块 PCB）。PREFIX 是那块 PCB 的元件名前缀，
装在它上面的元器件按位置自动跟着拆出去，并和主板一样分三档简化。
--frame backplane --slots PREFIX 用于背板：板面水平，槽位沿 Z 排列，原点在槽位连接器中心，
并在 JSON 里写出各槽位的位置。

--annotations 指向板卡标注文件（可以给多个）。interfaces[] 里每个接口各自输出成独立节点
（extras.interface 为 ref），供查看器单独高亮。接口默认对应名称等于 ref 的元器件；
STEP 里没有位号时用 match 列出名称通配符，同名的多个连接器再用 cluster 按序号区分
（转换时会打印每个通配符匹配到的各组位置）。

--material PREFIX=NAME 指定名称匹配的元器件的材质（dark、light、gold、kapton），覆盖 CAD 原色。可重复。
"""
import argparse
import fnmatch
import json
import math
import re
import struct
import sys

import numpy as np
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
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
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

try:  # OCP 8 把序列类型移到了 collections
    from OCP.collections import Sequence_TDF_Label as LabelSeq
except ImportError:
    from OCP.TDF import TDF_LabelSequence as LabelSeq

DEFAULT_COLOR = (0.6, 0.6, 0.6)
SMOOTH_ANGLE = math.radians(20)   # 两面夹角小于此值的棱不画线
MIN_SOLID = 0.6                   # large 件内部小于此尺寸的实体（焊球等）丢弃
MIN_BODY = 0.02                   # 最薄处小于此值的实体（丝印、焊盘面片）丢弃
MIN_HOLE_EDGE = 2.2               # 板上小于此尺寸的闭合棱（过孔）不画线
MIN_EDGE = 0.35                   # 短于此长度的棱不画线，屏幕上不足一两个像素
THIN_SOLID = 0.45                 # 第二长边小于此值的实体（引脚）简化成不描边的包围盒
ANGULAR_DEFL = 0.9                # 三角化角度偏差（弧度），可用 --angular 覆盖
# --material 用的标准色。查看器按颜色把元器件归成这几种材质（src/render.js 的 classifyColor）
MATERIAL_COLORS = {'dark': (0.02, 0.02, 0.02), 'light': (0.6, 0.6, 0.6), 'gold': (1.0, 1.0, 0.0), 'kapton': (0.6, 0.3, 0.0)}


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


def signature(it):
    """元器件的形状指纹：包围盒尺寸 + 各实体体积质心相对包围盒角点的位置。
    指纹相同的元器件视为同一几何的平移副本，只存一份网格。"""
    sig = [round(float(v), 2) for v in (it['whi'] - it['wlo'])]
    for shape, _ in it['bodies']:
        g = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, g)
        c = g.CentreOfMass()
        sig += [round(float(g.Mass()), 2)] + [round(float(v), 2) for v in (np.array([c.X(), c.Y(), c.Z()]) - it['wlo'])]
    return (len(it['bodies']), tuple(sorted(sig[3:])), tuple(sig[:3]))


def tess_item(it, colors, lin_defl, **kw):
    """三角化一个元器件的所有实体并合并。"""
    P, N, C, I, E, n = [], [], [], [], [], 0
    for shape, base in it['bodies']:
        mesh = tessellate(shape, colors, base, lin_defl, **kw)
        if mesh is None:
            continue
        P.append(mesh[0]); N.append(mesh[1]); C.append(mesh[2]); I.append(mesh[3] + n); n += len(mesh[0])
        if len(mesh[4]):
            E.append(mesh[4])
    if not P:
        return None
    return np.vstack(P), np.vstack(N), np.vstack(C), np.vstack(I), np.vstack(E) if E else np.zeros((0, 3))


def item_color(it, colors):
    """简化件的单一颜色：取体积最大的实体的颜色。"""
    best, best_v = DEFAULT_COLOR, -1.0
    for shape, base in it['bodies']:
        lo, hi = bbox(shape)
        v = float(np.prod(np.maximum(hi - lo, 1e-3)))
        if v > best_v:
            best, best_v = dominant_color(shape, colors, base), v
    return best


FLAT_NAME = re.compile(r'^(.*?)__(?:[A-Za-z]+)(\d*)(?:_(\d+))?$')


def load_items(st, colors):
    """读出元器件列表。每项：name、bodies [(shape, 颜色)]、m 装配变换、局部与装配后的包围盒。"""
    free = LabelSeq()
    st.GetFreeShapes(free)
    items = []

    if free.Length() == 1 and st.IsAssembly_s(free.Value(1)):
        comps = LabelSeq()
        st.GetComponents_s(free.Value(1), comps)
        for i in range(1, comps.Length() + 1):
            comp = comps.Value(i)
            ref = TDF_Label()
            if not st.GetReferredShape_s(comp, ref):
                continue
            local = st.GetShape_s(ref)                 # 元件自身坐标系
            placed = st.GetShape_s(comp)               # 带装配位置
            llo, lhi = bbox(local)
            wlo, whi = bbox(placed)
            items.append({'name': label_name(ref) or label_name(comp), 'm': trsf_matrix(placed.Location()),
                          'bodies': [(local, colors.of(ref) or DEFAULT_COLOR)],
                          'llo': llo, 'lhi': lhi, 'wlo': wlo, 'whi': whi})
        return items

    # 平铺式：按“封装 + 实例号”归并实体
    groups = {}
    for i in range(1, free.Length() + 1):
        label = free.Value(i)
        shape = st.GetShape_s(label)
        lo, hi = bbox(shape)
        if next(explore(shape, TopAbs_SOLID), None) is None or (hi - lo).min() < MIN_BODY:
            continue
        name = label_name(label)
        m = FLAT_NAME.match(name)
        key = (m.group(1) + ('#' + m.group(3) if m.group(3) else '')) if m else name
        groups.setdefault(key, []).append((shape, colors.of(label) or DEFAULT_COLOR, lo, hi))
    for key, bodies in groups.items():
        lo = np.min([b[2] for b in bodies], axis=0)
        hi = np.max([b[3] for b in bodies], axis=0)
        items.append({'name': key, 'm': np.eye(4), 'bodies': [(b[0], b[1]) for b in bodies],
                      'llo': lo, 'lhi': hi, 'wlo': lo, 'whi': hi})
    return items


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

def axis_box(it, na):
    """简化盒体用的包围盒。元件自身坐标的第 na 轴仍与板法线平行时用局部包围盒（贴合），否则用装配后的。"""
    r = it['m'][:3, :3]
    if abs(abs(r[na, na]) - 1) < 1e-6:
        return it['llo'], it['lhi'], it['m']
    return it['wlo'], it['whi'], np.eye(4)


def decal_quad(lo, hi, na, sign, coord, color):
    """在法线为 na 轴的平面 coord 上，画出包围盒的投影矩形（朝 sign 方向）。"""
    u, v = [a for a in range(3) if a != na]
    pts = np.zeros((4, 3))
    for k, (pu, pv) in enumerate(((lo[u], lo[v]), (hi[u], lo[v]), (hi[u], hi[v]), (lo[u], hi[v]))):
        pts[k, u], pts[k, v], pts[k, na] = pu, pv, coord
    n = np.zeros(3)
    n[na] = sign
    tri = np.array([(0, 1, 2), (0, 2, 3)], dtype=np.uint32)
    if np.dot(np.cross(pts[1] - pts[0], pts[2] - pts[0]), n) < 0:
        tri = tri[:, ::-1].copy()
    return pts, np.tile(n, (4, 1)), np.tile(color, (4, 1)), tri


def card_frame(all_lo, all_hi, mates, board, na):
    """由背板连接器的位置推出板卡坐标系。返回 (R, origin, front)。
    R 的三行是查看器 X、Y、Z 轴在 STEP 坐标里的方向；front 是 PCB 正面（STEP 的 +法线）朝 +Z 还是 -Z。"""
    m_lo = np.min([it['wlo'] for it in mates], axis=0)
    m_hi = np.max([it['whi'] for it in mates], axis=0)
    d = (all_lo + all_hi) / 2 - (m_lo + m_hi) / 2
    yi, xi = np.argsort(-np.abs(d))[:2]            # 偏得最远的轴是插入方向，其次是板宽方向
    zi = 3 - yi - xi
    X, Y = np.zeros(3), np.zeros(3)
    Y[yi] = 1 if d[yi] >= 0 else -1
    X[xi] = 1 if d[xi] >= 0 else -1
    Z = np.cross(X, Y)
    origin = np.zeros(3)
    origin[xi] = (m_lo[xi] + m_hi[xi]) / 2
    origin[yi] = m_lo[yi] if Y[yi] > 0 else m_hi[yi]
    b_mid = (board['wlo'][zi] + board['whi'][zi]) / 2
    centers = sorted({round(float((it['wlo'][zi] + it['whi'][zi]) / 2), 1) for it in mates})
    slots = [[centers[0]]]
    for c in centers[1:]:
        if c - slots[-1][-1] < 5:
            slots[-1].append(c)
        else:
            slots.append([c])
    slot_c = [float(np.mean(g)) for g in slots]
    if na == zi and len(slot_c) == 1 and abs(slot_c[0] - b_mid) < 3:
        origin[zi] = b_mid                         # 边缘安装的连接器：以板厚中心为准
    else:
        origin[zi] = min(slot_c, key=lambda c: c * Z[zi])   # 多个槽：取查看器 Z 最小的那个
    front = int(Z[na]) if na == zi else 1
    return np.array([X, Y, Z]), origin, front, len(slot_c)


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

    def add_instances(self, name, P, N, C, I, E, offsets):
        """同一份网格和棱线放到多个平移位置。"""
        attrs = {'POSITION': self._accessor(P.astype('<f4'), 5126, 'VEC3', 34962, minmax=True),
                 'NORMAL': self._accessor(N.astype('<f4'), 5126, 'VEC3', 34962)}
        rgba = np.hstack([np.clip(C, 0, 1), np.ones((len(C), 1))])
        attrs['COLOR_0'] = self._accessor((rgba * 255 + 0.5).astype('u1'), 5121, 'VEC4', 34962, normalized=True)
        idx = self._accessor(I.reshape(-1).astype('<u4'), 5125, 'SCALAR', 34963)
        self.meshes.append({'name': name, 'primitives': [{'attributes': attrs, 'indices': idx, 'mode': 4}]})
        tri = len(self.meshes) - 1
        lin = None
        if len(E):
            la = {'POSITION': self._accessor(E.astype('<f4'), 5126, 'VEC3', 34962, minmax=True)}
            self.meshes.append({'name': name + '_edges', 'primitives': [{'attributes': la, 'mode': 1}]})
            lin = len(self.meshes) - 1
        for k, off in enumerate(offsets):
            t = [float(v) for v in off]
            self.nodes.append({'name': '%s_%d' % (name, k), 'mesh': tri, 'translation': t})
            if lin is not None:
                self.nodes.append({'name': '%s_%d_edges' % (name, k), 'mesh': lin, 'translation': t})

    def add_mesh(self, name, P, N, C, I, extras=None):
        attrs = {'POSITION': self._accessor(P.astype('<f4'), 5126, 'VEC3', 34962, minmax=True),
                 'NORMAL': self._accessor(N.astype('<f4'), 5126, 'VEC3', 34962)}
        rgba = np.hstack([np.clip(C, 0, 1), np.ones((len(C), 1))])
        attrs['COLOR_0'] = self._accessor((rgba * 255 + 0.5).astype('u1'), 5121, 'VEC4', 34962, normalized=True)
        idx = self._accessor(I.reshape(-1).astype('<u4'), 5125, 'SCALAR', 34963)
        self._node(name, {'attributes': attrs, 'indices': idx, 'mode': 4}, extras)

    def add_lines(self, name, segs, extras=None):
        attrs = {'POSITION': self._accessor(segs.astype('<f4'), 5126, 'VEC3', 34962, minmax=True)}
        self._node(name, {'attributes': attrs, 'mode': 1}, extras)

    def _node(self, name, prim, extras=None):
        self.meshes.append({'name': name, 'primitives': [prim]})
        node = {'name': name, 'mesh': len(self.meshes) - 1}
        if extras:
            node['extras'] = extras
        self.nodes.append(node)

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

    def emit(self, glb, name, xf, edges_name=None, extras=None):
        if self.P:
            P = np.vstack(self.P) @ xf[:3, :3].T + xf[:3, 3]
            glb.add_mesh(name, P, np.vstack(self.N) @ xf[:3, :3].T, np.vstack(self.C), np.vstack(self.I), extras)
        if edges_name and self.E:
            glb.add_lines(edges_name, np.vstack(self.E) @ xf[:3, :3].T + xf[:3, 3], extras)


# ---------- 主流程 ----------

def cluster_items(items, gap=0.6):
    """把包围盒相距不超过 gap 的元器件并成组（一个连接器常由外壳、引脚等多个件组成）。
    各组按中心的 STEP 坐标排序，顺序是确定的。"""
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(items):
        for j in range(i):
            b = items[j]
            if np.all(a['wlo'] <= b['whi'] + gap) and np.all(b['wlo'] <= a['whi'] + gap):
                parent[find(i)] = find(j)
    groups = {}
    for i, it in enumerate(items):
        groups.setdefault(find(i), []).append(it)

    def center(g):
        lo = np.min([it['wlo'] for it in g], axis=0)
        hi = np.max([it['whi'] for it in g], axis=0)
        return tuple(round(float(v), 1) for v in (lo + hi) / 2)
    return sorted(groups.values(), key=center), center


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step')
    ap.add_argument('out', help='输出路径前缀，不带扩展名')
    ap.add_argument('--board', default='Board', help='PCB 基板的元件名前缀；找不到时取面积最大的薄板')
    ap.add_argument('--mate', help='插入背板的连接器的元件名前缀；给出后自动定向并以它为原点')
    ap.add_argument('--split', help='NAME=前缀|前缀：把匹配的零件拆到同目录的 NAME.glb')
    ap.add_argument('--split-board', help='拆出去的那块 PCB 的元件名前缀；装在它上面的元器件自动跟着拆出去')
    ap.add_argument('--frame', choices=['card', 'backplane'], default='card', help='输出坐标系')
    ap.add_argument('--slots', help='背板上槽位连接器的元件名前缀（配合 --frame backplane）')
    ap.add_argument('--small', type=float, default=2.2, help='占板最大边小于此值（mm）压平成色块')
    ap.add_argument('--large', type=float, default=6.0, help='占板最大边不小于此值（mm）保留完整几何')
    ap.add_argument('--tall', type=float, default=3.0, help='高度不小于此值（mm）也保留完整几何')
    ap.add_argument('--annotations', nargs='*', default=[], help='板卡标注 JSON（可多个），其中的接口单独输出')
    ap.add_argument('--material', action='append', default=[], help='前缀=材质：覆盖匹配元器件的颜色，可重复')
    ap.add_argument('--deflection', type=float, default=0.12, help='三角化线性偏差（mm）')
    ap.add_argument('--angular', type=float, help='三角化角度偏差（弧度），默认 0.9，越大越粗')
    args = ap.parse_args()
    if args.angular:
        global ANGULAR_DEFL
        ANGULAR_DEFL = args.angular

    doc = TDocStd_Document(TCollection_ExtendedString('step'))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if int(reader.ReadFile(args.step)) != 1:
        sys.exit('读取 STEP 失败: ' + args.step)
    reader.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = Colors(XCAFDoc_DocumentTool.ColorTool_s(doc.Main()))

    items = load_items(st, colors)
    if not items:
        sys.exit('STEP 里没有找到实体')

    def plate_area(it):
        return np.sort(it['whi'] - it['wlo'])[1:].prod()
    board = max((it for it in items if it['name'].startswith(args.board)), key=plate_area, default=None) or \
        max(items, key=plate_area)
    b_lo, b_hi = board['wlo'], board['whi']
    na = int(np.argmin(b_hi - b_lo))               # 板法线所在的轴
    u, v = [a for a in range(3) if a != na]

    # 拆出去的部分：按名称前缀，以及（给了 --split-board 时）装在扩展板上的元器件
    split_name, split_prefixes, split_board = None, (), None
    if args.split:
        split_name, _, pat = args.split.partition('=')
        split_prefixes = tuple(x for x in pat.split('|') if x)
    if args.split_board:
        split_board = max((it for it in items if it is not board and it['name'].startswith(args.split_board)),
                          key=plate_area, default=None)
        if split_board is None:
            sys.exit('--split-board 指定的元件找不到: ' + args.split_board)

    def touches(it, plate, tol=0.4):
        """元器件是否装在这块板上：沿板法线与板相接或穿过，且在板的范围内。"""
        return it['wlo'][na] <= plate['whi'][na] + tol and it['whi'][na] >= plate['wlo'][na] - tol and \
            all(it['wlo'][a] >= plate['wlo'][a] - 1 and it['whi'][a] <= plate['whi'][a] + 1 for a in (u, v))

    def is_split(it):
        if it is board:
            return False
        if it is split_board or (split_prefixes and it['name'].startswith(split_prefixes)):
            return True
        return split_board is not None and touches(it, split_board) and not touches(it, board)

    # 接口：标注里的每一项对应一个或多个元器件
    iface_of, refs = {}, []
    for path in args.annotations:
        with open(path, encoding='utf-8') as f:
            entries = json.load(f).get('interfaces', [])
        for e in entries:
            ref = e['ref']
            if 'match' in e:
                found = [it for it in items if it is not board and it is not split_board and
                         any(fnmatch.fnmatchcase(it['name'], p) for p in e['match'])]
            else:
                found = [it for it in items if it['name'] == ref]
            if found and 'match' in e:
                groups, center = cluster_items(found)
                if len(groups) > 1 or 'cluster' in e:
                    print('%s: %s 匹配到 %d 组: %s' % (ref, e['match'], len(groups),
                          ', '.join('%d@%s' % (k, center(g)) for k, g in enumerate(groups))), file=sys.stderr)
                if 'cluster' in e:
                    found = groups[e['cluster']] if e['cluster'] < len(groups) else []
            if not found:
                print('警告：标注里的接口在 STEP 中找不到: ' + ref, file=sys.stderr)
                continue
            refs.append(ref)
            for it in found:
                iface_of[id(it)] = ref

    overrides = []
    for spec in args.material:
        prefix, _, name = spec.rpartition('=')
        if name not in MATERIAL_COLORS:
            sys.exit('--material 的材质只能是 ' + '、'.join(MATERIAL_COLORS) + ': ' + spec)
        overrides.append((prefix, MATERIAL_COLORS[name]))

    def override(it):
        return next((c for prefix, c in overrides if it['name'].startswith(prefix)), None)

    def flat_color(it):
        return override(it) or item_color(it, colors)

    def recolor(it, C):
        c = override(it)
        return np.tile(c, (len(C), 1)) if c else C

    def dims(it):
        size = it['whi'] - it['wlo']
        return float(max(size[u], size[v])), float(size[na])

    # 完整几何件里指纹相同的归为一组，只三角化第一个，其余作为平移实例
    def is_full(it):
        foot, height = dims(it)
        return it is not board and id(it) not in iface_of and not is_split(it) and (foot >= args.large or height >= args.tall)
    by_sig = {}
    for it in items:
        if is_full(it):
            by_sig.setdefault(signature(it), []).append(it)
    inst_of = {}                      # id(元器件) -> 组里的第一个
    for group in by_sig.values():
        if len(group) > 1:
            for it in group:
                inst_of[id(it)] = group[0]
    instanced = {}                    # id(第一个) -> {'mesh':…, 'offsets': […]}

    # 主板和拆出去的部分各有一套输出。plate 是各自的 PCB；拆出去的部分没有 PCB 时（支架）全部保留完整几何
    def target(plate):
        return {'plate': plate, 'ifaces': {},
                'buckets': {k: Bucket() for k in ('board', 'parts', 'blocks', 'bits', 'decals')}}
    main_t, split_t = target(board), target(split_board)
    manifest = []
    all_lo, all_hi = b_lo.copy(), b_hi.copy()
    for it in items:
        foot, height = dims(it)
        size = it['whi'] - it['wlo']
        split = is_split(it)
        tgt = split_t if split else main_t
        plate, buckets = tgt['plate'], tgt['buckets']
        ref_plate = plate or board
        n_top, n_bot = ref_plate['whi'][na], ref_plate['wlo'][na]
        mid = (it['wlo'][na] + it['whi'][na]) / 2
        side = 'top' if mid > (n_top + n_bot) / 2 else 'bottom'
        if not split:
            all_lo, all_hi = np.minimum(all_lo, it['wlo']), np.maximum(all_hi, it['whi'])
        m = it['m']
        mesh = None
        entry = {'name': it['name'], 'side': side, 'size': [round(float(x), 3) for x in size]}
        if split:
            entry['in'] = split_name

        if it is plate:
            kind = 'board'
            mesh = tess_item(it, colors, args.deflection, hole_edge=MIN_HOLE_EDGE)
        elif id(it) in iface_of:
            kind = 'interface'      # 接口件不论大小都保留完整几何，并单独成节点
            mesh = tess_item(it, colors, args.deflection, skip_small=MIN_SOLID)
        elif id(it) in inst_of:
            kind = 'parts'
            first = inst_of[id(it)]
            inst = instanced.setdefault(id(first), {'mesh': None, 'offsets': []})
            if it is first:
                tm = tess_item(it, colors, args.deflection, skip_small=MIN_SOLID)
                if tm is not None:
                    P, N, C, I, E = tm
                    inst['mesh'] = (P @ m[:3, :3].T + m[:3, 3], N @ m[:3, :3].T, recolor(it, C), I,
                                    E @ m[:3, :3].T + m[:3, 3] if len(E) else E)
            inst['offsets'].append(it['wlo'] - first['wlo'])
            entry.update(kind=kind, instanceOf=first['name'],
                         triangles=int(len(inst['mesh'][3])) if it is first and inst['mesh'] else 0)
            manifest.append(entry)
            continue
        elif plate is None or foot >= args.large or height >= args.tall:
            kind = 'parts'
            mesh = tess_item(it, colors, args.deflection, skip_small=MIN_SOLID)
        elif foot >= args.small:
            kind = 'blocks'
            lo, hi, bm = axis_box(it, na)
            P, N, C, I, E = box_mesh(lo, hi, bm, flat_color(it))
            buckets[kind].add(P, N, C, I, E)
            entry.update(kind=kind, triangles=12)
            manifest.append(entry)
            continue
        else:
            # 小件：紧贴板面且在板的范围内的压平成色块，其余（不在这块板上的）留成不描边的小盒子
            on_top = abs(it['wlo'][na] - n_top) < 0.4
            on_bot = abs(it['whi'][na] - n_bot) < 0.4
            inside = all(it['wlo'][a] >= plate['wlo'][a] - 0.5 and it['whi'][a] <= plate['whi'][a] + 0.5 for a in (u, v))
            color = flat_color(it)
            if inside and (on_top or on_bot):
                kind = 'decals'
                P, N, C, I = decal_quad(it['wlo'], it['whi'], na, 1 if on_top else -1,
                                        n_top + 0.03 if on_top else n_bot - 0.03, color)
                buckets[kind].add(P, N, C, I)
                entry.update(kind=kind, triangles=2)
            else:
                kind = 'bits'
                P, N, C, I, _ = box_mesh(it['wlo'], it['whi'], np.eye(4), color)
                buckets[kind].add(P, N, C, I)
                entry.update(kind=kind, triangles=12)
            manifest.append(entry)
            continue

        if mesh is None:
            continue
        P, N, C, I, E = mesh
        P = P @ m[:3, :3].T + m[:3, 3]
        N = N @ m[:3, :3].T
        E = E @ m[:3, :3].T + m[:3, 3] if len(E) else E
        dest = tgt['ifaces'].setdefault(iface_of[id(it)], Bucket()) if kind == 'interface' else buckets[kind]
        dest.add(P, N, recolor(it, C), I, E)
        entry.update(kind=kind, triangles=int(len(I)), edgeSegments=int(len(E) // 2))
        manifest.append(entry)

    n_top, n_bot = b_hi[na], b_lo[na]
    xf = np.eye(4)
    slots_meta, frame_meta = None, None
    if args.frame == 'backplane':
        # 背板：查看器 X = STEP Y，Y = STEP Z（向上），Z = STEP X（槽位排列方向）；板底为 Y=0
        xf[:3, :3] = [[0, 1, 0], [0, 0, 1], [1, 0, 0]]
        sock = [it for it in items if args.slots and it['name'].startswith(args.slots)]
        if sock:
            s_lo = np.min([it['wlo'] for it in sock], axis=0)
            s_hi = np.max([it['whi'] for it in sock], axis=0)
            origin = np.array([(s_lo[0] + s_hi[0]) / 2, (s_lo[1] + s_hi[1]) / 2, n_bot])
        else:
            origin = np.array([(b_lo[0] + b_hi[0]) / 2, (b_lo[1] + b_hi[1]) / 2, n_bot])
        xf[:3, 3] = -xf[:3, :3] @ origin
        if sock:
            # 相距不足 2 mm 的连接器实体算同一个槽位
            xs = sorted((it['wlo'][0] + it['whi'][0]) / 2 for it in sock)
            centers = [[xs[0]]]
            for x in xs[1:]:
                if x - centers[-1][-1] < 2:
                    centers[-1].append(x)
                else:
                    centers.append([x])
            zs = [round(float(np.mean(c)) - origin[0], 3) for c in centers]
            slots_meta = {'z': zs, 'top': round(float(s_hi[2] - n_bot), 3),
                          'length': round(float(s_hi[1] - s_lo[1]), 3),
                          'pitch': round(float(np.mean(np.diff(zs))), 3) if len(zs) > 1 else None}
    else:
        mates = [it for it in items if args.mate and it['name'].startswith(args.mate)]
        if args.mate and not mates:
            print('警告：--mate 指定的元件找不到: ' + args.mate, file=sys.stderr)
        if mates:
            R, origin, front, n_slots = card_frame(all_lo, all_hi, mates, board, na)
            xf[:3, :3] = R
            xf[:3, 3] = -R @ origin
            frame_meta = {'front': front, 'mateSlots': n_slots}
        else:
            # 没指定连接器：保持 STEP 朝向，X 以板中心为原点，Y 以整体最低点为 0，Z 以板厚中心为 0
            xf[:3, 3] = [-(b_lo[0] + b_hi[0]) / 2, -all_lo[1], -(b_lo[2] + b_hi[2]) / 2]

    R = xf[:3, :3]

    def emit(glb, tgt):
        b = tgt['buckets']
        b['board'].emit(glb, 'board', xf, 'board_edges')
        b['parts'].emit(glb, 'parts', xf, 'parts_edges')
        b['blocks'].emit(glb, 'blocks', xf, 'blocks_edges')
        b['bits'].emit(glb, 'bits', xf)
        b['decals'].emit(glb, 'decals', xf)
        for n, ref in enumerate(r for r in refs if r in tgt['ifaces']):
            tgt['ifaces'][ref].emit(glb, 'if_%d' % n, xf, 'if_%d_edges' % n, extras={'interface': ref})

    glb = Glb()
    emit(glb, main_t)
    for n, inst in enumerate(instanced.values()):
        if inst['mesh'] is None:
            continue
        P, N, C, I, E = inst['mesh']
        glb.add_instances('inst_%d' % n, P @ R.T + xf[:3, 3], N @ R.T, C, I,
                          E @ R.T + xf[:3, 3] if len(E) else E, [R @ off for off in inst['offsets']])
    glb.write(args.out + '.glb')

    if split_name and any(b.P for b in split_t['buckets'].values()):
        extra = Glb()
        emit(extra, split_t)
        extra.write(args.out.rsplit('/', 1)[0] + '/' + split_name + '.glb' if '/' in args.out else split_name + '.glb')

    def box_tx(lo, hi):
        c = np.array([R @ np.array([x, y, z]) + xf[:3, 3] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        return {'min': [round(float(x), 3) for x in c.min(axis=0)], 'max': [round(float(x), 3) for x in c.max(axis=0)]}

    def tris(tgt):
        t = {k: b.tris() for k, b in tgt['buckets'].items()}
        t['interface'] = sum(b.tris() for b in tgt['ifaces'].values())
        return t
    kinds = list(main_t['buckets']) + ['interface']
    tri = tris(main_t)
    tri['instanced'] = sum(len(i['mesh'][3]) for i in instanced.values() if i['mesh'])
    meta = {'source': args.step.replace('\\', '/').split('/')[-1],
            'bounds': box_tx(all_lo, all_hi),
            'board': box_tx(b_lo, b_hi),
            'frame': frame_meta,
            'slots': slots_meta,
            'counts': {k: sum(1 for c in manifest if c['kind'] == k and 'in' not in c) for k in kinds},
            'triangles': tri,
            'split': None,
            'components': sorted(manifest, key=lambda c: c['name'])}
    if split_name:
        meta['split'] = {'name': split_name,
                         'board': box_tx(split_board['wlo'], split_board['whi']) if split_board else None,
                         'counts': {k: sum(1 for c in manifest if c['kind'] == k and 'in' in c) for k in kinds},
                         'triangles': tris(split_t)}
    with open(args.out + '.json', 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: meta[k] for k in ('bounds', 'board', 'frame', 'slots', 'counts', 'triangles', 'split')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
