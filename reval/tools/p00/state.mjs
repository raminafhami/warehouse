// P00: dump structure of the prototype's seeded localStorage state (with a fixed clock).
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const FIXED_TIME = new Date('2026-11-08T09:00:00+03:30');
export async function openProto(htmlPath, { viewport = { width: 1440, height: 900 } } = {}) {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const ctx = await browser.newContext({ viewport, locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
  const blocked = [];
  await ctx.route('**/*', r => /^(file|data|blob):/.test(r.request().url()) ? r.continue() : (blocked.push(r.request().url()), r.abort()));
  await ctx.clock.install({ time: FIXED_TIME });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.dismiss());
  await page.goto(pathToFileURL(path.resolve(htmlPath)).href + '#/login');
  await page.waitForTimeout(800);
  return { browser, ctx, page, errors, blocked };
}

if (process.argv[1].endsWith('state.mjs')) {
  const [html, out] = process.argv.slice(2);
  const { browser, page } = await openProto(html);
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('reval-state-v9')));
  const shape = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length}) keys=${v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).join(',') : typeof v[0]}` : typeof v === 'object' && v ? `object keys=${Object.keys(v).slice(0, 25).join(',')}` : JSON.stringify(v)]));
  console.log(JSON.stringify(shape, null, 1));
  // redact anything password-like before saving
  const redact = o => JSON.parse(JSON.stringify(o, (k, v) => /^(pass(word)?(hash)?|pwd|secret|token|apikey)$/i.test(k) ? '[REDACTED]' : v));
  fs.writeFileSync(out, JSON.stringify(redact(s), null, 1));
  await browser.close();
}
