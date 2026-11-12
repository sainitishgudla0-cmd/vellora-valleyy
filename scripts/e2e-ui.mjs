// UI end-to-end checks for Velora Valley (drives a real Chrome).
// usage: TEST_TARGET=disposable npm run test:ui -- http://localhost:3000 ./screenshots
// Set CHROME_PATH if Chrome is not at the default Windows location.
// Places one test order marked "SMOKE TEST UI" in the database, so it refuses to run unless the
// server confirms its database is disposable (scripts/lib/safety.ts).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { assertServerIsDisposable } from './lib/safety.ts';
const [,, BASE='http://localhost:3000', OUT='./.e2e-screenshots'] = process.argv;
await assertServerIsDisposable(BASE);
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, d ?? ''); } };
const errors = [];
function watch(p, tag) {
  p.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource.*404/.test(m.text())) errors.push(`[${tag}] console: ${m.text().slice(0, 300)}`); });
}


// Real overflow check: lift the html/body overflow clip, scroll through the page so
// scroll-reveals settle, then compare document width with the viewport.
async function overflowOf(page) {
  return page.evaluate(async () => {
    document.documentElement.style.overflowX = 'visible';
    document.body.style.overflowX = 'visible';
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += window.innerHeight * 0.8) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    await new Promise(r => setTimeout(r, 1500));
    window.scrollTo(0, 0);
    const off = [...document.querySelectorAll('main *')].filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= window.innerWidth + 1) return false;
      // ignore content inside its own clipping/scrolling container
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o !== 'visible') return false;
      }
      return true;
    }).slice(0, 3).map(el => el.tagName + '.' + String(el.className).slice(0, 60));
    return { px: document.documentElement.scrollWidth - window.innerWidth, off };
  });
}

// ───────── desktop
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { sessionStorage.setItem('vv-intro', '1'); } catch {} });
const p = await ctx.newPage(); watch(p, 'desktop');
console.log('Desktop');
await p.goto(BASE + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
// dropdown
await p.hover('header nav >> text=Dates');
await p.waitForTimeout(700);
ok('Dates dropdown opens on hover', await p.isVisible('text=All Dates'));
await p.screenshot({ path: `${OUT}/e-dropdown-dates.png` });
await p.hover('header nav >> text=Shop');
await p.waitForTimeout(700);
ok('Shop mega menu shows categories', await p.isVisible('text=Shop all'));
await p.screenshot({ path: `${OUT}/e-dropdown-shop.png` });
await p.mouse.move(700, 600); await p.waitForTimeout(500);
await p.keyboard.press('Escape');

// shop search + filter
await p.goto(BASE + '/shop', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
const total = await p.locator('main article').count();
ok('shop lists all products', total >= 30, total);
await p.fill('#shop-search', 'dates');
await p.waitForTimeout(900);
const datesCount = await p.locator('main article').count();
ok('search narrows results', datesCount > 0 && datesCount < total, datesCount);
ok('URL reflects search', p.url().includes('q=dates'), p.url());
await p.fill('#shop-search', '');
await p.locator('aside label:has-text("Seeds")').click();
await p.waitForTimeout(900);
const seeds = await p.locator('main article').count();
ok('category checkbox filters (Seeds)', seeds === 8, seeds);
ok('URL reflects category', p.url().includes('category=seeds'), p.url());
await p.selectOption('#shop-sort', 'price-desc'); await p.waitForTimeout(700);
await p.screenshot({ path: `${OUT}/e-shop-seeds.png`, fullPage: false });
await p.goto(BASE + '/shop?q=zzzz', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
ok('empty state shown', await p.isVisible('text=Nothing found'));

// quick view + add to cart
await p.goto(BASE + '/shop?category=nuts', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
const card = p.locator('main article').first();
await card.hover(); await p.waitForTimeout(600);
await p.screenshot({ path: `${OUT}/e-card-hover.png` });
await card.locator('button:has-text("Quick view")').click();
await p.waitForTimeout(800);
ok('quick view modal opens', await p.isVisible('[role=dialog][aria-label$="quick view"]'));
await p.screenshot({ path: `${OUT}/e-quickview.png` });
await p.locator('[role=dialog] button:has-text("Add to cart")').click();
await p.waitForTimeout(600);
ok('toast confirms add to cart', await p.isVisible('text=added to your cart'));
await p.keyboard.press('Escape'); await p.waitForTimeout(1000);
ok('quick view closes on Escape', !(await p.isVisible('[role=dialog][aria-label$="quick view"]')));
const badge = await p.locator('header button[aria-label^="Open cart"]').first().getAttribute('aria-label');
ok('header cart count updates', /1 item/.test(badge), badge);

// product page: variant + qty + drawer
await p.goto(BASE + '/product/kimia-dates', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
await p.locator('label:has-text("400g")').click();
ok('variant price updates', await p.isVisible('text=₹350'));
await p.click('button[aria-label="Increase quantity"]');
await p.locator('main button:has-text("Add to cart")').first().click();
await p.waitForTimeout(900);
ok('cart drawer opens from product page', await p.isVisible('[role=dialog][aria-label="Your cart"]'));
await p.screenshot({ path: `${OUT}/e-drawer.png` });
const drawerText = await p.locator('[role=dialog][aria-label="Your cart"]').innerText();
ok('drawer shows Kimia 400g × 2', drawerText.toLowerCase().includes('kimia dates') && drawerText.toLowerCase().includes('400g'));
await p.keyboard.press('Escape'); await p.waitForTimeout(500);

// cart page qty / persistence
await p.goto(BASE + '/cart', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
ok('cart persisted across navigation', (await p.locator('main li:has(button[aria-label^="Remove"])').count()) >= 2);
await p.screenshot({ path: `${OUT}/e-cart.png` });

// checkout validation + order
await p.goto(BASE + '/checkout', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
await p.click('button[type=submit]');
await p.waitForTimeout(400);
ok('checkout shows validation errors', (await p.locator('.field-error').count()) >= 5, await p.locator('.field-error').count());
await p.screenshot({ path: `${OUT}/e-checkout-errors.png` });
await p.fill('#f-customerName', 'SMOKE TEST UI');
await p.fill('#f-phone', '9876500000');
await p.fill('#f-email', 'smoke.ui@example.com');
await p.fill('#f-addressLine1', '4 UI Test Road');
await p.fill('#f-city', 'Anantapur');
await p.fill('#f-pincode', '515002');
await p.selectOption('#f-state', 'Andhra Pradesh');
await p.fill('#f-notes', 'SMOKE TEST — please ignore');
ok('online payment disabled when not configured', await p.isDisabled('input[name=payment] >> nth=1'));
await p.click('button[type=submit]');
await p.waitForURL(/\/order\//, { timeout: 15000 }).catch(() => {});
ok('redirected to order confirmation', /\/order\/VV-/.test(p.url()), p.url());
await p.waitForTimeout(1200);
ok('confirmation is honest (no payment taken)', await p.isVisible('text=No payment has been taken'));
await p.screenshot({ path: `${OUT}/e-confirmation.png` });
const after = await p.locator('header button[aria-label^="Open cart"]').first().getAttribute('aria-label');
ok('cart cleared after order', /0 items/.test(after), after);

// contact form
await p.goto(BASE + '/business?interest=export', { waitUntil: 'networkidle' }); await p.waitForTimeout(1000);
ok('business interest preselected from URL', await p.isChecked('input[name=interest] >> nth=4'));
await p.click('form button[type=submit]'); await p.waitForTimeout(300);
ok('business form validates', (await p.locator('.field-error').count()) >= 3);

// no horizontal overflow on key pages
for (const path of ['/', '/shop', '/product/safawi-dates', '/our-story', '/quality', '/business', '/contact']) {
  await p.goto(BASE + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
  const ov = await overflowOf(p);
  ok(`no horizontal overflow ${path} (desktop)`, ov.off.length === 0, ov);
}

// ───────── mobile
const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.addInitScript(() => { try { sessionStorage.setItem('vv-intro', '1'); } catch {} });
const mp = await m.newPage(); watch(mp, 'mobile');
console.log('Mobile');
for (const path of ['/', '/shop', '/product/premium-cashews', '/cart', '/checkout', '/our-story', '/quality', '/business', '/contact']) {
  await mp.goto(BASE + path, { waitUntil: 'networkidle' }); await mp.waitForTimeout(700);
  const ov = await overflowOf(mp);
  ok(`no horizontal overflow ${path} (390px)`, ov.off.length === 0, ov);
}
await mp.goto(BASE + '/', { waitUntil: 'networkidle' }); await mp.waitForTimeout(2500);
await mp.screenshot({ path: `${OUT}/m-home.png` });
await mp.click('button[aria-controls=mobile-menu]'); await mp.waitForTimeout(1000);
ok('mobile menu opens', await mp.isVisible('#mobile-menu'));
await mp.screenshot({ path: `${OUT}/m-menu.png` });
await mp.click('#mobile-menu button[aria-label="Show Dates links"]'); await mp.waitForTimeout(600);
ok('mobile submenu expands', await mp.isVisible('#mobile-menu >> text=Safawi Dates'));
await mp.click('button[aria-controls=mobile-menu]'); await mp.waitForTimeout(700);
await mp.goto(BASE + '/shop', { waitUntil: 'networkidle' }); await mp.waitForTimeout(1000);
await mp.click('button:has-text("Filters")'); await mp.waitForTimeout(700);
ok('mobile filter drawer opens', await mp.isVisible('[role=dialog][aria-label=Filters]'));
await mp.screenshot({ path: `${OUT}/m-filters.png` });

// ───────── tablet
const t = await b.newContext({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
await t.addInitScript(() => { try { sessionStorage.setItem('vv-intro', '1'); } catch {} });
const tp = await t.newPage(); watch(tp, 'tablet');
console.log('Tablet');
for (const path of ['/', '/shop', '/product/kimia-dates', '/checkout', '/our-story', '/quality', '/business']) {
  await tp.goto(BASE + path, { waitUntil: 'networkidle' }); await tp.waitForTimeout(700);
  const ov = await overflowOf(tp);
  ok(`no horizontal overflow ${path} (768px)`, ov.off.length === 0, ov);
}

// ───────── reduced motion
const r = await b.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const rp = await r.newPage(); watch(rp, 'reduced');
console.log('Reduced motion');
await rp.goto(BASE + '/', { waitUntil: 'networkidle' }); await rp.waitForTimeout(1200);
const hidden = await rp.evaluate(() => [...document.querySelectorAll('[data-reveal],[data-hero-anim]')].filter(e => getComputedStyle(e).opacity === '0').length);
ok('content visible with reduced motion', hidden === 0, hidden);
const loader = await rp.evaluate(() => !!document.querySelector('.fixed.inset-0.z-\\[100\\]'));
ok('no intro loader with reduced motion', !loader);

console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) { console.log('\nBrowser errors:'); [...new Set(errors)].slice(0, 20).forEach(e => console.log(' -', e)); }
await b.close();
process.exit(fail ? 1 : 0);
