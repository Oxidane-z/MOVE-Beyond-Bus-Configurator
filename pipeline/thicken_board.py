"""把 GLB 里 PCB 基板的厚度改成指定值。

有的 STEP 导出时板厚不对（Altium 里层叠没设好，导出来只有零点几毫米），转换后的模型也就跟着薄。
这个脚本直接改转换好的 GLB：基板（节点 board 和 board_edges）的两个板面里，一面不动，另一面沿板厚方向（Z）
挪到相距 THICKNESS 的位置。元器件和接口件不动，所以要让装着元器件的那一面留在原地。

用法:
    python pipeline/thicken_board.py public/models/battery-heater.glb 1.0 --grow +z

--grow +z：-Z 那一面不动，板子朝 +Z 加厚；--grow -z 相反。
重新运行 step2glb.py 以后要再跑一遍。
"""
import argparse
import json
import struct

import numpy as np


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('glb')
    ap.add_argument('thickness', type=float, help='目标板厚（mm）')
    ap.add_argument('--grow', choices=['+z', '-z'], default='+z', help='朝哪一侧加厚；另一侧的板面不动')
    args = ap.parse_args()

    data = open(args.glb, 'rb').read()
    magic, version, _ = struct.unpack('<4sII', data[:12])
    assert magic == b'glTF' and version == 2, '不是 GLB 2.0 文件'
    jlen = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + jlen])
    blen = struct.unpack('<I', data[20 + jlen:24 + jlen])[0]
    binary = bytearray(data[28 + jlen:28 + jlen + blen])

    changed = False
    for node in doc['nodes']:
        if node.get('name') not in ('board', 'board_edges'):
            continue
        for prim in doc['meshes'][node['mesh']]['primitives']:
            acc = doc['accessors'][prim['attributes']['POSITION']]
            view = doc['bufferViews'][acc['bufferView']]
            assert acc['componentType'] == 5126 and 'byteStride' not in view, '顶点坐标不是紧排的 float32'
            off = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
            pos = np.frombuffer(binary, dtype='<f4', count=acc['count'] * 3, offset=off).reshape(-1, 3)   # 直接改 binary 里的数据
            lo, hi = float(pos[:, 2].min()), float(pos[:, 2].max())
            mid = (lo + hi) / 2
            inner = np.abs(pos[:, 2] - mid) < (hi - lo) * 0.4
            assert not inner.any(), '基板在两个板面之间还有顶点，不是简单的平板'
            if args.grow == '+z':
                pos[pos[:, 2] > mid, 2] = lo + args.thickness
            else:
                pos[pos[:, 2] < mid, 2] = hi - args.thickness
            acc['min'] = [float(v) for v in pos.min(axis=0)]
            acc['max'] = [float(v) for v in pos.max(axis=0)]
            print(f"{node['name']}: {hi - lo:.3f} mm -> {acc['max'][2] - acc['min'][2]:.3f} mm (z {acc['min'][2]:.3f} … {acc['max'][2]:.3f})")
            changed = True
    assert changed, '没找到名为 board 的节点'

    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    js += b' ' * (-len(js) % 4)
    binary += b'\0' * (-len(binary) % 4)
    out = struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(binary))
    out += struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(binary), b'BIN\0') + bytes(binary)
    open(args.glb, 'wb').write(out)


if __name__ == '__main__':
    main()
