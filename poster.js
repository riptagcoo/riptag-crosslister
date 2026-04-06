const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

async function postListing(page, listing) {
  await page.goto('https://www.depop.com/sell/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Upload photos
  if (listing.localPhotos && listing.localPhotos.length > 0) {
    const existingPhotos = listing.localPhotos.filter(p => fs.existsSync(p));
    if (existingPhotos.length > 0) {
      const photoInput = await page.$('input[type="file"][accept*="image"]');
      if (photoInput) {
        await photoInput.setInputFiles(existingPhotos);
        await page.waitForTimeout(2000);
      }
    }
  }

  // Title
  const titleInput = await page.$('input[name="description"], textarea[name="description"], input[placeholder*="title"], input[placeholder*="Title"]');
  if (titleInput) {
    await titleInput.click({ clickCount: 3 });
    await titleInput.type(listing.title || listing.description?.split('\n')[0] || 'Vintage Bundle');
    await page.waitForTimeout(300);
  }

  // Description
  const descInput = await page.$('textarea[name="description"], textarea[placeholder*="description"], textarea[placeholder*="Describe"]');
  if (descInput) {
    await descInput.click({ clickCount: 3 });
    await descInput.type(listing.description || '');
    await page.waitForTimeout(300);
  }

  // Price
  const priceInput = await page.$('input[name="price"], input[placeholder*="price"], input[placeholder*="Price"]');
  if (priceInput) {
    await priceInput.click({ clickCount: 3 });
    await priceInput.type(String(listing.price || ''));
    await page.waitForTimeout(300);
  }

  // Category - Men > T-shirts (attempt)
  try {
    const categoryBtn = await page.$('button[aria-label*="Category"], [data-testid*="category"]');
    if (categoryBtn) {
      await categoryBtn.click();
      await page.waitForTimeout(500);
      const menOption = await page.$('text=Men');
      if (menOption) { await menOption.click(); await page.waitForTimeout(400); }
      const tshirtOption = await page.$('text=T-shirts');
      if (tshirtOption) { await tshirtOption.click(); await page.waitForTimeout(400); }
    }
  } catch (e) { console.log('Category selection skipped:', e.message); }

  // Condition
  try {
    const conditionBtn = await page.$('button[aria-label*="Condition"], [data-testid*="condition"]');
    if (conditionBtn) {
      await conditionBtn.click();
      await page.waitForTimeout(400);
      const usedOption = await page.$('text=Used - Excellent');
      if (usedOption) { await usedOption.click(); await page.waitForTimeout(300); }
    }
  } catch (e) { console.log('Condition selection skipped:', e.message); }

  // Size
  if (listing.size) {
    try {
      const sizeBtn = await page.$('button[aria-label*="Size"], [data-testid*="size"]');
      if (sizeBtn) {
        await sizeBtn.click();
        await page.waitForTimeout(400);
        const sizeOption = await page.$(`text="${listing.size}"`);
        if (sizeOption) { await sizeOption.click(); await page.waitForTimeout(300); }
      }
    } catch (e) { console.log('Size selection skipped:', e.message); }
  }

  // Quantity - 100
  try {
    const qtyInput = await page.$('input[name="quantity"], input[placeholder*="Quantity"]');
    if (qtyInput) {
      await qtyInput.click({ clickCount: 3 });
      await qtyInput.type('100');
      await page.waitForTimeout(300);
    }
  } catch (e) { console.log('Quantity skipped:', e.message); }

  // Package size - Extra small
  try {
    const pkgBtn = await page.$('[data-testid*="package"], button[aria-label*="Package"]');
    if (pkgBtn) {
      await pkgBtn.click();
      await page.waitForTimeout(400);
      const xsOption = await page.$('text=Extra small');
      if (xsOption) { await xsOption.click(); await page.waitForTimeout(300); }
    }
  } catch (e) { console.log('Package size skipped:', e.message); }

  // Post
  const postBtn = await page.$('button[type="submit"], button:has-text("Post"), button:has-text("List")');
  if (postBtn) {
    await postBtn.click();
    await page.waitForTimeout(3000);
    return true;
  }

  return false;
}

async function crosslistToAccount(destUsername, destCookies, listings, onProgress) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  if (destCookies && destCookies.length > 0) {
    await context.addCookies(destCookies);
  }

  const page = await context.newPage();
  let successCount = 0;

  try {
    onProgress({ status: 'starting', message: `Logging into @${destUsername}...` });
    await page.goto('https://www.depop.com/login/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const loginCheck = await page.$('a[href="/login/"]');
    if (loginCheck) {
      onProgress({ status: 'error', message: 'Destination account not logged in. Please log in first.' });
      await browser.close();
      return 0;
    }

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      if (listing.crosslisted) {
        onProgress({ status: 'skipped', message: `Skipping already-crosslisted: ${listing.title}` });
        continue;
      }

      try {
        onProgress({
          status: 'posting',
          message: `Posting ${i + 1}/${listings.length}: ${listing.title || listing.id}`,
          progress: Math.round(((i + 1) / listings.length) * 100),
        });

        const success = await postListing(page, listing);
        if (success) {
          successCount++;
          listing.crosslisted = true;
          onProgress({
            status: 'posted',
            message: `✓ Posted: ${listing.title || listing.id}`,
            id: listing.id,
          });
        }

        // Human-like delay between posts
        const delay = 3000 + Math.random() * 4000;
        await page.waitForTimeout(delay);

      } catch (err) {
        console.error(`Error posting listing ${listing.id}:`, err.message);
        onProgress({ status: 'error', message: `Failed: ${listing.title} — ${err.message}` });
      }
    }

    // Save updated crosslist status
    await fs.writeJson('./data/listings.json', listings, { spaces: 2 });
    onProgress({ status: 'done', message: `Done. ${successCount} listings crosslisted.` });

  } catch (err) {
    onProgress({ status: 'error', message: err.message });
  } finally {
    await browser.close();
  }

  return successCount;
}

module.exports = { crosslistToAccount };
