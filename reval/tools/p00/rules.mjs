// P00 static extraction: each prototype command and the validation/failure messages inside it.
// Usage: node rules.mjs <REVAL.html> <out.json>
import fs from 'node:fs';
const [htmlPath, outPath] = process.argv.slice(2);
const src = fs.readFileSync(htmlPath, 'utf8');
const re = /([\w$]+)=ie\("(\w+)","(\w+)","([^"]+)",/g;
const hits = [...src.matchAll(re)].map(m => ({ fn: m[1], module: m[2], permission: m[3], label: m[4], at: m.index }));
const msgRe = /\bI\((?:"([^"]+)"|`([^`]+)`)\)/g;
const pages = /function\s+\w+\(\)\{[^]*?\}/; // unused, kept simple
const commands = hits.map((h, i) => {
  const end = i + 1 < hits.length ? hits[i + 1].at : Math.min(src.length, h.at + 6000);
  const body = src.slice(h.at, Math.min(end, h.at + 6000));
  const failures = [...body.matchAll(msgRe)].map(m => (m[1] ?? m[2]).replace(/\$\{[^}]+\}/g, '…'));
  const statuses = [...new Set([...body.matchAll(/status(?:===|!==|=)"(\w+)"/g)].map(m => m[1]))];
  return { id: null, fn: h.fn, module: h.module, permission: h.permission, label: h.label, failures: [...new Set(failures)], statusesTouched: statuses };
});
commands.forEach((c, i) => { c.id = `CMD-${String(i + 1).padStart(3, '0')}`; });
// print label templates and report/export specs
const labels = [...new Set([...src.matchAll(/(\w+):e=>`<div class="lb (\w+)/g)].map(m => m[2]))];
const reports = [...src.matchAll(/spec:\(\)=>\(\{title:"([^"]+)",module:"(\w+)",columns:\[([^\]]*)\]/g)].map(m => ({ title: m[1], module: m[2], columns: m[3].split(',').map(s => s.replace(/"/g, '')) }));
fs.writeFileSync(outPath, JSON.stringify({ source: 'static scan of minified bundle; messages with ${…} are templated', commandCount: commands.length, commands, printLabelTemplates: labels, reportExports: reports }, null, 1));
console.log(`commands=${commands.length} withFailures=${commands.filter(c => c.failures.length).length} failures=${commands.reduce((a, c) => a + c.failures.length, 0)} labels=${labels.join(',')} reports=${reports.length}`);
const byMod = {}; commands.forEach(c => { byMod[c.module] = (byMod[c.module] || 0) + 1; }); console.log(byMod);
