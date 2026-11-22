// P00 capture: isolated, offline, fixed-clock walkthrough of the reference prototype.
// Usage: node capture.mjs <REVAL.html> <evidenceDir>
// Produces screenshots + ui-inventory.json + role-nav.json + run-log.json. The prototype's demo
// state is reset to the seeded snapshot before every probe so results are repeatable.
import { openProto, FIXED_TIME } from './state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [htmlPath, outDir] = process.argv.slice(2);
const shots = path.join(outDir, 'screens');
fs.mkdirSync(shots, { recursive: true });
const evidence = JSON.parse(fs.readFileSync(path.join(path.dirname(htmlPath), '..', 'SOURCE-EVIDENCE.json'), 'utf8'));
const PAGES = [
  ...evidence.pages.map(p => ({ key: p.key, path: p.path })),
  { key: 'basket-L2', path: '/basket?line=L2' }, { key: 'basket-L3', path: '/basket?line=L3' },
  { key: 'assembly-L1', path: '/assembly?line=L1' }, { key: 'assembly-L2', path: '/assembly?line=L2' }, { key: 'assembly-L3', path: '/assembly?line=L3' },
];
const SKIP_CLICK = /^(خروج|خروج از سامانه)$/; // logout would end the session

const { browser, ctx, page, errors, blocked } = await openProto(htmlPath);
await ctx.addInitScript(() => {
  window.__prints = 0; window.print = () => { window.__prints++; };
  // nearest short caption that is a sibling of the field (or of one of its 4 nearest ancestors)
  window.__labelOf = el => {
    const t = e => (e?.innerText || '').replace(/\s+/g, ' ').trim();
    const own = t(el.closest('label')); if (own && own.length < 80) return own;
    let n = el;
    for (let d = 0; d < 4 && n.parentElement; d++, n = n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib === n || sib.contains(el) || sib.querySelector('input,select,textarea,button')) continue;
        const s = t(sib); if (s && s.length < 60) return s;
      }
    }
    return el.placeholder || el.getAttribute('aria-label') || '';
  };
});
const seed = await page.evaluate(() => localStorage.getItem('reval-state-v9'));
const users = JSON.parse(seed).users;
const roles = JSON.parse(seed).roles;

async function login(username) {
  await page.evaluate(() => { sessionStorage.clear(); location.hash = '/login'; });
  await page.reload(); await page.waitForTimeout(500);
  await page.selectOption('select', username);
  const pw = page.locator('input[type=password]');
  if (!(await pw.inputValue())) await pw.fill('demo');
  await page.click('button:has-text("ورود به سامانه")');
  await page.waitForTimeout(600);
}
async function resetTo(hashPath) {
  await page.evaluate(([s, h]) => { localStorage.setItem('reval-state-v9', s); location.hash = h; }, [seed, hashPath]);
  await page.reload(); await page.waitForTimeout(700);
}
const inventory = () => page.evaluate(() => {
  const t = e => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('.content') || document.body;
  const labelOf = window.__labelOf;
  return {
    title: t(document.querySelector('.ph h1, .ph .t, h1')),
    cards: [...main.querySelectorAll('.card-h')].map(t).filter(Boolean),
    tabs: [...main.querySelectorAll('.tabs .tab')].map(t),
    chips: [...main.querySelectorAll('.chips .chip')].map(t),
    buttons: [...main.querySelectorAll('button')].map(b => ({ text: t(b) || b.getAttribute('title') || b.getAttribute('aria-label') || '(icon)', disabled: b.disabled })),
    inputs: [...main.querySelectorAll('input,select,textarea')].map(e => ({ tag: e.tagName.toLowerCase(), type: e.type, label: labelOf(e).slice(0, 80), placeholder: e.placeholder || '' })),
    tables: [...main.querySelectorAll('table')].map(tb => ({ headers: [...tb.querySelectorAll('th')].map(t), rows: tb.querySelectorAll('tbody tr').length })),
    pagers: main.querySelectorAll('.pager').length,
    empty: [...main.querySelectorAll('.empty, [class*=empty]')].map(t).filter(Boolean),
    links: [...main.querySelectorAll('a[href^="#/"]')].map(a => a.getAttribute('href')).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30),
  };
});
const overlay = () => page.evaluate(() => {
  const t = e => (e?.innerText || '').replace(/\s+/g, ' ').trim();
  const cand = [...document.querySelectorAll('[role=dialog], dialog[open], [class*=modal], [class*=drawer], [class*=sheet], [class*=overlay]')]
    .filter(e => e.getBoundingClientRect().width > 50 && getComputedStyle(e).display !== 'none');
  const m = cand.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!m) return null;
  return {
    cls: String(m.className).slice(0, 60),
    title: t(m.querySelector('h1,h2,h3,.t,.title,[class*=head]')).slice(0, 120),
    inputs: [...m.querySelectorAll('input,select,textarea')].map(e => ({ tag: e.tagName.toLowerCase(), type: e.type, label: window.__labelOf(e).slice(0, 80) })),
    buttons: [...m.querySelectorAll('button')].map(t).filter(Boolean),
    text: t(m).slice(0, 400),
  };
});
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toasts > *')].map(e => e.innerText.replace(/\s+/g, ' ').trim()));
const safe = s => s.replace(/[^a-zA-Z0-9-]+/g, '_');

const out = { generatedAt: new Date().toISOString(), prototypeClock: FIXED_TIME.toISOString(), viewport: '1440x900', pages: [] };

// 1) superadmin: every page, every tab, every button probe
await login(users.find(u => u.roleId === 'superadmin').username);
for (const p of PAGES) {
  await resetTo(p.path);
  const entry = { key: p.key, path: p.path, hash: await page.evaluate(() => location.hash), base: await inventory(), tabs: [], probes: [] };
  await page.screenshot({ path: path.join(shots, `${safe(p.key)}.png`), fullPage: true });
  const tabCount = entry.base.tabs.length;
  const views = [{ tab: null }];
  for (let i = 0; i < tabCount; i++) views.push({ tab: i });
  for (const v of views) {
    if (v.tab !== null) {
      await resetTo(p.path);
      await page.locator('.content .tabs .tab').nth(v.tab).click(); await page.waitForTimeout(400);
      const inv = await inventory();
      entry.tabs.push({ index: v.tab, label: entry.base.tabs[v.tab], hash: await page.evaluate(() => location.hash), inv });
      await page.screenshot({ path: path.join(shots, `${safe(p.key)}--tab${v.tab + 1}.png`), fullPage: true });
    }
    const btnCount = await page.locator('.content button').count();
    for (let b = 0; b < btnCount; b++) {
      await resetTo(p.path);
      if (v.tab !== null) { await page.locator('.content .tabs .tab').nth(v.tab).click(); await page.waitForTimeout(300); }
      const btn = page.locator('.content button').nth(b);
      if (!(await btn.count())) continue;
      const text = ((await btn.innerText().catch(() => '')) || (await btn.getAttribute('title')) || '(icon)').replace(/\s+/g, ' ').trim();
      if (SKIP_CLICK.test(text) || (await btn.isDisabled()) || (await btn.evaluate(e => e.closest('.tabs,.chips,.pager') !== null))) continue;
      const beforeHash = await page.evaluate(() => location.hash);
      const beforePrints = await page.evaluate(() => window.__prints);
      const beforeState = await page.evaluate(() => localStorage.getItem('reval-state-v9'));
      let dl = null; const onDl = d => { dl = d.suggestedFilename(); d.cancel().catch(() => {}); }; page.on('download', onDl);
      await btn.click({ timeout: 2000 }).catch(e => { entry.probes.push({ tab: v.tab, button: text, error: String(e).slice(0, 120) }); });
      await page.waitForTimeout(500);
      page.off('download', onDl);
      const ov = await overlay();
      const after = await page.evaluate(() => ({ hash: location.hash, prints: window.__prints, state: localStorage.getItem('reval-state-v9') }));
      const probe = { tab: v.tab, button: text, navigatedTo: after.hash !== beforeHash ? after.hash : null, print: after.prints > beforePrints, download: dl, stateChanged: after.state !== beforeState, toasts: await toasts(), overlay: ov };
      if (ov) await page.screenshot({ path: path.join(shots, `${safe(p.key)}${v.tab !== null ? `--tab${v.tab + 1}` : ''}--btn${b + 1}.png`) });
      entry.probes.push(probe);
    }
  }
  out.pages.push(entry);
  console.log(`page ${p.key}: tabs=${tabCount} probes=${entry.probes.length}`);
}
fs.writeFileSync(path.join(outDir, 'ui-inventory.json'), JSON.stringify(out, null, 1));

// 2) one representative user per role: visible navigation + landing screenshot
const roleNav = [];
for (const r of roles) {
  const u = users.find(x => x.roleId === r.id && x.active);
  if (!u) { roleNav.push({ roleId: r.id, roleName: r.name, user: null }); continue; }
  await resetTo('/login'); await login(u.username);
  const nav = await page.$$eval('.sidebar a[href^="#/"]', as => as.map(a => a.getAttribute('href')).filter((v, i, a) => a.indexOf(v) === i));
  const blockedPages = [];
  for (const p of evidence.pages) {
    await page.evaluate(h => { location.hash = h; }, p.path); await page.waitForTimeout(250);
    const txt = await page.evaluate(() => (document.querySelector('.content') || document.body).innerText.slice(0, 200));
    if (/دسترسی|مجاز نیست|اجازه/.test(txt) && txt.length < 200) blockedPages.push(p.key);
  }
  await page.evaluate(() => { location.hash = '/'; }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `role--${safe(r.id)}.png`) });
  roleNav.push({ roleId: r.id, roleName: r.name, userId: u.id, unit: u.unit, scope: u.scope, nav, deniedPages: blockedPages });
}
fs.writeFileSync(path.join(outDir, 'role-nav.json'), JSON.stringify(roleNav, null, 1));

// 3) phone-width pass for every page (operator device size unknown — D06/D10)
await ctx.close();
const m = await openProto(htmlPath, { viewport: { width: 390, height: 844 } });
const mp = m.page;
await mp.selectOption('select', users.find(u => u.roleId === 'superadmin').username);
if (!(await mp.locator('input[type=password]').inputValue())) await mp.locator('input[type=password]').fill('demo');
await mp.click('button:has-text("ورود به سامانه")'); await mp.waitForTimeout(500);
const mobile = [];
for (const p of PAGES) {
  await mp.evaluate(h => { location.hash = h; }, p.path); await mp.waitForTimeout(500);
  const ov = await mp.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
  mobile.push({ key: p.key, horizontalOverflow: ov.scrollW > ov.clientW + 1, ...ov });
  await mp.screenshot({ path: path.join(shots, `mobile--${safe(p.key)}.png`), fullPage: true });
}
await m.browser.close();

const sha = crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex').toUpperCase();
fs.writeFileSync(path.join(outDir, 'run-log.json'), JSON.stringify({
  htmlSha256: sha, browser: 'Chrome (system) via playwright-core 1.49.1, headless', node: process.version,
  network: 'all non-file requests aborted', blockedRequests: blocked, pageErrors: errors, prototypeClock: FIXED_TIME.toISOString(),
  timezone: 'Asia/Tehran', mobile,
}, null, 1));
await browser.close().catch(() => {});
console.log('done');
