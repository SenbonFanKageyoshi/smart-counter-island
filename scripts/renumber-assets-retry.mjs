import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/* 补完最老 4 个 release 的附件改名。用法:
     node --use-system-ca scripts/renumber-assets-retry.mjs <token>

   和主脚本的差别只有一个，但是关键的那个：
   **下载改走 curl**（--retry 8 + -C - 断点续传 + --ssl-no-revoke）。
   主脚本用 Node fetch 直接拉 78MB 的 exe，每次都 terminated；
   curl 能断点续传，断了再从断点接着下。
   下载完先核对大小，对得上才上传；上传成功才删旧附件（绝不先删）。 */

const TOKEN = process.argv[2];
const REPO = 'SenbonFanKageyoshi/smart-counter-island';
const H = { Authorization: `token ${TOKEN}`, 'User-Agent': 'sci-renumber', Accept: 'application/vnd.github+json' };
const API = `https://api.github.com/repos/${REPO}`;
const ROOT = 'C:/Users/SenbonFanKageyoshi/Documents/Liquid Glass Counter';
const TMP = ROOT + '/.renumber-tmp';

const MAP = [
  ['v1.0.0', '1.2.0', '1.0.0'],
  ['v1.1.0', '1.3.0', '1.1.0'],
  ['v1.2.0', '1.3.1', '1.2.0'],
  ['v1.3.0', '1.6.0', '1.3.0'],
];

const log = [];
const say = (s) => { log.push(s); console.log(s); };
const api = (p, i = {}) => fetch(`${API}${p}`, { ...i, headers: { ...H, ...(i.headers || {}) } });

async function dlWithCurl(url, out, size) {
  const args = [
    '-L', '-sS',
    '--ssl-no-revoke',
    '--retry', '8', '--retry-delay', '3', '--retry-all-errors',
    '-C', '-',                       // 断点续传
    '--speed-limit', '2048', '--speed-time', '25',
    '--connect-timeout', '15',
    '--max-time', '420',
    '-H', `Authorization: token ${TOKEN}`,
    '-H', 'Accept: application/octet-stream',
    '-H', 'User-Agent: sci-renumber',
    '-o', out, url,
  ];
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      execFileSync('curl', args, { stdio: 'pipe', timeout: 460000 });
    } catch (e) {
      say(`     curl 第 ${attempt} 次中断: ${String(e.message).slice(0, 80)}`);
    }
    if (existsSync(out) && statSync(out).size === size) return true;   // 下全了
    say(`     ${existsSync(out) ? (statSync(out).size / 1048576).toFixed(1) : 0}/${(size / 1048576).toFixed(1)} MB，续传…`);
  }
  return existsSync(out) && statSync(out).size === size;
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  let ok = 0, total = 0;
  for (const [tag, oldV, newV] of MAP) {
    const rel = await (await api(`/releases/tags/${tag}`)).json();
    const todo = (rel.assets || []).filter((a) => a.name.includes(oldV));
    say(`→ ${tag}：待改 ${todo.length} 个附件`);
    for (const a of todo) {
      total++;
      const newName = a.name.split(oldV).join(newV);
      const out = `${TMP}/${a.name}`;
      say(`   ↓ ${a.name} (${(a.size / 1048576).toFixed(1)}MB)`);
      const got = await dlWithCurl(a.url, out, a.size);
      if (!got) { say(`   ✗ 下载仍不完整，跳过（旧附件保持原样，没损失）`); continue; }
      const buf = readFileSync(out);
      const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(newName)}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
        body: buf,
      });
      if (up.status !== 201) { say(`   ✗ 上传 ${newName} 失败 ${up.status}`); continue; }
      const del = await api(`/releases/assets/${a.id}`, { method: 'DELETE' });
      ok++;
      say(`   ✓ ${a.name} → ${newName} (删旧=${del.status})`);
    }
  }
  const final = await (await api('/releases?per_page=30')).json();
  say('—— 最终状态 ——');
  for (const r of final) say(`  ${(r.tag_name || '').padEnd(7)} ${(r.assets || []).map((x) => x.name.replace('SmartCounterIsland-', '')).join(' , ')}`);
  writeFileSync(ROOT + '/shots/renumber-retry-report.txt', log.join('\n') + '\n');
  say(`DONE ${ok}/${total}`);
}
main().catch((e) => { say('ERROR ' + (e && e.stack ? e.stack : e)); process.exit(1); });
