# -*- coding: utf-8 -*-
"""
抓取 packmage 官方盒型立体缩略图到 data/thumbs/

上游接口：https://online.packmage.cn/Content/boximg/{id}-M.png
  - 只有 M 这一档（-S / -L / -B / -XL 都是 404，别再试）
  - ❗ 尺寸**不是**统一的：主流 280x208，但个别盒型上游给的是别的尺寸
      JP002/JP003/JP004/JP023 → 280x280
      Q003 → 173x36   Q006 → 137x173   Q007 → 173x170   Q008 → 141x173
    前端 `.hvp-iso .hvp-thumb` 用 max-width/max-height + object-fit:contain 适配任意比例，
    所以脚本对尺寸不挑剔，只要是合法 PNG 就收。

依赖 data/catalog.js（由 build_v2.js 生成）取盒型清单，所以要在编译之后再跑。

用法（仓库根目录执行）：
    python tools/fetch_thumbs.py                 # 只补缺失的（默认）
    python tools/fetch_thumbs.py --force         # 全部重下
    python tools/fetch_thumbs.py --check         # 只体检，不联网
    python tools/fetch_thumbs.py --allow-missing # 有失败也返回 0（定时同步用；前端还有回源+矢量两级兜底）

退出码：0 全部就位；1 有缺失/损坏（--allow-missing 时降级为 0）
"""
import os, sys, json, time, struct, argparse
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE   = os.path.dirname(os.path.abspath(__file__))
V2     = os.path.dirname(HERE)                       # v2/
THUMBS = os.path.join(V2, 'data', 'thumbs')

BASE = 'https://online.packmage.cn/Content/boximg/%s-M.png'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0 Safari/537.36')
NORM_W, NORM_H = 280, 208      # 主流尺寸，仅用于体检时标注「非主流」
WORKERS = 12


def catalog_ids():
    """从 v2/data/catalog.js 里抠出全部盒型 id（保持原序、去重）"""
    src = open(os.path.join(V2, 'data', 'catalog.js'), encoding='utf-8').read()
    obj = json.loads(src[src.index('{'):src.rindex('}') + 1])
    seen, out = set(), []
    for b in obj.get('boxes') or []:
        i = b.get('id')
        if i and i not in seen:
            seen.add(i)
            out.append(i)
    return out


def probe_png(path):
    """本地文件是不是合法 PNG；是则返回 (w, h, bytes)，否则 None"""
    try:
        with open(path, 'rb') as f:
            d = f.read()
    except OSError:
        return None
    if len(d) < 24 or d[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    w, h = struct.unpack('>II', d[16:24])
    return (w, h, len(d))


def fetch_one(box_id, force):
    dst = os.path.join(THUMBS, box_id + '-M.png')
    if not force and probe_png(dst):
        return (box_id, 0, 'skip')

    last = 'fail'
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                BASE % box_id,
                headers={'User-Agent': UA, 'Referer': 'https://online.packmage.cn/'})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 24 or data[:8] != b'\x89PNG\r\n\x1a\n':
                last = 'not-png'
            else:
                with open(dst, 'wb') as f:      # 尺寸不挑，合法就收
                    f.write(data)
                return (box_id, len(data), 'ok')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return (box_id, 0, '404')        # 上游就没这张，别重试
            last = 'http%d' % e.code
        except Exception as e:
            last = type(e).__name__
        time.sleep(0.4 * (attempt + 1))
    return (box_id, 0, last)


def dir_size(path):
    total = 0
    for e in os.scandir(path):
        if e.is_file():
            total += e.stat().st_size
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='全部重下（忽略本地已有）')
    ap.add_argument('--check', action='store_true', help='只体检，不联网')
    ap.add_argument('--allow-missing', action='store_true',
                    help='有失败/缺失也返回 0（定时同步用，避免个别 404 拖垮整条链路）')
    args = ap.parse_args()

    os.makedirs(THUMBS, exist_ok=True)
    ids = catalog_ids()
    print('catalog 盒型数: %d' % len(ids))

    if args.check:
        bad, odd = [], []
        for i in ids:
            got = probe_png(os.path.join(THUMBS, i + '-M.png'))
            if not got:
                bad.append((i, 'missing/corrupt'))
            elif (got[0], got[1]) != (NORM_W, NORM_H):
                odd.append((i, '%dx%d' % (got[0], got[1])))
        print('体检: %d/%d 有效' % (len(ids) - len(bad), len(ids)))
        if odd:
            print('尺寸非 %dx%d 的 %d 个（正常，前端 contain 适配）: %s'
                  % (NORM_W, NORM_H, len(odd), odd[:20]))
        if bad:
            print('❗ 缺失或损坏 %d 个: %s' % (len(bad), bad[:20]))
            return 0 if args.allow_missing else 1
        return 0

    ok = skip = 0
    bad, total = {}, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(fetch_one, i, args.force) for i in ids]
        for n, fu in enumerate(as_completed(futs), 1):
            bid, size, st = fu.result()
            if st == 'ok':
                ok += 1
                total += size
            elif st == 'skip':
                skip += 1
            else:
                bad[bid] = st
            if n % 200 == 0 or n == len(ids):
                print('  %d/%d  %.0fs' % (n, len(ids), time.time() - t0))

    print('')
    print('新下载 %d / 已有跳过 %d / 失败 %d  本次写入 %.2f MB'
          % (ok, skip, len(bad), total / 1048576.0))
    print('目录合计 %.2f MB（%d 个文件）'
          % (dir_size(THUMBS) / 1048576.0, len(os.listdir(THUMBS))))
    if bad:
        from collections import Counter
        print('失败分布: %s' % dict(Counter(bad.values())))
        print('失败清单: %s' % list(bad.items())[:30])
        return 0 if args.allow_missing else 1
    print('全部就位 ✓ 前端从 data/thumbs/ 直接取图')
    return 0


if __name__ == '__main__':
    sys.exit(main())
