// P00: role × module permission matrix from the prototype seed state (redacted dump).
// Usage: node roles.mjs <prototype-seed-state.redacted.json> <out.csv> <out.md>
import fs from 'node:fs';
const [statePath, csvPath, mdPath] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const modules = [...new Set(s.roles.flatMap(r => Object.keys(r.perms)))];
const actions = ['view', 'create', 'edit', 'approve', 'reject', 'scan', 'transfer', 'report', 'pdf', 'settings', 'users'];
const abbr = { view: 'V', create: 'C', edit: 'E', approve: 'A', reject: 'R', scan: 'S', transfer: 'T', report: 'G', pdf: 'P', settings: 'X', users: 'U' };
const q = v => `"${String(v).replace(/"/g, '""')}"`;
const usersBy = id => s.users.filter(u => u.roleId === id);
const csv = [['roleId', 'roleName', 'system', 'userCount', 'module', ...actions].map(q).join(',')];
for (const r of s.roles) for (const m of modules) {
  const p = r.perms[m] || [];
  csv.push([r.id, r.name, r.system ?? '', usersBy(r.id).length, m, ...actions.map(a => (p.includes(a) ? 1 : 0))].map(q).join(','));
}
fs.writeFileSync(csvPath, '﻿' + csv.join('\n'));
const cell = (r, m) => (r.perms[m] || []).map(a => abbr[a] ?? a).join('') || '—';
let md = `# ماتریس نقش و دسترسی پروتوتایپ\n\nمنبع: state اولیه پروتوتایپ (\`reval-state-v9\`)، استخراج خودکار. ${s.roles.length} نقش، ${s.users.length} کاربر نمونه، ${modules.length} ماژول.\n\n`;
md += `راهنما: ${Object.entries(abbr).map(([k, v]) => `${v}=${k}`).join('، ')}\n\n`;
md += `| نقش | کاربران | ${modules.join(' | ')} |\n|---|---|${modules.map(() => '---').join('|')}|\n`;
for (const r of s.roles) md += `| ${r.name} (\`${r.id}\`) | ${usersBy(r.id).length} | ${modules.map(m => cell(r, m)).join(' | ')} |\n`;
md += `\n## محدوده کاربران (scope)\n\n| کاربر | نقش | واحد | scope |\n|---|---|---|---|\n`;
for (const u of s.users) md += `| ${u.id} | ${s.roles.find(r => r.id === u.roleId)?.name ?? u.roleId} | ${u.unit ?? ''} | ${typeof u.scope === 'object' ? JSON.stringify(u.scope) : (u.scope ?? '')} |\n`;
fs.writeFileSync(mdPath, md);
console.log(`roles=${s.roles.length} users=${s.users.length} modules=${modules.join(',')}`);
console.log('scope samples', [...new Set(s.users.map(u => JSON.stringify(u.scope)))].slice(0, 8));
