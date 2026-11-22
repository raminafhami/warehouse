import { chromium } from '../reval/tools/p00/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const base='http://127.0.0.1:5174';
const password=process.env.REVAL_LOCAL_DEMO_PASSWORD;
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({locale:'fa-IR'});
const errors=[];
page.on('pageerror',err=>errors.push(err.message));
async function signIn(actor){
 await page.goto(base+'/login');
 await page.locator('input[name=username]').fill(actor);
 await page.locator('input[name=password]').fill(password);
 await page.getByRole('button',{name:'ورود به سامانه'}).click();
 await page.locator('.identity-shell').waitFor();
}
async function api(path){
 const res=await page.request.get(base+'/api/v1'+path);
 if(!res.ok())throw Error(path+' '+res.status());
 return (await res.json()).result;
}
try {
 await signIn('demo-reval');
 await page.goto(base+'/reference-data');
 await page.getByText(/SHP-1405-0015/).first().waitFor();
 await page.locator('.content select').selectOption('phones');
 await page.getByText(/PH-1405-/).first().waitFor();
 await page.getByRole('button',{name:'بعدی'}).click();
 await page.waitForURL(/page=1/);
 const summary=await api('/demo/reference/summary');
 const original=JSON.parse(await fs.readFile('reval/evidence/P00/prototype-seed-state.redacted.json','utf8'));
 if(Object.entries(summary.counts).some(([key,count])=>original[key].length!==count)||Object.keys(summary.counts).length!==Object.values(original).filter(Array.isArray).length)throw Error('Snapshot does not match section counts');
 const placed=(await api('/inventory/carton-stock?q=CTN-1405-0060')).data[0];
 const reconcile=await api('/inventory/cartons/'+placed.cartonId+'/reconciliation');
 if(!reconcile.balanced)throw Error('Stock is out of balance');
 const shipment=(await api('/shipments?q=BL-CN-40120501')).data[0];
 if(shipment.code!=='SHP-1405-0014'||shipment.status!=='discrepancy')throw Error('Shipment reference identity or status changed');
 const delivery=(await api('/handover/deliveries?q=DLV-1405-0005')).data[0];
 if(delivery?.status!=='issued')throw Error('Reference delivery was not found');
 const actors=await browser.newPage();
 const unauth=await actors.request.get(base+'/api/v1/demo/reference/summary');
 if(unauth.status()!==401)throw Error('Snapshot is public');
 await actors.request.post(base+'/api/v1/auth/login',{headers:{Origin:base},data:{username:'demo-quality',password}});
 const denied=await actors.request.get(base+'/api/v1/demo/reference/summary');
 if(denied.status()!==403)throw Error('Snapshot lacks role guard');
 if(errors.length)throw Error(errors.join(', '));
 console.log('Verified '+Object.keys(summary.counts).length+' sections, reference browser, shipment discrepancy, inventory reconciliation, delivery and access.');
}finally{
 await browser.close();
}