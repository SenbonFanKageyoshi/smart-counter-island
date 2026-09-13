'use strict';
/* 创建 GitHub Release 并上传 exe 资源（github.com 直连不通时用 REST API）
   用法: node scripts/gh-release.js <token> <targetSha> [notesFile]
   版本号取自 package.json；说明文字取自 notesFile（默认 release-notes-<版本>.md） */
const fs = require('fs');
const path = require('path');
const https = require('https');

const [, , token, target, notesArg] = process.argv;
const VERSION = require('../package.json').version;
const TAG = `v${VERSION}`;
const NOTES = notesArg || path.join(__dirname, '..', `release-notes-${VERSION}.md`);

if (!token || !target) {
  console.error('用法: node scripts/gh-release.js <token> <targetSha> [notesFile]');
  process.exit(1);
}
const REPO = 'SenbonFanKageyoshi/smart-counter-island';
const TITLE = `${TAG} 液态玻璃（GPU）· 壁纸轮换 · 开机自启状态修正`;

function api(host, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body && !Buffer.isBuffer(body) ? Buffer.from(JSON.stringify(body)) : body;
    const req = https.request(
      { host, method, path: pathname, headers: Object.assign({ Authorization: `token ${token}`, 'User-Agent': 'sci-release' }, headers || {}, data ? { 'Content-Length': data.length } : {}) },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = buf;
          try { parsed = JSON.parse(buf); } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(NOTES)) throw new Error(`缺少说明文件: ${NOTES}`);
  const BODY = fs.readFileSync(NOTES, 'utf8');
  const files = [
    path.join('release', `SmartCounterIsland-Setup-${VERSION}.exe`),
    path.join('release', `SmartCounterIsland-${VERSION}-portable.exe`),
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`缺少安装包: ${f}`);
  }

  const create = await api('api.github.com', 'POST', `/repos/${REPO}/releases`, {
    tag_name: TAG,
    target_commitish: target,
    name: TITLE,
    body: BODY,
    draft: false,
    prerelease: false,
  }, { 'Content-Type': 'application/json' });

  let rel = create.body;
  if (create.status === 422) {
    console.log('Release 已存在，改为更新说明/复用');
    const existing = await api('api.github.com', 'GET', `/repos/${REPO}/releases/tags/${TAG}`);
    rel = existing.body;
    const upd = await api('api.github.com', 'PATCH', `/repos/${REPO}/releases/${rel.id}`, { name: TITLE, body: BODY, target_commitish: target }, { 'Content-Type': 'application/json' });
    rel = upd.body || rel;
  }
  if (!rel || !rel.id) throw new Error(`创建 Release 失败(${create.status}): ${JSON.stringify(create.body)}`);
  console.log(`RELEASE id=${rel.id} tag=${rel.tag_name} url=${rel.html_url}`);

  const existingAssets = await api('api.github.com', 'GET', `/repos/${REPO}/releases/${rel.id}/assets`);
  const names = new Set((existingAssets.body || []).map((a) => a.name));

  for (const f of files) {
    const name = path.basename(f);
    if (names.has(name)) {
      console.log(`  跳过（已存在）: ${name}`);
      continue;
    }
    const data = fs.readFileSync(f);
    const up = await api('uploads.github.com', 'POST', `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, data, { 'Content-Type': 'application/octet-stream' });
    if (up.status >= 300) throw new Error(`上传失败 ${name} (${up.status}): ${JSON.stringify(up.body)}`);
    console.log(`  上传成功: ${name} (${(data.length / 1048576).toFixed(1)} MB) -> ${up.body.browser_download_url}`);
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
