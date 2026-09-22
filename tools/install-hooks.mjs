#!/usr/bin/env node
/*
 * 安装/修复本仓库的 git hooks（新机器 clone 后跑一次即可）。
 *
 *   node tools/install-hooks.mjs           # 安装
 *   node tools/install-hooks.mjs --status  # 只看当前状态
 *
 * .git/hooks/ 不进版本库，所以真逻辑放在 tools/hooks/*.mjs（入库），
 * 这里只往 .git/hooks/ 写一个不含 coreutils 依赖的薄壳（本机 Git Bash 的
 * cat/ls/head/dirname 经常整体缺失，壳子只用 shell 内建 + node 绝对路径）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootR = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (rootR.status !== 0) {
  console.error('✗ 不在 git 仓库内');
  process.exit(1);
}
const ROOT = rootR.stdout.trim();
const HOOKS_DIR = path.join(ROOT, '.git', 'hooks');
const STATUS_ONLY = process.argv.includes('--status');

// core.hooksPath 若被改过，.git/hooks 会被忽略 —— 先查出来
const hp = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
const hooksPath = (hp.stdout || '').trim();

// node 候选路径：优先「当前跑这个脚本的 node」，写进壳子最稳
// （一律转成 MSYS 风格 /c/... ，否则 sh 里 [ -x "C:\..." ] 判不出可执行）
const toPosix = (p) => String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase());
const NODE_CANDIDATES = [
  ...new Set(
    [
      process.execPath,
      '/c/Users/Administrator/.workbuddy/binaries/node/versions/22.12.0/node.exe',
      '/c/Program Files/nodejs/node.exe',
    ]
      .filter(Boolean)
      .map(toPosix)
      // MSYS 风格路径才写进壳子（原生的 Windows 路径到此已被转好）
      .filter((p) => p.startsWith('/'))
  ),
];

const shellScript = `#!/bin/sh
# 自动生成 by tools/install-hooks.mjs —— 不要手改，改 tools/hooks/pre-push.mjs
# 作用：推送前把有变更的 Cloudflare Worker 自动部署上线（Worker 不走 CI）
# 跳过：git push --no-verify  或  SKIP_WORKER_DEPLOY=1 git push
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  ROOT="\${0%/*}/../.."
fi
S="$ROOT/tools/hooks/pre-push.mjs"
if [ ! -f "$S" ]; then
  exit 0
fi
for N in "$(command -v node 2>/dev/null)"${NODE_CANDIDATES.map((n) => ` "${n}"`).join('')}; do
  if [ -n "$N" ] && [ -x "$N" ]; then
    exec "$N" "$S"
  fi
done
echo "[pre-push] 未找到 node，跳过 Worker 自动部署" >&2
exit 0
`;

const target = path.join(HOOKS_DIR, 'pre-push');

if (STATUS_ONLY) {
  console.log('仓库根     :', ROOT);
  console.log('hooks 目录 :', HOOKS_DIR, fs.existsSync(HOOKS_DIR) ? '✔' : '✗ 不存在');
  console.log('core.hooksPath:', hooksPath || '(未设置 → 用默认 .git/hooks)');
  console.log('pre-push   :', fs.existsSync(target) ? '✔ 已安装' : '✗ 未安装');
  console.log('真逻辑     :', fs.existsSync(path.join(ROOT, 'tools', 'hooks', 'pre-push.mjs')) ? '✔ 在位' : '✗ 缺失');
  console.log('部署脚本   :', fs.existsSync(path.join(os.homedir(), '.workbuddy', 'skills', 'cloudflare-worker-deploy', 'deploy.mjs')) ? '✔ 在位' : '✗ 缺失');
  process.exit(0);
}

fs.mkdirSync(HOOKS_DIR, { recursive: true });
const existed = fs.existsSync(target);
fs.writeFileSync(target, shellScript, 'utf8');
try { fs.chmodSync(target, 0o755); } catch (e) { /* Windows 上无意义，忽略 */ }

console.log(`${existed ? '↻ 已更新' : '✔ 已安装'} ${path.relative(ROOT, target)}`);
if (hooksPath) {
  console.log(`⚠️ 注意：core.hooksPath = ${hooksPath}，git 会忽略 .git/hooks/，请把壳子也放到那里`);
}
console.log('自检：node tools/hooks/pre-push.mjs --check');
