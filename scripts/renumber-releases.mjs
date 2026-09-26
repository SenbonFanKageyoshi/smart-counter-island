import { readFileSync, existsSync, writeFileSync } from 'node:fs';

/* 把已发布的 12 个 release 按时间顺序重排成连续版本号（方案 A）。
   用法: node --use-system-ca scripts/renumber-releases.mjs <token> [--dry] [--fast]

   两阶段，为了快也为了安全：
     阶段一：建新 tag + 改 release 的 tag/标题（纯 API 调用，秒级完成）
     阶段二：并发搬附件 —— **先上传新名字的，成功后才删旧的**
             （旧脚本是"先删后传"，中途挂掉会永久丢附件）
   附件字节来源：本地 release/ 里有同版本 exe 就直接读（跳过下载），否则才下载。
   阶段一按防碰撞顺序：1.2.0 / 1.3.0 / 3.0.0 / 3.0.2 / 3.0.3 既是旧号又是新号，先挪走。 */

const TOKEN = process.argv[2];
const DRY = process.argv.includes('--dry');
const REPO = 'SenbonFanKageyoshi/smart-counter-island';
const H = { Authorization: `token ${TOKEN}`, 'User-Agent': 'sci-renumber', Accept: 'application/vnd.github+json' };
const API = `https://api.github.com/repos/${REPO}`;
const ROOT = 'C:/Users/SenbonFanKageyoshi/Documents/Liquid Glass Counter';
const WORKERS = 4;

const MAP = [
  ['1.2.0', '1.0.0'], ['1.3.0', '1.1.0'], ['3.0.0', '2.0.0'], ['3.0.2', '2.1.0'],
  ['3.0.3', '2.2.0'], ['1.3.1', '1.2.0'], ['1.6.0', '1.3.0'], ['2.0.1', '1.4.0'],
  ['3.0.4', '3.0.0'], ['3.0.5', '3.0.1'], ['3.0.6', '3.0.2'], ['3.0.7', '3.0.3'],
];

const log = [];
const say = (s) => { log.push(s); console.log(s); };
const api = (path, init = {}) => fetch(`${API}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });

/** 附件的新名字：把文件名里的旧版本号换成新版本号 */
const renameAsset = (name, oldV, newV) => name.split(oldV).join(newV);

async function main() {
  const jobs = []; // 阶段二要搬的附件

  // ── 阶段一：tag + 标题（快）──
  for (const [oldV, newV] of MAP) {
    const oldTag = `v${oldV}`, newTag = `v${newV}`;
    const gr = await api(`/releases/tags/${oldTag}`);
    if (gr.status !== 200) { say(`✗ ${oldTag} 取不到 (${gr.status})，跳过`); continue; }
    const rel = await gr.json();
    const refRes = await api(`/git/ref/tags/${oldTag}`);
    if (refRes.status !== 200) { say(`✗ ${oldTag} 无 tag ref，跳过`); continue; }
    const ref = await refRes.json();
    let sha = ref.object.sha;
    if (ref.object.type === 'tag') {
      const tr = await api(`/git/tags/${sha}`);
      if (tr.status === 200) sha = (await tr.json()).object.sha;
    }
    say(`→ ${oldTag} ⇒ ${newTag} (commit ${sha.slice(0, 7)}, 附件 ${rel.assets.length})`);
    if (DRY) { for (const a of rel.assets) jobs.push({ relId: rel.id, asset: a, oldV, newV }); continue; }

    const cr = await api('/git/refs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/tags/${newTag}`, sha }),
    });
    if (cr.status !== 201 && cr.status !== 422) say(`   ! 建 tag ${newTag}: ${cr.status}`);
    const newBody = String(rel.body || '').split(` ${oldV}`).join(` ${newV}`);
    const pr = await api(`/releases/${rel.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: newTag, name: `Smart Counter Island ${newV}`, body: newBody }),
    });
    say(`   ${pr.status === 200 ? '✓' : '✗'} 标题→Smart Counter Island ${newV} (${pr.status})`);
    for (const a of rel.assets || []) jobs.push({ relId: rel.id, asset: a, oldV, newV });
    const dr = await api(`/git/refs/tags/${oldTag}`, { method: 'DELETE' });
    say(`   ${dr.status === 204 ? '✓' : '✗'} 删旧 tag ${oldTag} (${dr.status})`);
  }

  if (DRY) { say(`[dry] 待搬附件 ${jobs.length} 个`); writeFileSync(ROOT + '/shots/renumber-report.txt', log.join('\n') + '\n'); return; }

  // ── 阶段二：并发搬附件（先传新、成功再删旧）──
  say(`—— 阶段二：${jobs.length} 个附件，${WORKERS} 并发 ——`);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      const newName = renameAsset(j.asset.name, j.oldV, j.newV);
      if (newName === j.asset.name) { done++; continue; }
      try {
        // 字节来源：本地同版本 exe 优先（跳过下载）
        const local = `${ROOT}/release/${j.asset.name}`;
        let buf;
        if (existsSync(local)) { buf = readFileSync(local); }
        else {
          const dl = await fetch(j.asset.url, { headers: { ...H, Accept: 'application/octet-stream' } });
          if (!dl.ok) { say(`   ✗ 下载 ${j.asset.name} 失败 ${dl.status}`); continue; }
          buf = Buffer.from(await dl.arrayBuffer());
        }
        const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${j.relId}/assets?name=${encodeURIComponent(newName)}`, {
          method: 'POST',
          headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
          body: buf,
        });
        if (up.status !== 201) { say(`   ✗ 传 ${newName} 失败 ${up.status}`); continue; }
        const del = await api(`/releases/assets/${j.asset.id}`, { method: 'DELETE' });
        done++;
        say(`   ✓ ${j.asset.name} → ${newName} (${(buf.length / 1048576).toFixed(1)}MB${existsSync(local) ? ' 本地' : ' 下载'}, 删旧=${del.status}) [${done}/${jobs.length}]`);
      } catch (e) {
        say(`   ✗ ${newName}: ${e && e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  writeFileSync(ROOT + '/shots/renumber-report.txt', log.join('\n') + '\n');
  say(`DONE ${done}/${jobs.length}`);
}
main().catch((e) => { say('ERROR ' + (e && e.stack ? e.stack : e)); process.exit(1); });
