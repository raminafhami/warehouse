// P00: render evidence JSON into reviewable Markdown (business rules + UI inventory).
// Usage: node gen-docs.mjs <evidenceDir> <docsDir>
import fs from 'node:fs';
import path from 'node:path';
const [ev, docs] = process.argv.slice(2);
const read = f => (fs.existsSync(path.join(ev, f)) ? JSON.parse(fs.readFileSync(path.join(ev, f), 'utf8')) : null);
const modName = { master: 'اطلاعات پایه', shipments: 'ورود محموله', inventory: 'موجودی انبار', handover: 'تحویل به تولید', imei: 'IMEI و برنامه تولید', basket: 'آماده‌سازی سبد', assembly: 'خط مونتاژ', stageQc: 'کیفیت مرحله‌ای', defects: 'مرجوعی‌ها', finalQc: 'QC نهایی و بسته‌بندی', finished: 'انبار محصول', distribution: 'توزیع (DEFERRED — D01)', users: 'کاربران و دسترسی' };
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const rules = read('command-rules.json');
if (rules) {
  let md = `# قواعد عملیات (command) استخراج‌شده از پروتوتایپ\n\nمنبع: \`evidence/P00/command-rules.json\` — اسکن ایستای bundle؛ \`…\` جای مقدار متغیر در پیام است. ${rules.commandCount} عملیات، ${rules.commands.reduce((a, c) => a + c.failures.length, 0)} پیام رد/شکست.\n\n`;
  md += `هر سطر «شکست» یعنی پروتوتایپ در آن شرایط عملیات را رد می‌کند. بازپیاده‌سازی باید همین قاعده را **در Backend** اعمال کند، مگر در DEVIATIONS خلاف آن تصمیم شده باشد. شناسه CMD با ستون api/notes در TRACEABILITY مرتبط است.\n\n`;
  const groups = {};
  rules.commands.forEach(c => (groups[c.module] ||= []).push(c));
  for (const [m, cs] of Object.entries(groups)) {
    md += `## ${modName[m] ?? m} (\`${m}\`)\n\n`;
    for (const c of cs) {
      md += `### ${c.id} — ${c.label}  \nمجوز: \`${c.module}:${c.permission}\`${c.statusesTouched.length ? ` · وضعیت‌های درگیر: ${c.statusesTouched.map(s => `\`${s}\``).join('، ')}` : ''}\n\n`;
      md += c.failures.length ? c.failures.map(f => `- رد: ${f}`).join('\n') + '\n\n' : '- (پیام ردی یافت نشد)\n\n';
    }
  }
  md += `## قالب‌های چاپ و خروجی\n\nقالب برچسب: ${rules.printLabelTemplates.map(l => `\`${l}\``).join('، ')}\n\n| گزارش خروجی | ماژول | ستون‌ها |\n|---|---|---|\n`;
  rules.reportExports.forEach(r => { md += `| ${esc(r.title)} | ${r.module} | ${esc(r.columns.join('، '))} |\n`; });
  fs.writeFileSync(path.join(docs, 'BUSINESS-RULES.md'), md);
}

const inv = read('ui-inventory.json');
if (inv) {
  let md = `# فهرست رابط کاربری پروتوتایپ (UI inventory)\n\nمرور خودکار در Chrome بدون شبکه، ساعت ثابت ${inv.prototypeClock}، viewport ${inv.viewport}، نقش سوپر ادمین. قبل از هر کلیک، state به داده نمونه اولیه برگردانده شده است. تصاویر: \`evidence/P00/screens/\`.\n\n`;
  md += `محدودیت: فقط دکمه‌های سطح اول صفحه/تب کلیک شده‌اند؛ گام‌های داخل modal، اسکن متوالی و ورودی‌های فرم پر نشده‌اند. این موارد در سناریوهای پذیرش (SCOPE) پوشش داده می‌شوند.\n\n`;
  const uniq = a => [...new Set(a)];
  for (const p of inv.pages) {
    const b = p.base;
    md += `## ${esc(b.title || p.key)} — \`${p.path}\` (UI-${p.key})\n\n`;
    md += `تصویر: \`screens/${p.key.replace(/[^a-zA-Z0-9-]+/g, '_')}.png\`\n\n`;
    if (b.chips.length) md += `- فیلتر/چیپ: ${uniq(b.chips).map(esc).join('، ')}\n`;
    if (b.tabs.length) md += `- تب‌ها: ${b.tabs.map((t, i) => `${i + 1}) ${esc(t)}`).join(' · ')}\n`;
    if (b.cards.length) md += `- بخش‌ها: ${uniq(b.cards).map(esc).join('، ')}\n`;
    const inputs = uniq([b, ...p.tabs.map(t => t.inv)].flatMap(x => x.inputs.map(i => `${i.tag}${i.type && i.tag === 'input' ? ':' + i.type : ''}${i.label || i.placeholder ? ' «' + esc(i.label || i.placeholder).slice(0, 50) + '»' : ''}`)));
    if (inputs.length) md += `- ورودی‌ها: ${inputs.join('، ')}\n`;
    const tables = [b, ...p.tabs.map(t => t.inv)].flatMap(x => x.tables).filter(t => t.headers.length);
    uniq(tables.map(t => t.headers.join('، '))).forEach(h => { md += `- جدول: ${esc(h)}\n`; });
    md += `- pagination: ${[b, ...p.tabs.map(t => t.inv)].some(x => x.pagers) ? 'دارد' : 'ندارد/دیده نشد'}\n`;
    if (b.empty.length) md += `- حالت خالی: ${uniq(b.empty).map(esc).join('، ')}\n`;
    md += `\n| تب | دکمه | نتیجه کلیک |\n|---|---|---|\n`;
    for (const pr of p.probes) {
      const r = [];
      if (pr.error) r.push('کلیک ناموفق');
      if (pr.overlay) r.push(`پنجره: «${esc(pr.overlay.title || pr.overlay.text.slice(0, 60))}»${pr.overlay.inputs.length ? ` · ${pr.overlay.inputs.length} ورودی` : ''}${pr.overlay.buttons.length ? ` · دکمه‌ها: ${pr.overlay.buttons.map(esc).join('/')}` : ''}`);
      if (pr.navigatedTo) r.push(`رفتن به \`${pr.navigatedTo}\``);
      if (pr.print) r.push('چاپ مرورگر');
      if (pr.download) r.push(`دانلود ${esc(pr.download)}`);
      if (pr.stateChanged) r.push('**تغییر داده**');
      if (pr.toasts?.length) r.push(`پیام: ${esc(pr.toasts.join(' / ')).slice(0, 120)}`);
      md += `| ${pr.tab === null ? '—' : esc(p.base.tabs[pr.tab])} | ${esc(pr.button).slice(0, 60)} | ${r.join(' · ') || 'اثر قابل مشاهده‌ای ثبت نشد'} |\n`;
    }
    md += '\n';
  }
  fs.writeFileSync(path.join(docs, 'UI-INVENTORY.md'), md);
}

const roleNav = read('role-nav.json');
if (roleNav) {
  let md = `\n\n## منوی قابل مشاهده برای هر نقش (اجرای واقعی پروتوتایپ)\n\n| نقش | کاربر نمونه | مسیرهای منو |\n|---|---|---|\n`;
  roleNav.forEach(r => { md += `| ${r.roleName} | ${r.userId ?? '—'} | ${(r.nav || []).map(n => `\`${n.replace('#', '')}\``).join(' ')} |\n`; });
  fs.appendFileSync(path.join(docs, 'ROLE-MATRIX.md'), md);
}
console.log('docs:', fs.readdirSync(docs).join(', '));
