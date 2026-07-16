// Render each whitepaper page to a print-styled PDF using Playwright +
// headless Chromium. Pages are served from a local http-server on :8080
// (started by the workflow) so we render exactly the HTML we just built.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE_DIR = 'whitepapers';
const BASE_URL = 'http://localhost:8080/whitepapers';

function discoverSlugs() {
  const slugs = [];
  for (const e of fs.readdirSync(SITE_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const idx = path.join(SITE_DIR, e.name, 'index.html');
    if (fs.existsSync(idx)) slugs.push(e.name);
  }
  return slugs.sort();
}

async function main() {
  const slugs = discoverSlugs();
  console.log(`Discovered ${slugs.length} whitepaper pages`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });

  let done = 0, failed = 0;
  const failedList = [];

  for (const slug of slugs) {
    const url = `${BASE_URL}/${slug}/`;
    const pdfPath = path.join(SITE_DIR, `${slug}.pdf`);
    try {
      const page = await context.newPage();
      // networkidle waits for network to be quiet — GTM & other beacons finish
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.emulateMedia({ media: 'print' });
      await page.pdf({
        path: pdfPath,
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' },
      });
      await page.close();
      done++;
      const size = (fs.statSync(pdfPath).size / 1024).toFixed(0);
      console.log(`  ✓ ${slug}.pdf (${size} KB)`);
    } catch (e) {
      failed++;
      failedList.push({ slug, error: e.message });
      console.log(`  ✗ ${slug}: ${e.message}`);
    }
  }

  await browser.close();

  console.log('');
  console.log(`Result: ${done} succeeded, ${failed} failed`);
  if (failedList.length) {
    console.log('Failures:');
    for (const f of failedList) console.log(`  - ${f.slug}: ${f.error}`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
