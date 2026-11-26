import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outPath = resolve('tests/fixtures/shop_demo.sqlite');
mkdirSync(dirname(outPath), { recursive: true });
if (existsSync(outPath)) unlinkSync(outPath);

const lines = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = DELETE;',
  '',
  'CREATE TABLE categories (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  slug TEXT NOT NULL UNIQUE,',
  '  name TEXT NOT NULL,',
  '  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,',
  '  sort_order INTEGER NOT NULL DEFAULT 0',
  ');',
  '',
  'CREATE TABLE customers (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  email TEXT NOT NULL UNIQUE,',
  '  full_name TEXT NOT NULL,',
  "  tier TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('free','standard','pro','enterprise')),",
  "  country_code TEXT NOT NULL DEFAULT 'US',",
  '  city TEXT,',
  '  phone TEXT,',
  '  is_active INTEGER NOT NULL DEFAULT 1,',
  '  lifetime_value REAL NOT NULL DEFAULT 0.0,',
  "  preferences TEXT NOT NULL DEFAULT '{}',",
  '  notes TEXT,',
  "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
  "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ');',
  '',
  'CREATE TABLE products (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  sku TEXT NOT NULL UNIQUE,',
  '  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,',
  '  name TEXT NOT NULL,',
  '  description TEXT,',
  '  price REAL NOT NULL CHECK (price >= 0),',
  '  cost REAL,',
  '  stock_qty INTEGER NOT NULL DEFAULT 0,',
  '  is_published INTEGER NOT NULL DEFAULT 1,',
  "  specs TEXT NOT NULL DEFAULT '{}',",
  '  checksum BLOB,',
  "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ');',
  '',
  'CREATE TABLE orders (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  order_no TEXT NOT NULL UNIQUE,',
  '  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,',
  "  status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),",
  "  currency TEXT NOT NULL DEFAULT 'USD',",
  '  subtotal REAL NOT NULL,',
  '  discount REAL NOT NULL DEFAULT 0.0,',
  '  tax REAL NOT NULL DEFAULT 0.0,',
  '  total_amount REAL NOT NULL,',
  '  shipping_address TEXT,',
  '  memo TEXT,',
  "  placed_at TEXT NOT NULL DEFAULT (datetime('now')),",
  "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ');',
  '',
  'CREATE TABLE order_items (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,',
  '  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,',
  '  quantity INTEGER NOT NULL CHECK (quantity > 0),',
  '  unit_price REAL NOT NULL,',
  '  line_total REAL NOT NULL',
  ');',
  '',
  'CREATE TABLE reviews (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,',
  '  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,',
  '  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),',
  '  title TEXT,',
  '  body TEXT,',
  '  verified_purchase INTEGER NOT NULL DEFAULT 1,',
  "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
  '  UNIQUE (product_id, customer_id)',
  ');',
  '',
  'CREATE TABLE audit_events (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  entity_type TEXT NOT NULL,',
  '  entity_id INTEGER NOT NULL,',
  '  action TEXT NOT NULL,',
  "  payload TEXT NOT NULL DEFAULT '{}',",
  "  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))",
  ');',
  '',
  'CREATE INDEX idx_customers_tier_country ON customers (tier, country_code);',
  'CREATE INDEX idx_products_cat_price ON products (category_id, price DESC);',
  'CREATE INDEX idx_orders_customer_placed ON orders (customer_id, placed_at DESC);',
  'CREATE INDEX idx_orders_status_placed ON orders (status, placed_at DESC);',
  'CREATE INDEX idx_order_items_order_prod ON order_items (order_id, product_id);',
  'CREATE INDEX idx_reviews_product_rating ON reviews (product_id, rating DESC);',
  '',
  'CREATE TRIGGER trg_customers_updated_at',
  'AFTER UPDATE ON customers',
  'FOR EACH ROW',
  'BEGIN',
  "  UPDATE customers SET updated_at = datetime('now') WHERE id = NEW.id;",
  'END;',
  '',
  'CREATE TRIGGER trg_orders_status_audit',
  'AFTER UPDATE OF status ON orders',
  'WHEN NEW.status <> OLD.status',
  'BEGIN',
  "  INSERT INTO audit_events (entity_type, entity_id, action, payload)",
  "  VALUES ('order', NEW.id, 'status_changed', json_object('from', OLD.status, 'to', NEW.status));",
  'END;',
  '',
  'CREATE VIEW v_customer_order_summary AS',
  'SELECT',
  '  c.id AS customer_id,',
  '  c.full_name,',
  '  c.email,',
  '  c.tier,',
  '  COUNT(o.id) AS order_count,',
  '  COALESCE(SUM(o.total_amount), 0.0) AS total_spent,',
  '  MAX(o.placed_at) AS last_order_at',
  'FROM customers c',
  "LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'",
  'GROUP BY c.id, c.full_name, c.email, c.tier;',
  '',
  'CREATE VIEW v_product_sales_stats AS',
  'SELECT',
  '  p.id AS product_id,',
  '  p.sku,',
  '  p.name,',
  '  cat.name AS category_name,',
  '  p.price,',
  '  p.stock_qty,',
  '  COALESCE(SUM(oi.quantity), 0) AS units_sold,',
  '  COALESCE(SUM(oi.line_total), 0.0) AS gross_revenue,',
  '  ROUND(AVG(r.rating), 2) AS avg_rating',
  'FROM products p',
  'JOIN categories cat ON cat.id = p.category_id',
  'LEFT JOIN order_items oi ON oi.product_id = p.id',
  'LEFT JOIN reviews r ON r.product_id = p.id',
  'GROUP BY p.id, p.sku, p.name, cat.name, p.price, p.stock_qty;',
  '',
  'BEGIN TRANSACTION;',
];

const esc = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// 6 categories
const categories = [
  ['hardware', 'Hardware & Peripherals', null, 1],
  ['keyboards', 'Mechanical Keyboards ⌨️', 1, 2],
  ['monitors', '4K & Studio Monitors', 1, 3],
  ['cloud-saas', 'Cloud & DevTools SaaS ☁️', null, 4],
  ['accessories', 'Desk Accessories', 1, 5],
  ['audio', 'Studio Audio & Mics 🎧', 1, 6],
];
for (const [slug, name, parent, sort] of categories) {
  lines.push(`INSERT INTO categories (slug, name, parent_id, sort_order) VALUES (${esc(slug)}, ${esc(name)}, ${parent ?? 'NULL'}, ${sort});`);
}

// 25 customers
const baseCustomers = [
  ['qi.chen@netcatty.dev', '陈琪 (Qi Chen) 🚀', 'enterprise', 'CN', '上海静安区', '+86-138-0013-8000', 1, 12890.5, '{"theme":"dark","locale":"zh-CN"}', '核心企业客户 🔥'],
  ['alice.morgan@acme.io', 'Alice Morgan', 'pro', 'US', 'San Francisco', '+1-415-555-0142', 1, 4320.0, '{"theme":"light","locale":"en-US"}', null],
  ['kenji.sato@tokyo-ops.jp', '佐藤健司 (Kenji Sato)', 'enterprise', 'JP', 'Tokyo', '+81-3-5555-0199', 1, 9875.25, '{"theme":"dark","locale":"ja-JP"}', 'Requires JPY invoice'],
  ['lin.wei@cloudcraft.cn', '林伟', 'pro', 'CN', '深圳南山区', null, 1, 2150.0, '{"theme":"system","locale":"zh-CN"}', '机械键盘发烧友 ⭐'],
  ['elena.rossi@milano.it', 'Elena Rossi', 'standard', 'IT', 'Milan', '+39-02-5550192', 1, 640.8, '{"theme":"light","locale":"it-IT"}', null],
  ['marcus.vance@nordic.se', 'Marcus Vance', 'free', 'SE', 'Stockholm', null, 0, 0.0, '{"theme":"dark"}', 'Churned trial'],
  ['sophie.laurent@paris.fr', 'Sophie Laurent ✨', 'pro', 'FR', 'Paris', '+33-1-42-68-53-00', 1, 3499.99, '{"theme":"light","locale":"fr-FR"}', 'Design systems lead'],
  ['david.kim@seoultech.kr', '김다윗 (David Kim)', 'standard', 'KR', 'Seoul', '+82-2-555-0188', 1, 1120.4, '{"theme":"dark","locale":"ko-KR"}', null],
];
const tiers = ['free', 'standard', 'pro', 'enterprise'];
const countries = [['US', 'New York'], ['CN', '北京朝阳区'], ['DE', 'Berlin'], ['GB', 'London'], ['SG', 'Singapore'], ['CA', 'Toronto']];
for (let i = 0; i < 17; i++) {
  const n = i + 9;
  const [cc, city] = countries[i % countries.length];
  const tier = tiers[i % tiers.length];
  baseCustomers.push([
    `user${n}@demo-shop.test`,
    i % 3 === 0 ? `测试用户_${n} 🌟` : `Demo Customer ${n}`,
    tier,
    cc,
    city,
    i % 4 === 0 ? null : `+1-555-01${String(n).padStart(2, '0')}`,
    i % 7 === 0 ? 0 : 1,
    Number((120 + i * 247.35).toFixed(2)),
    JSON.stringify({ theme: i % 2 === 0 ? 'dark' : 'light', beta: i % 3 === 0 }),
    i % 5 === 0 ? null : `Automated fixture customer #${n}`,
  ]);
}
for (const c of baseCustomers) {
  lines.push(
    `INSERT INTO customers (email, full_name, tier, country_code, city, phone, is_active, lifetime_value, preferences, notes) VALUES (${esc(c[0])}, ${esc(c[1])}, ${esc(c[2])}, ${esc(c[3])}, ${esc(c[4])}, ${esc(c[5])}, ${c[6]}, ${c[7]}, ${esc(c[8])}, ${esc(c[9])});`
  );
}

// 16 products
const products = [
  ['KB-NC-75', 2, 'Netcatty Tactile 75% 机械键盘 ⌨️', 'CNC 铝合金机身，热插拔静音段落轴', 189.0, 92.5, 140, 1, '{"switches":"Tactile 55g","layout":"75%"}', "X'DEADBEEF01020304'"],
  ['KB-LP-65', 2, 'AirSlim 65 Low-Profile Keyboard', 'Ultra-thin aluminum travel keyboard', 149.0, 71.0, 85, 1, '{"switches":"Low-Profile Brown","layout":"65%"}', "X'CAFEBABE11223344'"],
  ['MON-4K-27', 3, 'StudioPro 27" 4K HiDPI Monitor', 'IPS Black 2000:1, 98% DCI-P3, USB-C 96W PD', 699.0, 410.0, 32, 1, '{"resolution":"3840x2160","refresh_hz":120}', 'NULL'],
  ['SAAS-PRO-YR', 4, 'Netcatty Cloud Sync Pro (Annual) 🚀', 'End-to-end encrypted vault & DB sync', 96.0, 8.0, 999999, 1, '{"billing":"annual","seats":1}', 'NULL'],
  ['SAAS-ENT-YR', 4, 'Netcatty Enterprise Team Suite (10 Seats)', 'SSO/SAML, audit logs, bastion policies', 1490.0, 120.0, 999999, 1, '{"billing":"annual","seats":10}', 'NULL'],
  ['ACC-HUB-TB4', 5, 'ThunderDock 4 Pro Hub', '12-in-1 Thunderbolt 4 desktop dock', 249.0, 118.0, 54, 1, '{"bandwidth_gbps":40}', "X'0011223344556677'"],
  ['ACC-MAT-XL', 5, 'Wool Felt Desk Mat XL — 炭黑灰', 'Merino wool desk mat with cork base', 45.0, 14.2, 210, 1, '{"size_mm":"900x400"}', 'NULL'],
  ['KB-PROTO-01', 2, 'Unreleased Split Ergo Prototype', null, 299.0, null, 0, 0, '{"stage":"prototype"}', 'NULL'],
  ['AUD-MIC-USB', 6, 'Broadcast Dynamic USB-C Mic 🎙️', 'Cardioid studio mic with hardware mute', 129.0, 52.0, 73, 1, '{"sample_rate":"96kHz"}', 'NULL'],
  ['AUD-HP-PRO', 6, 'OpenBack Reference Headphones', 'Planar magnetic mixing headphones', 349.0, 175.0, 29, 1, '{"impedance_ohm":38}', 'NULL'],
  ['MON-5K-32', 3, 'UltraStudio 32" 6K Reference Display', '6016x3384 matte nano-texture glass', 1599.0, 980.0, 11, 1, '{"resolution":"6016x3384"}', 'NULL'],
  ['ACC-STAND-AL', 5, 'Anodized Laptop Vertical Stand', 'Weighted CNC aluminum stand', 59.0, 18.0, 165, 1, '{"color":"space-gray"}', 'NULL'],
  ['KB-NUM-20', 2, 'Wireless QMK Macro Numpad', '20-key programmable rotary encoder pad', 79.0, 31.0, 112, 1, '{"encoder":true}', 'NULL'],
  ['SAAS-AI-PACK', 4, 'SQL Copilot Token Pack (10M)', 'Schema-aware SQL drafting credits', 49.0, 12.0, 999999, 1, '{"tokens":10000000}', 'NULL'],
  ['ACC-CABLE-COIL', 5, 'Aviator Coiled USB-C Cable', 'Double-sleeved braided cable', 39.0, 11.5, 320, 1, '{"length_m":1.8}', 'NULL'],
  ['ACC-LIGHT-BAR', 5, 'Asymmetric Monitor Light Bar 💡', 'Zero-glare CRI 97+ desk illumination', 89.0, 34.0, 94, 1, '{"cri":97}', 'NULL'],
];
for (const p of products) {
  lines.push(
    `INSERT INTO products (sku, category_id, name, description, price, cost, stock_qty, is_published, specs, checksum) VALUES (${esc(p[0])}, ${p[1]}, ${esc(p[2])}, ${esc(p[3])}, ${p[4]}, ${p[5] ?? 'NULL'}, ${p[6]}, ${p[7]}, ${esc(p[8])}, ${p[9]});`
  );
}

// 40 orders + 64 order_items
const statuses = ['delivered', 'delivered', 'shipped', 'paid', 'pending', 'cancelled', 'refunded'];
for (let i = 1; i <= 40; i++) {
  const custId = ((i - 1) % 25) + 1;
  const prodA = ((i - 1) % 15) + 1;
  const prodB = ((i + 3) % 15) + 1;
  const qtyA = (i % 2) + 1;
  const priceA = products[prodA - 1][4];
  const hasSecond = i % 3 !== 0 && prodB !== prodA;
  const priceB = products[prodB - 1][4];
  const subtotal = Number((qtyA * priceA + (hasSecond ? priceB : 0)).toFixed(2));
  const discount = i % 4 === 0 ? 20.0 : 0.0;
  const tax = i % 2 === 0 ? Number(((subtotal - discount) * 0.08).toFixed(2)) : 0.0;
  const total = Number((subtotal - discount + tax).toFixed(2));
  const status = statuses[i % statuses.length];
  const currency = i % 5 === 0 ? 'EUR' : 'USD';
  const dayOffset = 45 - i;
  const memo = i === 1 ? '请工作日送达 🎉' : i % 6 === 0 ? null : `Order batch #${i}`;
  lines.push(
    `INSERT INTO orders (order_no, customer_id, status, currency, subtotal, discount, tax, total_amount, shipping_address, memo, placed_at) VALUES (${esc(`ORD-2026-${String(i).padStart(4, '0')}`)}, ${custId}, ${esc(status)}, ${esc(currency)}, ${subtotal}, ${discount}, ${tax}, ${total}, ${esc(JSON.stringify({ city: baseCustomers[custId - 1][4], country: baseCustomers[custId - 1][3] }))}, ${esc(memo)}, datetime('now', '-${dayOffset} days'));`
  );
  lines.push(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (${i}, ${prodA}, ${qtyA}, ${priceA}, ${Number((qtyA * priceA).toFixed(2))});`
  );
  if (hasSecond) {
    lines.push(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (${i}, ${prodB}, 1, ${priceB}, ${priceB});`
    );
  }
}

// 24 reviews
for (let i = 0; i < 24; i++) {
  const prodId = (i % 12) + 1;
  const custId = ((i * 3) % 25) + 1;
  const rating = [5, 5, 4, 5, 4, 3][i % 6];
  const title = i === 0 ? '手感极佳的静音段落轴！🔥' : i === 1 ? 'Best dev monitor ⭐' : `Verified review #${i + 1}`;
  const body = i === 0 ? '铝坨坨质感拉满，写 SQL 很舒服。' : i % 5 === 0 ? null : `Solid build quality and fast shipping (review ${i + 1}).`;
  lines.push(
    `INSERT OR IGNORE INTO reviews (product_id, customer_id, rating, title, body, verified_purchase) VALUES (${prodId}, ${custId}, ${rating}, ${esc(title)}, ${esc(body)}, ${i % 6 === 0 ? 0 : 1});`
  );
}

lines.push("INSERT INTO audit_events (entity_type, entity_id, action, payload) VALUES ('order', 1, 'created', '{\"order_no\":\"ORD-2026-0001\"}');");
lines.push("INSERT INTO audit_events (entity_type, entity_id, action, payload) VALUES ('customer', 1, 'tier_upgraded', '{\"from\":\"pro\",\"to\":\"enterprise\"}');");
lines.push('COMMIT;');

execFileSync('sqlite3', [outPath], { input: lines.join('\n'), stdio: ['pipe', 'inherit', 'inherit'] });
const summary = execFileSync(
  'sqlite3',
  [outPath, "SELECT 'customers', COUNT(*) FROM customers UNION ALL SELECT 'categories', COUNT(*) FROM categories UNION ALL SELECT 'products', COUNT(*) FROM products UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'order_items', COUNT(*) FROM order_items UNION ALL SELECT 'reviews', COUNT(*) FROM reviews;"],
  { encoding: 'utf8' }
);
console.log('Generated', outPath);
console.log(summary.trim());
