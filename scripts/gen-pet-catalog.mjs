#!/usr/bin/env node
/**
 * 生成内置素材清单 assets/pets-catalog.json
 * 数据源：awesome-codex-pet 仓库的 pets.json（作者/许可/描述）+ install-manifest.json（sha256/字节数/图集尺寸）
 * 用法：node scripts/gen-pet-catalog.mjs [--ref main]
 * 说明：清单只含元数据（不含素材本身），程序按需下载图集并用 sha256 校验。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'legeling/awesome-codex-pet';
const args = process.argv.slice(2);
const refIdx = args.indexOf('--ref');
const REF = refIdx >= 0 && args[refIdx + 1] ? args[refIdx + 1] : 'main';

async function grab(file) {
  const tries = [
    'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/' + file,
    'https://cdn.jsdelivr.net/gh/' + REPO + '@' + REF + '/' + file,
  ];
  for (const url of tries) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'sci-catalog' } });
      if (r.ok) return await r.text();
    } catch (e) { /* 换下一个源 */ }
  }
  // 兜底：GitHub contents API（raw 被网关挡掉时用）
  const api = 'https://api.github.com/repos/' + REPO + '/contents/' + file + '?ref=' + REF;
  const r = await fetch(api, { headers: { 'user-agent': 'sci-catalog', accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('拉取失败 ' + file + ' HTTP ' + r.status);
  const j = await r.json();
  return Buffer.from(j.content, 'base64').toString('utf8');
}

const pets = JSON.parse(await grab('pets.json'));
const man = JSON.parse(await grab('install-manifest.json'));
const byId = man.pets || {};
const list = [];
const missing = [];
for (const p of pets) {
  const m = byId[p.slug];
  if (!m) { missing.push(p.slug); continue; }
  list.push({
    id: p.slug,
    name: (p.localized_names && p.localized_names.zh) || p.name || p.slug,
    nameEn: p.name || '',
    author: p.author || m.author || '',
    license: p.license || '',
    category: p.primary_category || '',
    version: m.spriteVersionNumber || p.spriteVersionNumber || 1,
    desc: String(p.description || '').slice(0, 80),
    bytes: m.spritesheetBytes || 0,
    sha256: m.spritesheetSha256 || '',
    w: m.spritesheetWidth || 0,
    h: m.spritesheetHeight || 0,
  });
}
list.sort((a, b) => a.id.localeCompare(b.id));
const out = {
  source: REPO + '@' + REF,
  ref: REF,
  generatedAt: new Date().toISOString().slice(0, 10),
  count: list.length,
  pets: list,
};
const dst = path.join(process.cwd(), 'assets', 'pets-catalog.json');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(out), 'utf8');
console.log('写出 ' + dst + '：' + list.length + ' 条，' + Math.round(fs.statSync(dst).size / 1024) + ' KB');
if (missing.length) console.log('清单里缺 ' + missing.length + ' 条：' + missing.slice(0, 5).join(', '));
const total = list.reduce((s, x) => s + x.bytes, 0);
console.log('素材总量 ' + (total / 1048576).toFixed(1) + ' MB；尺寸样本 ' + list[0].w + 'x' + list[0].h + '；v2 条数 ' + list.filter((x) => x.version === 2).length);
