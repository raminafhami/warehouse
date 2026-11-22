// P00 probe: open the reference prototype offline and dump the login page structure.
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const html = path.resolve(process.argv[2]);
const url = pathToFileURL(html).href;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fa-IR' });
const blocked = [];
await ctx.route('**/*', r => (r.request().url().startsWith('file:') || r.request().url().startsWith('data:')) ? r.continue() : (blocked.push(r.request().url()), r.abort()));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url + '#/login');
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  hash: location.hash,
  text: document.body.innerText.slice(0, 1500),
  inputs: [...document.querySelectorAll('input,select,textarea')].map(e => ({ tag: e.tagName, type: e.type, name: e.name, ph: e.placeholder })),
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean),
  ls: Object.keys(localStorage), ss: Object.keys(sessionStorage),
}));
console.log(JSON.stringify({ info, errors, blocked }, null, 1));
await browser.close();
