#!/usr/bin/env python3
"""
判断 iOS 模拟器截图是不是「白屏 / 黑屏」。

为什么需要它：
冒烟测试里 App 进程活着、也没有崩溃报告，但 WebView 完全可能停在白屏
（Capacitor 最常见的失败：页面加载失败、JS 报错后没渲染）。
这种状态靠 `simctl launch` 的退出码是发现不了的，必须看画面。

为什么自己解 PNG：
第一版用 `sips -s format bmp` 中转，结果 macOS 的 sips 输出的是
BITMAPV5HEADER + BI_BITFIELDS（dib=124, comp=3），不是教科书里的
24 位未压缩格式，在 CI 上直接报「不支持的 BMP 变体」。PNG 的结构是死的，
自己解反而更稳：只用到 zlib，零第三方依赖（runner 上没有 Pillow）。

sips 仍然用，但只负责「缩小」这一件事：把 1179x2556 的截图缩到 160 宽再解，
Python 里做逐字节反滤波才不会慢到几十秒。

判定方法：
裁掉顶部状态栏（时间/电量自带对比度，会让纯白页面显得「有内容」），统计：
  - content_ratio：与主色不同的像素占比
  - unique_colors：颜色种数（6bit 量化后）
白屏的特征是主色占比接近 100%、content 几乎为 0。

已知取舍：整屏只有一个颜色的界面（例如纯品牌色的全屏 loading）会被判成空白。
这种画面和白屏在像素层面确实无法区分，需要结合 [hermes-node] 启动日志一起看。

用法：
  python3 scripts/sim_screenshot_check.py shot.png
  python3 scripts/sim_screenshot_check.py shot.png --min-content 0.01

退出码：0 画面有内容；3 判定为空白；4 脚本自身出错（文件缺失/格式不支持）。
"""

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}  # gray, rgb, palette, gray+alpha, rgba


def shrink(png_path: str, width: int) -> str:
    """有 sips 就缩小一份副本（只为加速），没有就用原图。"""
    fd, out = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        r = subprocess.run(
            ["sips", "--resampleWidth", str(width), png_path, "--out", out],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and os.path.getsize(out) > 0:
            return out
    except FileNotFoundError:
        pass  # 非 macOS，例如本地跑单元测试
    os.unlink(out)
    return png_path


def decode_png(path: str):
    """解 8bit 非隔行 PNG，返回 (width, height, rows, channels, palette)。"""
    data = open(path, "rb").read()
    if data[:8] != PNG_MAGIC:
        raise RuntimeError("不是 PNG 文件")

    pos = 8
    idat = bytearray()
    palette = None
    width = height = depth = color_type = interlace = None
    while pos + 8 <= len(data):
        length = struct.unpack_from(">I", data, pos)[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif ctype == b"PLTE":
            palette = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    if depth != 8:
        raise RuntimeError(f"只支持 8bit 色深，实际 {depth}")
    if interlace != 0:
        raise RuntimeError("不支持隔行扫描 PNG")
    if color_type not in CHANNELS:
        raise RuntimeError(f"不支持的 PNG 颜色类型 {color_type}")

    channels = CHANNELS[color_type]
    stride = width * channels
    raw = zlib.decompress(bytes(idat))

    rows = []
    prev = bytearray(stride)
    i = 0
    for _ in range(height):
        ft = raw[i]
        i += 1
        line = bytearray(raw[i:i + stride])
        i += stride

        if ft == 0:
            pass
        elif ft == 1:  # Sub
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 0xFF
        elif ft == 2:  # Up
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ft == 3:  # Average
            for x in range(stride):
                left = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ft == 4:  # Paeth
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        else:
            raise RuntimeError(f"未知的滤波类型 {ft}")

        rows.append(line)
        prev = line

    return width, height, rows, channels, palette, color_type


def sample_pixels(rows, channels, color_type, palette, top_cut, bottom_cut, step):
    """按步长采样，产出 (r, g, b)。调色板图先转成真彩。"""
    h = len(rows)
    y0 = max(0, int(h * top_cut))
    y1 = min(h, int(h * bottom_cut))
    if y1 <= y0:
        y0, y1 = 0, h

    for y in range(y0, y1, step):
        row = rows[y]
        for x in range(0, len(row) // channels, step):
            p = x * channels
            if color_type == 0 or color_type == 4:
                v = row[p]
                yield v, v, v
            elif color_type == 2 or color_type == 6:
                yield row[p], row[p + 1], row[p + 2]
            else:  # 调色板
                idx = row[p] * 3
                if palette and idx + 2 < len(palette):
                    yield palette[idx], palette[idx + 1], palette[idx + 2]
                else:
                    yield 0, 0, 0


def analyze(path: str, top_cut: float, bottom_cut: float):
    width, height, rows, channels, palette, color_type = decode_png(path)

    total_px = width * height
    step = max(1, int((total_px / 40_000) ** 0.5))  # 采样约 4 万个点

    counts: dict[tuple[int, int, int], int] = {}
    total = 0
    s = 0.0
    s2 = 0.0
    for r, g, b in sample_pixels(rows, channels, color_type, palette, top_cut, bottom_cut, step):
        key = (r >> 2, g >> 2, b >> 2)  # 6bit 量化，抗抗锯齿噪点
        counts[key] = counts.get(key, 0) + 1
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        s += lum
        s2 += lum * lum
        total += 1

    if not total:
        raise RuntimeError("没有采到像素")

    mean = s / total
    var = max(0.0, s2 / total - mean * mean)
    dominant = max(counts.values())
    return {
        "width": width,
        "height": height,
        "sampled": total,
        "unique_colors": len(counts),
        "dominant_ratio": round(dominant / total, 4),
        "content_ratio": round(1 - dominant / total, 4),
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
                    help="非主色像素占比下限（默认 0.005，约千分之五）")
    args = ap.parse_args()

    if not os.path.exists(args.png):
        print(json.dumps({"ok": False, "error": f"找不到截图: {args.png}"}, ensure_ascii=False))
        return 4

    small = shrink(args.png, args.resample_width)
    try:
        stats = analyze(small, args.top_cut, args.bottom_cut)
    except Exception as e:  # noqa: BLE001 - 用退出码区分"空白"和"脚本坏了"
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 4
    finally:
        if small != args.png and os.path.exists(small):
            os.unlink(small)

    ok = stats["unique_colors"] >= args.min_variety and stats["content_ratio"] >= args.min_content
    print(json.dumps({
        "ok": ok,
        **stats,
        "thresholds": {"min_variety": args.min_variety, "min_content": args.min_content},
    }, ensure_ascii=False))

    if not ok:
        print(
            f"::warning::截图疑似空白：主色占比 {stats['dominant_ratio']:.1%}、"
            f"内容像素 {stats['content_ratio']:.2%}、颜色 {stats['unique_colors']} 种"
            f"（阈值 content>={args.min_content:.3f}、variety>={args.min_variety}）",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
