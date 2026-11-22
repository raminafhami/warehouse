import { chromium } from '../reval/tools/p00/node_modules/playwright-core/index.mjs';
import { openProto } from '../reval/tools/p00/state.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = 'http://127.0.0.1:5174';
const password = await fs.readFile(path.join(process.env.TEMP,'reval-ui-parity','local-demo-password.txt'),'utf8');
const executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const evidence = 'output/reval-ui-parity';
const routes = ['/', '/trace', '/shipments', '/inventory', '/handover', '/imei', '/basket', '/assembly', '/final-qc', '/stage-qc', '/defects', '/finished', '/reports', '/master', '/users', '/audit'];
const sizes = [{width:1440,height:900}, {width:1920,height:1080}, {width:1024,height:768}];
const report = [];
const browser = await chromium.launch({executablePath});
try {
  for (const viewport of sizes) {
    const size = viewport.width+'x'+viewport.height;
    const dir = path.join(evidence,size);
    await fs.mkdir(dir, { recursive: true });
    const reference = await openProto('reval/reference/REVAL.html', { viewport });
    const ref = reference.page;
    await ref.emulateMedia({ reducedMotion:'reduce' });
    await ref.screenshot({ path:path.join(dir,'ref-login.png'),animations:'disabled' });
    const username = await ref.evaluate(() => JSON.parse(localStorage.getItem('reval-state-v9')).users.find(user=>user.roleId==='superadmin').username);
    await ref.selectOption('.login select',username);
    await ref.getByRole('button',{name:'ورود به سامانه'}).click();
    await ref.locator('.sidebar').waitFor();
    const context=await browser.newContext({viewport,locale:'fa-IR',timezoneId:'Asia/Tehran',reducedMotion:'reduce'});
    const page=await context.newPage();
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    const responses=[];
    page.on('response',response=>{
      if(response.url().includes('/api/') && response.status()>=400 && !response.url().endsWith('/auth/session'))
        responses.push(response.status()+' '+new URL(response.url()).pathname+new URL(response.url()).search);
    });
    await page.goto(base+'/login');
    await page.locator('select option[value=demo-reval]').waitFor({state:'attached'});
    await page.getByLabel('نقش',{exact:true}).selectOption('demo-reval');
    const passwordInput=page.locator('input[name=password]');
    await passwordInput.fill("reference");
    await page.getByRole('button',{name:'نمایش رمز عبور'}).click();
    if (await passwordInput.getAttribute('type')!=='text') throw Error('Password visibility failed');
    await page.getByRole('button',{name:'پنهان کردن رمز عبور'}).click();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(dir,'app-login.png'),animations:'disabled'});
    await passwordInput.fill(password);
    await page.getByRole('button',{name:'ورود به سامانه'}).click();
    await page.locator('.identity-shell').waitFor();
    for (const route of routes) {
      const key=route==='/'?'dashboard':route.slice(1);
      const refRoute=route==='/basket'||route==='/assembly'?route+'?line=L1':route;
      await ref.evaluate(route=>location.hash=route,refRoute);
      await page.goto(base+route);
      await page.locator('.content h1').first().waitFor({timeout:10000});
      await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
      await ref.evaluate(()=>document.fonts.ready);
      await page.evaluate(()=>document.fonts.ready);
      const refTitle=await ref.locator('.content h1').first().textContent();
      const appTitle=await page.locator('.content h1').first().textContent();
      const alerts=await page.getByRole('alert').allTextContents();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      await ref.screenshot({path:path.join(dir,'ref-'+key+'.png'),animations:'disabled'});
      await page.screenshot({path:path.join(dir,'app-'+key+'.png'),animations:'disabled'});
      report.push({viewport:size,route,refTitle,appTitle,alerts,overflow});
    }
    if(size==='1440x900'){
      await page.goto(base+'/trace');
      await page.getByRole('button',{name:'اسکن آزمایشی'}).click();
      await page.locator('.content').getByText('CTN-1405-8101',{exact:true}).first().waitFor();
      await page.goto(base+'/handover');
      await page.locator('.record-list a[aria-current=true]').waitFor();
      await page.goto(base+'/master');
      await page.getByRole('button',{name:/Nokia 130/}).click();
      await page.getByText('فهرست قطعات (BOM) · Nokia 130',{exact:true}).waitFor();
      await page.goto(base+'/final-qc?view=packing');
      await page.locator('.record-list a[aria-current=true]').waitFor();
      await page.goto(base+'/shipments');
      await page.getByRole('button',{name:'ثبت محموله جدید'}).click();
      await page.locator('dialog[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({state:'hidden'});
      await page.getByRole('button',{name:'PDF',exact:true}).click();
      const preview = page.getByRole('dialog',{name:'پیش‌نمایش PDF'});
      await preview.getByRole('button',{name:'چاپ / ذخیره PDF'}).waitFor();
      await page.screenshot({path:path.join(dir,'app-shipment-pdf-preview.png')});
      await page.pdf({path:path.join(dir,'rendered-shipment-report.pdf'),format:'A4'});
      await preview.getByRole('button',{name:'بستن',exact:true}).click();
      await page.setViewportSize({width:768,height:1024});
      const menu=page.getByRole('button',{name:'منو',exact:true});
      await menu.click();
      if (await menu.getAttribute('aria-expanded') !== 'true') throw Error('Drawer did not open');
      await page.keyboard.press('Escape');
      if (await menu.getAttribute('aria-expanded') !== 'false') throw Error('Drawer did not close');
      const scoped=await browser.newContext({viewport,locale:'fa-IR'});
      const station=await scoped.newPage();
      await station.goto(base+'/login');
      await station.getByLabel('نقش',{exact:true}).selectOption('demo-st06');
      await station.locator('input[name=password]').fill(password);
      await station.getByRole('button',{name:'ورود به سامانه'}).click();
      await station.locator('.identity-shell').waitFor();
      const options=await scoped.request.get(base+'/api/v1/assembly/options');
      const denied=await scoped.request.get(base+'/api/v1/users');
      if (denied.status()!==403 || (await options.json()).result.length!==1)
        throw Error('Station scope was not enforced');
      await scoped.close();
    }
    report.push({viewport:size,errors,apiErrors:[...new Set(responses)],referenceErrors:reference.errors});
    await context.close();
    await reference.browser.close();
  }
} finally {
  await fs.mkdir(evidence,{recursive:true});
  await fs.writeFile(path.join(evidence,'browser-results.json'),JSON.stringify(report,null,2));
  await browser.close();
}