import { readFileSync, statSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN = process.argv[2];
const SHA = process.argv[3];
const REPO = 'SenbonFanKageyoshi/smart-counter-island';
const root = resolve('C:/Users/SenbonFanKageyoshi/Documents/Liquid Glass Counter');
const ver = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version;
const tag = `v${ver}`;
const body = readFileSync(`${root}/release-notes-${ver}.md`, 'utf8');
const H = { Authorization: `token ${TOKEN}`, 'User-Agent': 'sci-release', Accept: 'application/vnd.github+json' };

// 若同名 tag 的 release 已存在 → 复用（删掉重建，保证说明/附件是最新的）
const listRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: H });
if (listRes.status === 200) {
  const old = await listRes.json();
  console.log('已存在同名 release，删除重建:', old.id);
  await fetch(`https://api.github.com/repos/${REPO}/releases/${old.id}`, { method: 'DELETE', headers: H });
}

const createRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, target_commitish: SHA, name: `Smart Counter Island ${ver} 版本说明`, body, draft: false, prerelease: false }),
});
if (createRes.status !== 201) {
  console.error('创建失败', createRes.status, await createRes.text());
  process.exit(1);
}
const rel = await createRes.json();
console.log('RELEASE', rel.tag_name, rel.html_url);
const up = rel.upload_url.replace('{?name,label}', '');

for (const name of [`SmartCounterIsland-Setup-${ver}.exe`, `SmartCounterIsland-${ver}-portable.exe`]) {
  const p = `${root}/release/${name}`;
  const size = statSync(p).size;
  const buf = readFileSync(p);
  const r = await fetch(`${up}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: buf,
  });
  console.log(r.status === 201 ? `上传成功: ${name} (${(size / 1048576).toFixed(1)} MB)` : `上传失败 ${name} ${r.status} ${await r.text()}`);
}
console.log('DONE');
