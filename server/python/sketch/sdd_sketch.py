#!/usr/bin/env python3
"""从手绘草图提取外轮廓与简易单区 layout（BIMgent Design Layer 思路，无 Vectorworks）。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as e:
    print(json.dumps({"ok": False, "error": f"缺少 opencv: {e}；请 pip install -r server/python/sketch/requirements.txt"}))
    sys.exit(1)


def largest_polygon(contours, min_area_ratio=0.02):
    if not contours:
        return None
    areas = [(cv2.contourArea(c), c) for c in contours]
    areas.sort(key=lambda x: x[0], reverse=True)
    img_area = areas[0][0] if areas else 1
    for area, c in areas:
        if area < 100:
            continue
        if area / max(img_area, 1) < min_area_ratio and len(areas) > 1:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.015 * peri, True)
        if len(approx) >= 3:
            return approx.reshape(-1, 2).astype(float)
    return None


def normalize_boundary(pts: np.ndarray, target_span: float = 10.0):
    pts = pts.copy()
    pts -= pts.min(axis=0)
    span = max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min(), 1e-6)
    scale = target_span / span
    pts *= scale
    ring = pts.tolist()
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring, scale


def door_segment_on_edge(a, b, door_width=1.2):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    el = (dx * dx + dy * dy) ** 0.5
    if el < 1e-6:
        return a, b
    ux, uy = dx / el, dy / el
    mx, my = (ax + bx) / 2, (ay + by) / 2
    half = min(door_width / 2, el / 2 - 0.05)
    return [mx - ux * half, my - uy * half], [mx + ux * half, my + uy * half]


def entry_on_bottom_edge(ring_open):
    """取最靠下的边作为外门 host（简化）。"""
    n = len(ring_open)
    best_i, best_y = 0, float("inf")
    for i in range(n):
        y = (ring_open[i][1] + ring_open[(i + 1) % n][1]) / 2
        if y < best_y:
            best_y = y
            best_i = i
    a = ring_open[best_i]
    b = ring_open[(best_i + 1) % n]
    return a, b, best_i


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    img = cv2.imread(str(args.image))
    if img is None:
        print(json.dumps({"ok": False, "error": f"无法读取图像 {args.image}"}))
        sys.exit(1)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, bw = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = np.ones((3, 3), np.uint8)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    poly = largest_polygon(contours)
    if poly is None:
        print(json.dumps({"ok": False, "error": "未检测到闭合外轮廓，请换更清晰草图或改用文字描述"}))
        sys.exit(1)

    ring, scale = normalize_boundary(poly)

    def poly_area(ring_open):
        s = 0.0
        n = len(ring_open)
        for i in range(n):
            j = (i + 1) % n
            s += ring_open[i][0] * ring_open[j][1] - ring_open[j][0] * ring_open[i][1]
        return abs(s) / 2.0

    ring_open = ring[:-1]
    area_m2 = poly_area(ring_open)
    outline = {
        "boundary": ring_open,
        "origin": [0, 0],
        "units": "m",
        "assumptions": [
            f"草图矢量化外轮廓，归一化外接约 10 m，估算面积约 {area_m2:.1f} m²"
        ],
    }
    outline_path = args.out_dir / "outline.json"
    outline_path.write_text(json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8")

    preview = img.copy()
    pts_i = np.array(ring_open, dtype=np.int32).reshape(-1, 1, 2)
    cv2.polylines(preview, [pts_i], True, (0, 120, 255), 2)
    preview_path = args.out_dir / "sketch-preview.png"
    cv2.imwrite(str(preview_path), preview)

    ea, eb, _ = entry_on_bottom_edge(ring_open)
    seg_a, seg_b = door_segment_on_edge(ea, eb)
    entry_id = "entry_edge"
    layout = {
        "schemaVersion": 2,
        "spaces": [{
            "id": "main",
            "usage": "主要空间",
            "enclosed": False,
            "boundary": ring_open,
        }],
        "boundaries": [{
            "id": entry_id,
            "segment": [seg_a, seg_b],
            "kind": "wall",
            "leftSpaceId": "outside",
            "rightSpaceId": "main",
        }],
        "openings": [{
            "id": "op_entry",
            "hostBoundaryId": entry_id,
            "typeId": "door-single-900",
            "position": 1.0,
            "width": 0.9,
            "height": 2.1,
        }],
        "doors": [{
            "id": "d_entry",
            "openingId": "op_entry",
            "swing": "left",
            "connects": ["outside", "main"],
        }],
        "windows": [],
        "assumptions": ["草图快速路径：单区铺满外轮廓；多房间请继续在对话中说明"],
        "unmetRequirements": [],
    }

    print(json.dumps({
        "ok": True,
        "outlinePath": "inputs/outline.json",
        "previewPath": "inputs/sketch-preview.png",
        "boundaryVertices": len(ring_open),
        "layout": layout,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
