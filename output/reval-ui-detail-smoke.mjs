import { chromium } from '../reval/tools/p00/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
const out='output/reval-ui-parity/details';
const base='http://127.0.0.1:5174';
const password=await fs.readFile(path.join(process.env.TEMP,'reval-ui-parity','local-demo-password.txt'),'utf8');
const browser=await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const ctx=await browser.newContext({ viewport:{width:1440,height:900},locale:'fa-IR',timezoneId:'Asia/Tehran',reducedMotion:'reduce' });
const page=await ctx.newPage();
await fs.mkdir(out,{recursive:true});
const results=[];
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(base+'/login');
  await page.getByLabel('نقش',{exact:true}).selectOption('demo-reval');
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button',{name:'ورود به سامانه'}).click();
  await page.locator('.identity-shell').waitFor();
  async function api(endpoint) {
    const response=await ctx.request.get(base+'/api/v1'+endpoint);
    if (!response.ok()) throw Error(endpoint+' '+response.status());
    return (await response.json()).result;
  }
  const sources=[
    ['shipment','/shipments','/shipments',data=>data.data[0].id],
    ['handover','/handover/requests?status=open','/handover',data=>data.data[0].id],
    ['production-order','/imei/orders','/imei/orders',data=>data.data[0].id],
    ['basket','/basket?status=preparing','/basket',data=>data.data[0].id],
    ['final-qc','/final-qc?view=packing','/final-qc',data=>data.items[0].id],
    ['defect','/defects/cases','/defects/cases',data=>data.items[0].id],
    ['return','/defects/returns','/defects/returns',data=>data.items[0].id],
    ['finished-carton','/finished/cartons?tab=stock','/finished/cartons',data=>data.items[0].id],
    ['trace-carton','/trace?kind=material&q=CTN-1405-8101','/trace/material',data=>data[0].items[0].id],
  ];
  const routes=await Promise.all(sources.map(async ([label,endpoint,route,pick])=>[label,route+'/'+pick(await api(endpoint))]));
  const stations=await api('/assembly/options');
  const queue=await api('/assembly/queue?stationId='+stations[0].id);
  routes.push(['station-visit','/assembly/visits/'+queue.items.find(item=>item.visitId).visitId]);
  routes.push(['technical-queue','/stage-qc/technical']);
  for (const [label,route] of routes) {
    await page.goto(base+route);
    await page.locator('main.content h1, main.content h2').first().waitFor({timeout:10000});
    await page.waitForLoadState('networkidle');
    const alerts=await page.getByRole('alert').allTextContents();
    if(alerts.length) throw Error(route+' '+alerts.join(', '));
    await page.screenshot({path:path.join(out,label+'.png'),animations:'disabled'});
    results.push({label,route,title:await page.locator('main.content h1, main.content h2').first().textContent()});
  }
  if(errors.length) throw Error(errors.join(', '));
  console.log('Passed',results.length,'detail and queue routes');
} finally {
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));
  await browser.close();
}