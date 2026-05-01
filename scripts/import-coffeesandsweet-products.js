/**
 * Import products from https://coffeesandsweet.com into a shop.
 * Fetches via WooCommerce Store API (no auth required) and inserts as Product rows.
 *
 * Target shop phone: 201278596024 (created if missing).
 * Run: node scripts/import-coffeesandsweet-products.js
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const SHOP_PHONE = '201278596024';
const SHOP_PASSWORD = '201278596024';
const SHOP_NAME = 'Coffees and Sweets';
const OWNER_NAME = 'Coffees and Sweets';
const STORE_API = 'https://coffeesandsweet.com/wp-json/wc/store/v1/products';
const PER_PAGE = 100;

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripHtml(html) {
  if (!html) return '';
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\u00a0/g, ' ')
  )
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}

async function fetchAllProducts() {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${STORE_API}?per_page=${PER_PAGE}&page=${page}`;
    console.log(`📥 Fetching page ${page}: ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ Fetch failed page ${page}: ${res.status}`);
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < PER_PAGE) break;
    page++;
  }
  console.log(`✅ Total products fetched: ${all.length}`);
  return all;
}

async function ensureShop() {
  let shop = await prisma.shop.findUnique({ where: { phone: SHOP_PHONE } });
  if (shop) {
    console.log(`✅ Found existing shop: ${shop.id} (${shop.name})`);
    return shop;
  }
  console.log('🆕 Creating new shop...');
  const hashed = await bcrypt.hash(SHOP_PASSWORD, 10);
  shop = await prisma.shop.create({
    data: {
      name: SHOP_NAME,
      ownerName: OWNER_NAME,
      phone: SHOP_PHONE,
      whatsappNumber: SHOP_PHONE,
      shopType: 'traditional',
      subscriptionStatus: 'ACTIVE',
      subscriptionEnd: new Date('2030-12-31'),
      password: hashed,
    },
  });
  console.log(`✅ Shop created: ${shop.id}`);

  // Ensure admin record for login
  const adminEmail = `${SHOP_PHONE}@wahdabot.com`;
  const existingAdmin = await prisma.admin.findFirst({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.admin.create({ data: { email: adminEmail, password: hashed } });
    console.log(`✅ Admin login created: ${adminEmail}`);
  }
  return shop;
}

async function importProducts() {
  const shop = await ensureShop();
  const products = await fetchAllProducts();

  // Clear old products for this shop to avoid duplicates
  const deleted = await prisma.product.deleteMany({ where: { shopId: shop.id } });
  console.log(`🗑️  Deleted ${deleted.count} old products`);

  let created = 0;
  let skipped = 0;
  for (const p of products) {
    try {
      const name = decodeHtmlEntities(p.name).trim();
      const minor = parseInt(p?.prices?.price ?? '0', 10);
      const minorUnit = parseInt(p?.prices?.currency_minor_unit ?? '2', 10);
      const price = minor / Math.pow(10, minorUnit);
      if (!name || !price || price <= 0) {
        skipped++;
        continue;
      }
      const description = stripHtml(p.description || p.short_description || '');
      const imageUrl = p?.images?.[0]?.src || null;
      const category = p?.categories?.[0]?.name || null;
      const isAvailable = !!p.is_in_stock && !!p.is_purchasable;

      await prisma.product.create({
        data: {
          shopId: shop.id,
          name,
          price,
          description: description || null,
          imageUrl,
          category,
          isAvailable,
          stock: isAvailable ? null : 0,
        },
      });
      created++;
    } catch (e) {
      console.error(`❌ Failed to import product "${p.name}":`, e.message);
      skipped++;
    }
  }

  console.log(`\n═══════════════════════════════════`);
  console.log(`✅ IMPORT COMPLETE`);
  console.log(`═══════════════════════════════════`);
  console.log(`Shop: ${shop.name} (${shop.id})`);
  console.log(`Phone/Login: ${SHOP_PHONE}`);
  console.log(`Created: ${created} products`);
  console.log(`Skipped: ${skipped}`);
  console.log(`═══════════════════════════════════\n`);
}

importProducts()
  .catch((e) => {
    console.error('💥 Import failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
