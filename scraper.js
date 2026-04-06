const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

const LISTINGS_FILE = './data/listings.json';
const PHOTOS_DIR = './data/photos';

async function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    fs.ensureDirSync(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function scrapeAccount(username, cookies, onProgress) {
  fs.ensureDirSync('./data');
  fs.ensureDirSync(PHOTOS_DIR);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // Inject saved cookies if provided
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  const listings = [];

  try {
    onProgress({ status: 'navigating', message: `Opening @${username}'s profile...` });
    await page.goto(`https://www.depop.com/${username}/`, { waitUntil: 'networkidle' });

    // Check if logged in
    const loginCheck = await page.$('a[href="/login/"]');
    if (loginCheck) {
      onProgress({ status: 'error', message: 'Not logged in. Please log in first.' });
      await browser.close();
      return null;
    }

    // Scroll to load all listings
    onProgress({ status: 'scraping', message: 'Loading all listings...' });
    let prevCount = 0;
    let sameCount = 0;
    while (sameCount < 3) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const items = await page.$$('a[href*="/products/"]');
      if (items.length === prevCount) sameCount++;
      else sameCount = 0;
      prevCount = items.length;
    }

    // Get all listing URLs
    const listingLinks = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/products/"]')];
      const urls = [...new Set(anchors.map(a => a.href))];
      return urls.filter(u => u.includes('/products/'));
    });

    onProgress({ status: 'scraping', message: `Found ${listingLinks.length} listings. Scraping details...` });

    for (let i = 0; i < listingLinks.length; i++) {
      const url = listingLinks[i];
      const listingId = url.split('/products/')[1]?.replace('/', '');

      try {
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        const data = await page.evaluate(() => {
          // Title
          const title = document.querySelector('h1')?.innerText?.trim() || '';

          // Description
          const desc = document.querySelector('[data-testid="listing-description"]')?.innerText?.trim()
            || document.querySelector('p[class*="Description"]')?.innerText?.trim()
            || '';

          // Price
          const priceEl = document.querySelector('[data-testid="listing-price"]')
            || document.querySelector('p[class*="price"]');
          const price = priceEl?.innerText?.replace('$', '').trim() || '';

          // Photos
          const imgEls = [...document.querySelectorAll('img[src*="depop"]')];
          const photos = [...new Set(imgEls
            .map(img => img.src)
            .filter(src => src.includes('depop') && !src.includes('avatar') && !src.includes('icon'))
          )];

          // Size
          const sizeEl = [...document.querySelectorAll('*')].find(el =>
            el.innerText?.match(/^(XS|S|M|L|XL|XXL|One Size|\d+)$/) && el.children.length === 0
          );
          const size = sizeEl?.innerText?.trim() || '';

          // Condition
          const conditionEl = document.querySelector('[data-testid="listing-condition"]')
            || [...document.querySelectorAll('*')].find(el =>
              el.innerText?.toLowerCase().includes('used') || el.innerText?.toLowerCase().includes('new with tags')
            );
          const condition = conditionEl?.innerText?.trim() || 'Used - Excellent';

          // Brand
          const brandEl = document.querySelector('[data-testid="listing-brand"]');
          const brand = brandEl?.innerText?.trim() || 'Other';

          return { title, description: desc, price, photos, size, condition, brand };
        });

        // Download photos
        const localPhotos = [];
        for (let j = 0; j < Math.min(data.photos.length, 4); j++) {
          const photoUrl = data.photos[j];
          const ext = photoUrl.split('.').pop().split('?')[0] || 'jpg';
          const localPath = path.join(PHOTOS_DIR, `${listingId}_${j}.${ext}`);
          try {
            await downloadImage(photoUrl, localPath);
            localPhotos.push(localPath);
          } catch (e) {
            console.error(`Photo download failed: ${e.message}`);
          }
        }

        listings.push({
          id: listingId,
          url,
          ...data,
          localPhotos,
          crosslisted: false,
        });

        onProgress({
          status: 'scraping',
          message: `Scraped ${i + 1}/${listingLinks.length}: ${data.title || listingId}`,
          progress: Math.round(((i + 1) / listingLinks.length) * 100),
          count: listings.length,
        });

        await page.waitForTimeout(500);
      } catch (err) {
        console.error(`Error scraping ${url}:`, err.message);
      }
    }

    await fs.writeJson(LISTINGS_FILE, listings, { spaces: 2 });
    onProgress({ status: 'done', message: `Scraped ${listings.length} listings.`, listings });

  } catch (err) {
    onProgress({ status: 'error', message: err.message });
  } finally {
    await browser.close();
  }

  return listings;
}

module.exports = { scrapeAccount };
