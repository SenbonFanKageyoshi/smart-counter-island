'use strict';
/* 通过 GitHub REST API 推送本地提交（github.com 直连不通时的替代方案）
   用法: node scripts/git-push-api.js <token> <commit> <parent> <branch> */
const { execSync } = require('child_process');
const https = require('https');

const [, , token, commit, parent, branch = 'main'] = process.argv;
if (!token || !commit || !parent) {
  console.error('用法: node scripts/git-push-api.js <token> <commit> <parent> <branch>');
  process.exit(1);
}
const REPO = 'SenbonFanKageyoshi/smart-counter-island';
const BASE = `https://api.github.com/repos/${REPO}`;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      BASE + path,
      { method, headers: { Authorization: `token ${token}`, 'User-Agent': 'sci-push', 'Content-Type': 'application/json', 'Content-Length': data ? data.length : 0 } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const parentFull = execSync(`git rev-parse ${parent}`, { encoding: 'utf8' }).trim();
  const commitFull = execSync(`git rev-parse ${commit}`, { encoding: 'utf8' }).trim();
  console.log(`parent=${parentFull} commit=${commitFull}`);

  // 1) 变更文件列表（相对父提交）
  const diffOut = execSync(`git diff --name-status ${parentFull} ${commitFull}`, { encoding: 'utf8' });
  const files = [];
  for (const line of diffOut.split('\n').filter(Boolean)) {
    const m = line.match(/^([AM])\s+(.+)$/);
    if (m) files.push({ status: m[1], path: m[2].trim() });
  }
  console.log(`变更文件: ${files.length}`);

  // 2) 上传 blob（用提交内容）
  const treeItems = [];
  for (const f of files) {
    const content = execSync(`git show ${commitFull}:${f.path}`);
    const b64 = content.toString('base64');
    const blob = await api('POST', '/git/blobs', { content: b64, encoding: 'base64' });
    if (!blob.sha) throw new Error(`blob 失败: ${f.path} -> ${JSON.stringify(blob)}`);
    treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ok: ${f.path}`);
  }

  // 3) 父提交的 tree
  const parentCommit = await api('GET', `/git/commits/${parentFull}`);
  const baseTree = parentCommit.tree.sha;

  // 4) 创建 tree
  const tree = await api('POST', '/git/trees', { base_tree: baseTree, tree: treeItems });
  if (!tree.sha) throw new Error('tree 失败: ' + JSON.stringify(tree));

  // 5) 创建 commit
  const msg = execSync(`git log -1 --format=%s ${commitFull}`, { encoding: 'utf8' }).trim();
  const newCommit = await api('POST', '/git/commits', { message: msg, tree: tree.sha, parents: [parentFull] });
  if (!newCommit.sha) throw new Error('commit 失败: ' + JSON.stringify(newCommit));

  // 6) 更新分支引用
  const ref = await api('PATCH', `/git/refs/heads/${branch}`, { sha: newCommit.sha, force: true });
  console.log(`PUSHED: ${branch} -> ${newCommit.sha} (${msg})`);
  console.log(JSON.stringify({ ref: ref && ref.ref, sha: newCommit.sha }));
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
