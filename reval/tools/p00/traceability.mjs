// P00: expand TRACEABILITY.csv from evidence (idempotent: rows it generates are replaced on rerun).
// Usage: node traceability.mjs <repoRoot>
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const csvPath = path.join(root, 'TRACEABILITY.csv');
const raw = fs.readFileSync(csvPath, 'utf8');
const bom = raw.startsWith('﻿');
const parseLine = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
const header = parseLine(lines[0]);
let rows = lines.slice(1).map(l => Object.fromEntries(parseLine(l).map((v, i) => [header[i], v])));
const GEN = /^REQ-(TAB|MOD|FLT|SRCH|PAG|EXP|PRN|RULE|SEC)-/;
rows = rows.filter(r => !GEN.test(r.id)); // rerun-safe

const ev = f => JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'P00', f), 'utf8'));
const rules = ev('command-rules.json');
const inv = ev('ui-inventory.json');
const addNote = (r, n) => { if (!r.notes.includes(n)) r.notes = r.notes ? `${r.notes}; ${n}` : n; };

// 1) link existing command rows to extracted rule ids; apply D01/D02
for (const r of rows.filter(r => r.type === 'COMMAND')) {
  const c = rules.commands.find(c => c.module === r.module && c.label === r.label);
  if (c) { addNote(r, `${c.id} (${c.failures.length} قاعده رد در docs/P00/BUSINESS-RULES.md)`); r.evidence = r.evidence || 'evidence/P00/command-rules.json'; }
  if (r.module === 'distribution') { r.scope = 'DEFERRED'; addNote(r, 'D01 2026-11-13: خارج از تحویل اول؛ اجرا نمی‌شود'); }
  if (r.scope === 'DECISION_D02') { r.scope = 'PROPOSED'; addNote(r, 'D02 2026-11-13: ثبت دستی کد رهگیری واقعی + شبیه‌ساز برچسب‌دار فقط دمو؛ بدون کد ساختگی (DEV-001)'); }
}
const nfr = id => rows.find(r => r.id === id);
nfr('REQ-NFR-008') && addNote(nfr('REQ-NFR-008'), 'D03 2026-11-13: imeiSlots مدل، یکتایی سراسری بین slotها، void/آزادسازی');
nfr('REQ-NFR-020') && addNote(nfr('REQ-NFR-020'), 'D02 2026-11-13');
nfr('REQ-NFR-002') && (nfr('REQ-NFR-002').evidence = 'evidence/P00/screens/');

// 2) generated rows from the UI walkthrough
const phaseOf = Object.fromEntries(rows.filter(r => r.type === 'PAGE').map(r => [r.module, r.phase]));
const pageKey = k => k.replace(/-L\d$/, '');
const mk = (id, type, module, label, permission = 'view', extra = {}) => ({
  id, type, module, label, permission, phase: phaseOf[module] ?? 'P13', scope: 'PROPOSED', status: 'NOT_STARTED', api: '', testIds: '', testResult: 'NOT_RUN', commit: '', evidence: extra.evidence ?? 'evidence/P00/ui-inventory.json', humanApproval: 'PENDING', notes: extra.notes ?? '',
});
const gen = [];
const seen = new Set();
const once = (key, fn) => { if (!seen.has(key)) { seen.add(key); gen.push(fn()); } };
let n = { TAB: 0, MOD: 0, FLT: 0, SRCH: 0, PAG: 0, EXP: 0 };
const nid = t => `REQ-${t}-${String(++n[t]).padStart(3, '0')}`;
for (const p of inv.pages) {
  const m = pageKey(p.key);
  const views = [{ label: null, inv: p.base }, ...p.tabs.map(t => ({ label: t.label, inv: t.inv }))];
  p.tabs.forEach((t, i) => once(`tab:${m}:${t.label}`, () => mk(nid('TAB'), 'TAB', m, `${p.base.title || m} › تب «${t.label}»`, 'view', { evidence: `evidence/P00/screens/${p.key}--tab${i + 1}.png` })));
  for (const v of views) {
    const where = `${p.base.title || m}${v.label ? ` › ${v.label}` : ''}`;
    if (v.inv.chips.length) once(`flt:${m}:${v.inv.chips.join('|')}`, () => mk(nid('FLT'), 'FILTER', m, `${where}: فیلتر ${[...new Set(v.inv.chips)].slice(0, 8).join('/')}`));
    if (v.inv.inputs.some(i => /جست|جستجو|search/i.test(i.placeholder + i.label))) once(`srch:${m}:${v.label}`, () => mk(nid('SRCH'), 'SEARCH', m, `${where}: جست‌وجو`));
    if (v.inv.pagers) once(`pag:${m}:${v.label}`, () => mk(nid('PAG'), 'PAGINATION', m, `${where}: صفحه‌بندی`));
  }
  for (const pr of p.probes) {
    const tab = pr.tab === null ? '' : ` › ${p.base.tabs[pr.tab]}`;
    if (pr.overlay && /PDF/.test(pr.overlay.title)) once(`exp:${pr.overlay.title}`, () => mk(nid('EXP'), 'EXPORT', m, `${pr.overlay.title}`, 'pdf', { notes: `دکمه «${pr.button}» در ${p.base.title}${tab}` }));
    else if (pr.overlay && pr.overlay.title) once(`mod:${m}:${pr.overlay.title}`, () => mk(nid('MOD'), 'MODAL', m, `${p.base.title}${tab}: پنجره «${pr.overlay.title.slice(0, 70)}»`, 'view', { notes: `دکمه «${pr.button}»${pr.overlay.inputs.length ? ` · ${pr.overlay.inputs.length} ورودی: ${pr.overlay.inputs.map(i => i.label).filter(Boolean).slice(0, 6).join('، ')}` : ''}` }));
  }
}
// distribution never appears in UI, but keep any generated distribution rows deferred too
gen.forEach(r => { if (r.module === 'distribution') { r.scope = 'DEFERRED'; addNote(r, 'D01'); } });

rules.printLabelTemplates.forEach((l, i) => gen.push(mk(`REQ-PRN-${String(i + 1).padStart(3, '0')}`, 'PRINT', { part: 'basket', imei: 'basket', box: 'finalQc', master: 'finished', logistic: 'shipments' }[l] ?? 'cross-cutting', `قالب چاپ برچسب «${l}» (اندازه/چاپگر طبق D06)`, 'pdf', { evidence: 'evidence/P00/command-rules.json', notes: 'چاپ ≠ چسباندن؛ تأیید با اسکن (DEV-012)' })));
const R = (id, module, label, phase, notes) => ({ ...mk(id, 'RULE', module, label, 'edit', { evidence: 'decisions/D01-D03-2026-11-13.md', notes }), phase });
gen.push(
  R('REQ-RULE-001', 'imei', 'تعداد IMEI بر اساس imeiSlots مدل؛ رد ردیف ناسازگار', 'P08', 'D03, DEV-002'),
  R('REQ-RULE-002', 'imei', 'یکتایی سراسری شماره IMEI بین همه مدل‌ها و هر دو slot؛ IMEI1≠IMEI2؛ ذخیره رشته', 'P08', 'D03'),
  R('REQ-RULE-003', 'imei', 'نرمال‌سازی ارقام فارسی/عربی، ۱۵ رقم و Luhn؛ گزارش خطای هر سطر import', 'P08', 'D03'),
  R('REQ-RULE-004', 'imei', 'تخصیص اتمیک جفت IMEI هم‌مدل؛ عدم تخصیص دوباره در رقابت', 'P08', 'D03'),
  R('REQ-RULE-005', 'imei', 'آزادسازی IMEI پیش از چاپ برچسب با علت و مجوز؛ void پس از چاپ؛ قفل پس از همتا', 'P08', 'D03, DEV-003'),
  R('REQ-RULE-006', 'imei', 'همتا: کد رهگیری واقعی اجباری؛ هیچ کد ساختگی', 'P08', 'D02, DEV-001'),
  R('REQ-RULE-007', 'imei', 'همتا: وضعیت submitted، retry و reconciliation؛ timeout ≠ موفقیت', 'P08', 'D02, DEV-004'),
  R('REQ-RULE-008', 'imei', 'همتا: adapter شبیه‌ساز فقط در دمو با برچسب دائمی؛ در production غیرقابل فعال‌سازی', 'P08', 'D02'),
  R('REQ-RULE-009', 'cross-cutting', 'مدل داده قابل توسعه برای DistributionOrder آینده بدون migration شکننده', 'P01', 'D01'),
);
const S = (id, label, phase, notes) => ({ ...mk(id, 'SECURITY', 'auth', label, 'users', { evidence: 'docs/P00/DEVIATIONS.md', notes }), phase });
gen.push(
  S('REQ-SEC-001', 'ورود بدون فهرست کاربران؛ انتخاب کاربر فقط در دمو', 'P03', 'DEV-005'),
  S('REQ-SEC-002', 'تغییر نقش نمایشی فقط در دمو', 'P03', 'DEV-006'),
  S('REQ-SEC-003', 'محدوده کاربر ساختاریافته (انبار/خط/ایستگاه) با کنترل سمت سرور', 'P03', 'DEV-007'),
  S('REQ-SEC-004', 'مجاز ایستگاه بر اساس شناسه نقش/کاربر نه نام', 'P04', 'DEV-008'),
  S('REQ-SEC-005', 'دکمه‌های اسکن آزمایشی فقط در دمو', 'P09', 'DEV-013'),
);
rows = [...rows, ...gen];
const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync(csvPath, (bom ? '﻿' : '') + [header.map(q).join(','), ...rows.map(r => header.map(h => q(r[h])).join(','))].join('\n') + '\n');
const count = (k, v) => rows.filter(r => r[k] === v).length;
const types = {}; rows.forEach(r => { types[r.type] = (types[r.type] || 0) + 1; });
console.log(`rows=${rows.length} (generated ${gen.length}) inScope=${rows.length - count('scope', 'DEFERRED')} deferred=${count('scope', 'DEFERRED')}`, types);
