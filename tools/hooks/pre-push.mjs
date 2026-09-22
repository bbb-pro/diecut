#!/usr/bin/env node
/*
 * pre-push —— 推送前自动部署 Cloudflare Worker（本项目的 `diecut-api` 代理）。
 *
 * 为什么需要它：Worker 不走 GitHub Actions，`git push` 只更新 Pages 上的静态站，
 * 线上 `/api/*` 代理脚本不会跟着变。于是「改了 worker.js 但忘了单独发」会静默造成
 * 前后端不一致（前端要 rm 字段，线上代理还没给）。此 hook 把两件事绑在一起。
 *
 * 触发条件（同时满足才部署）：
 *   1. 推送范围（remoteSha..localSha）里改动了 worker.js 或 wrangler.toml
 *   2. 推送的是 main 分支（推其它分支不动线上；要放开设 CF_DEPLOY_ANY_BRANCH=1）
 *   3. 没设 SKIP_WORKER_DEPLOY=1（也可用 `git push --no-verify` 整个跳过）
 *
 * 用法：
 *   node tools/hooks/pre-push.mjs              # hook 入口（从 stdin 读 ref 行）
 *   node tools/hooks/pre-push.mjs --check      # 只判断不部署（dry run，排查用）
 *   node tools/hooks/pre-push.mjs --force      # 无视变更判断，直接部署当前 worker.js
 *
 * 策略：★ 永不阻塞 push。部署失败只在终端醒目告警（静态站该上还是要上），
 *       退出码始终 0；要强制阻断请自行把 FAIL_HARD 改成 true。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TAG = '[pre-push]';
const FAIL_HARD = false;
const ZERO = /^0{40}$/;
const TRIGGER_FILES = ['worker.js', 'wrangler.toml'];
const MAIN_REF = 'refs/heads/main';

const ARGS = process.argv.slice(2);
const CHECK_ONLY = ARGS.includes('--check');
const FORCE = ARGS.includes('--force');

const DEPLOY_SCRIPT =
  process.env.CF_DEPLOY_SCRIPT ||
  path.join(os.homedir(), '.workbuddy', 'skills', 'cloudflare-worker-deploy', 'deploy.mjs');

const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

// 只接受真正的 40 位 sha —— 注意 `git rev-parse <未知ref>` 会把参数原名回显到
// stdout 且不一定返回非 0，直接拿它当 sha 会静默得到 "origin/main" 这种字符串。
function revParse(ref) {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.status !== 0) return '';
  const s = (r.stdout || '').trim();
  return /^[0-9a-f]{40}$/.test(s) ? s : '';
}

// 找到"远端同步点"。⚠️ 本机这个仓库的 remote-tracking ref **写不进去**：
// `git fetch origin` / `git update-ref refs/remotes/origin/main` 都报成功
// （fetch 甚至打印 `* [new branch] main -> origin/main`），但 `.git/refs/remotes`
// 始终为空、`git branch -vv` 显示 `origin/main: gone`。配置本身正常
// （repositoryformatversion=0、无 extensions/reftable/commondir），node 直写同目录却可见，
// 所以判定为环境层面的怪象 → 干脆不依赖它，改成多级回退：
//   1) remote-tracking ref（若哪天真能用了，自动走这条，最快且不联网）
//   2) `git ls-remote origin refs/heads/main` —— 权威网络查询，~1s，仅手动/--check 场景才走
//   3) FETCH_HEAD（上次 fetch/push 的点，可能陈旧）
//   4) 全都拿不到 → 返回空，调用方按"新分支"保守处理
function remoteBaseRef() {
  return revParse('refs/remotes/origin/main') || revParse('origin/main');
}
function lsRemoteBase() {
  const r = git(['ls-remote', 'origin', 'refs/heads/main']);
  if (r.status !== 0) return '';
  const m = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec((r.stdout || '').trim());
  return m ? m[1] : '';
}
function resolveBase() {
  const local = remoteBaseRef();
  if (local) return local;
  const net = lsRemoteBase();
  if (net) return net;
  return revParse('FETCH_HEAD') || '';
}

function finish(code) {
  process.exit(code === 0 || !FAIL_HARD ? 0 : code);
}

/* ---------- 0. 逃生舱 ---------- */
if (process.env.SKIP_WORKER_DEPLOY === '1') {
  log('SKIP_WORKER_DEPLOY=1，跳过 Worker 自动部署');
  finish(0);
}

/* ---------- 1. 定位仓库根 ---------- */
const rootR = git(['rev-parse', '--show-toplevel']);
if (rootR.status !== 0) {
  warn('不在 git 仓库内，跳过');
  finish(0);
}
const ROOT = rootR.stdout.trim();
process.chdir(ROOT);

/* ---------- 2. 读取推送范围 ---------- */
// 只有 stdin 是管道时才读（git 推送时会把 ref 行写进来）；
// 手动运行 / TTY 下直接读会阻塞，改用 HEAD vs origin/main 兜底。
let refLines = [];
if (!FORCE && !process.stdin.isTTY) {
  try {
    refLines = fs
      .readFileSync(0, 'utf8') // stdin：<localRef> <localSha> <remoteRef> <remoteSha>
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+/));
  } catch (e) {
    warn('读取 stdin 失败：' + e.message);
  }
}
if (!FORCE && refLines.length === 0) {
  // 手动运行：拿 HEAD 与「远端同步点」比（--check 自检也走这条）
  const head = revParse('HEAD');
  const base = resolveBase();
  if (head && base) {
    refLines = [['refs/heads/main', head, MAIN_REF, base]];
  } else if (head) {
    warn('找不到远端同步点（origin/main / FETCH_HEAD 都不可用）→ 按"新分支"处理');
    refLines = [['refs/heads/main', head, MAIN_REF, '0'.repeat(40)]];
  }
}

/* ---------- 3. 判断是否需要部署 ---------- */
let need = false;
let reason = '';
const allowAnyBranch = process.env.CF_DEPLOY_ANY_BRANCH === '1';

if (FORCE) {
  need = true;
  reason = '--force 强制部署';
} else if (refLines.length === 0) {
  reason = '未能确定推送范围';
} else {
  for (const [lref, lsha, rref, rsha] of refLines) {
    if (!lsha || ZERO.test(lsha)) continue; // 删除分支，不上线
    const onMain = lref === MAIN_REF || lref.endsWith('/main') || rref === MAIN_REF;
    if (!onMain && !allowAnyBranch) {
      reason = reason || `非 main 分支（${lref}），不动线上`;
      continue;
    }

    let changed = null; // null = 无法判断
    if (rsha && !ZERO.test(rsha)) {
      const d = git(['diff', '--name-only', `${rsha}..${lsha}`, '--', ...TRIGGER_FILES]);
      if (d.status === 0) {
        changed = d.stdout.split(/\r?\n/).filter(Boolean);
      } else {
        // 远端 sha 本地没有：fetch 一次再试
        git(['fetch', 'origin', '--quiet']);
        const d2 = git(['diff', '--name-only', `${rsha}..${lsha}`, '--', ...TRIGGER_FILES]);
        if (d2.status === 0) changed = d2.stdout.split(/\r?\n/).filter(Boolean);
      }
    } else {
      // 新分支：无法算差异 → 只要树里有 worker.js 就认为需要
      const has = git(['cat-file', '-e', `${lsha}:worker.js`]);
      changed = has.status === 0 ? ['worker.js'] : [];
    }

    if (changed === null) {
      need = true;
      reason = '远端提交本地缺失、无法比对差异 → 保守部署一次';
      break;
    }
    if (changed.length) {
      need = true;
      reason = `推送范围含 ${changed.join(' + ')}`;
      break;
    }
  }
  if (!need) reason = reason || '本次推送未触及 worker.js / wrangler.toml';
}

log(`仓库 ${ROOT}`);
log(`判断：${need ? '✔ 需要部署' : '— 无需部署'}（${reason}）`);

/* ---------- 3.5 工作区未提交改动提醒 ---------- */
const dirtyR = git(['status', '--porcelain', '--', ...TRIGGER_FILES]);
if (dirtyR.status === 0 && dirtyR.stdout.trim()) {
  warn('⚠️ 工作区里 worker.js / wrangler.toml 还有未提交的改动 —— 本次部署的是「工作区当前内容」（deploy.mjs 直接读文件，不是上次提交的版本）');
}

if (!need) finish(0);

if (CHECK_ONLY) {
  log('--check 模式：仅判断，不实际部署');
  finish(0);
}

/* ---------- 4. 部署 ---------- */
if (!fs.existsSync(DEPLOY_SCRIPT)) {
  warn(`找不到部署脚本：${DEPLOY_SCRIPT}`);
  warn('请先确保技能 cloudflare-worker-deploy 已安装，或用 CF_DEPLOY_SCRIPT 指定路径');
  warn('⚠️ 线上 Worker 仍是旧版，记得手动处理！');
  finish(1);
}

log(`调用 ${path.relative(os.homedir(), DEPLOY_SCRIPT)} …`);
const dep = spawnSync(process.execPath, [DEPLOY_SCRIPT, path.join(ROOT, 'worker.js')], {
  stdio: 'inherit',
  cwd: ROOT,
});

if (dep.status !== 0) {
  warn('⚠️ Worker 自动部署失败 —— 静态站照常上线，但线上 /api/* 仍是旧版！');
  warn('   排错后手动重跑：node tools/hooks/pre-push.mjs --force');
  finish(1);
}

log('✔ Worker 已随本次推送上线（立即生效，无 CDN 传播窗口）');
finish(0);
