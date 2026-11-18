#!/usr/bin/env python3
"""
判断 iOS 模拟器截图是不是「白屏 / 黑屏」。

为什么需要它：
冒烟测试里 App 进程活着、也没崩溃报告，但 WebView 完全可能停在白屏
（Capacitor 最常见的一种失败：页面加载失败、JS 报错后没渲染）。
这种状态光看 `simctl launch` 的退出码是发现不了的，必须看画面。

为什么不用 PIL：
GitHub 的 macos runner 上系统自带的 python3 没有装 Pillow，装它要额外
一两分钟。这里借 macOS 自带的 `sips` 把 PNG 转成未压缩 BMP，自己解析
像素——零依赖，跑得还快。

判定方法：
先裁掉顶部状态栏（时间/电量图标自带对比度，会让纯白页面显得「有内容」），
再统计剩下区域的颜色种数和「内容像素占比」——即有多少像素明显不同于
出现次数最多的那个颜色。

为什么不用标准差做主判据：
真实 UI 往往很素（白底 + 灰分隔线 + 少量黑字），亮度标准差可能只有 7 左右，
和「白底上有个加载小圆点」难以区分。而白屏的特征非常干净：主色占比接近 100%。
所以主判据是 content_ratio，标准差只作为诊断信息打印。

已知取舍：整屏只有一个颜色的界面（例如纯品牌色的全屏 loading）会被判成空白。
这种画面和白屏在像素层面确实无法区分，需要结合 [hermes-node] 启动日志一起看。

用法：
  python3 scripts/sim_screenshot_check.py shot.png
  python3 scripts/sim_screenshot_check.py shot.png --min-content 0.005

退出码：0 画面有内容；3 判定为空白；4 脚本自身出错（sips 失败/格式不支持）。
"""

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile


def png_to_bmp(png_path: str, resample_width: int) -> str:
    """用 sips 转成 BMP，顺带缩到指定宽度（像素少，统计快，且抗噪）。"""
    fd, bmp_path = tempfile.mkstemp(suffix=".bmp")
    os.close(fd)
    cmd = [
        "sips",
        "--resampleWidth", str(resample_width),
        "-s", "format", "bmp",
        png_path,
        "--out", bmp_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"sips 转换失败: {r.stderr.strip() or r.stdout.strip()}")
    if not os.path.exists(bmp_path) or os.path.getsize(bmp_path) < 54:
        raise RuntimeError("sips 没有产出有效 BMP")
    return bmp_path


def read_bmp(path: str):
    """解析未压缩 BMP，返回 (width, height, pixels)，pixels 为自顶向下的 (b,g,r) 列表。"""
    data = open(path, "rb").read()
    if data[:2] != b"BM":
        raise RuntimeError("不是 BMP 文件")

    offset = struct.unpack_from("<I", data, 10)[0]
    dib_size = struct.unpack_from("<I", data, 14)[0]
    width = struct.unpack_from("<i", data, 18)[0]
    height = struct.unpack_from("<i", data, 22)[0]
    bpp = struct.unpack_from("<H", data, 28)[0]
    compression = struct.unpack_from("<I", data, 30)[0]

    if dib_size < 40 or compression != 0 or bpp not in (24, 32):
        raise RuntimeError(f"不支持的 BMP 变体 (dib={dib_size}, bpp={bpp}, comp={compression})")

    bottom_up = height > 0
    height = abs(height)
    stride = ((width * bpp + 31) // 32) * 4

    rows = []
    for y in range(height):
        src_y = (height - 1 - y) if bottom_up else y
        base = offset + src_y * stride
        row = []
        for x in range(width):
            p = base + x * (bpp // 8)
            row.append((data[p], data[p + 1], data[p + 2]))
        rows.append(row)
    return width, height, rows


def analyze(rows, top_cut: float, bottom_cut: float):
    h = len(rows)
    y0 = int(h * top_cut)
    y1 = int(h * bottom_cut)
    if y1 <= y0:
        y0, y1 = 0, h

    counts: dict[tuple[int, int, int], int] = {}
    total = 0
    s = 0.0
    s2 = 0.0
    for row in rows[y0:y1]:
        for (b, g, r) in row:
            key = (r >> 2, g >> 2, b >> 2)  # 量化到 6bit，抗压缩噪点
            counts[key] = counts.get(key, 0) + 1
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            s += lum
            s2 += lum * lum
            total += 1

    mean = s / total if total else 0.0
    var = max(0.0, (s2 / total) - mean * mean) if total else 0.0
    dominant = max(counts.values()) if counts else 0
    content = 1.0 - (dominant / total) if total else 0.0

    return {
        "rows_analyzed": y1 - y0,
        "pixels": total,
        "unique_colors": len(counts),
        "dominant_ratio": round(dominant / total if total else 1.0, 4),
        "content_ratio": round(content, 4),
        "mean_luma": round(mean, 2),
        "stddev": round(var ** 0.5, 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("png")
    ap.add_argument("--resample-width", type=int, default=160)
    ap.add_argument("--top-cut", type=float, default=0.08, help="裁掉顶部比例（状态栏）")
    ap.add_argument("--bottom-cut", type=float, default=0.95)
    ap.add_argument("--min-variety", type=int, default=3, help="颜色种数下限")
    ap.add_argument("--min-content", type=float, default=0.005,
                    help="非主色像素占比下限（默认 0.5%）")
    args = ap.parse_args()

    if not os.path.exists(args.png):
        print(json.dumps({"ok": False, "error": f"找不到截图: {args.png}"}, ensure_ascii=False))
        return 4

    try:
        bmp = png_to_bmp(args.png, args.resample_width)
        try:
            w, h, rows = read_bmp(bmp)
        finally:
            os.unlink(bmp)
    except Exception as e:  # noqa: BLE001 - 交给上层判断，不吞掉退出码
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 4

    stats = analyze(rows, args.top_cut, args.bottom_cut)
    ok = (
        stats["unique_colors"] >= args.min_variety
        and stats["content_ratio"] >= args.min_content
    )

    result = {
        "ok": ok,
        "width": w,
        "height": h,
        **stats,
        "thresholds": {
            "min_variety": args.min_variety,
            "min_content": args.min_content,
        },
    }
    print(json.dumps(result, ensure_ascii=False))

    if not ok:
        print(
            f"::warning::截图疑似空白：主色占比 {stats['dominant_ratio']:.1%}、"
            f"内容像素 {stats['content_ratio']:.2%}、颜色 {stats['unique_colors']} 种"
            f"（阈值 content≥{args.min_content:.1%}、variety≥{args.min_variety}）",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
