-- PostgreSQL 17 rich SaaS / e-commerce demo seed for Netcatty Database tests

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  external_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  email VARCHAR(160) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  tier VARCHAR(24) NOT NULL DEFAULT 'standard' CHECK (tier IN ('free', 'standard', 'pro', 'enterprise')),
  country_code CHAR(2) NOT NULL DEFAULT 'US',
  city VARCHAR(80),
  phone VARCHAR(40),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  lifetime_value NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  sku VARCHAR(48) NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name VARCHAR(180) NOT NULL,
  description TEXT,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  cost NUMERIC(12, 2),
  stock_qty INTEGER NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  specs JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  order_no VARCHAR(40) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal NUMERIC(14, 2) NOT NULL,
  discount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  tax NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  total_amount NUMERIC(14, 2) NOT NULL,
  shipping_address JSONB,
  memo TEXT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL,
  line_total NUMERIC(14, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

CREATE TABLE reviews (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(160),
  body TEXT,
  verified_purchase BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, customer_id)
);

CREATE TABLE analytics.audit_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(48) NOT NULL,
  entity_id BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite & partial indexes
CREATE INDEX idx_customers_tier_country ON customers (tier, country_code);
CREATE INDEX idx_customers_prefs_gin ON customers USING GIN (preferences);
CREATE INDEX idx_products_cat_price ON products (category_id, price DESC);
CREATE INDEX idx_orders_customer_placed ON orders (customer_id, placed_at DESC);
CREATE INDEX idx_orders_status_placed ON orders (status, placed_at DESC) WHERE status <> 'cancelled';
CREATE INDEX idx_order_items_order_prod ON order_items (order_id, product_id);
CREATE INDEX idx_reviews_product_rating ON reviews (product_id, rating DESC);

-- Function & trigger
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION log_order_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO analytics.audit_events (entity_type, entity_id, action, payload)
    VALUES ('order', NEW.id, 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_status_audit
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION log_order_status_change();

-- Views
CREATE VIEW v_customer_order_summary AS
SELECT
  c.id AS customer_id,
  c.full_name,
  c.email,
  c.tier,
  COUNT(o.id) AS order_count,
  COALESCE(SUM(o.total_amount), 0.00) AS total_spent,
  MAX(o.placed_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
GROUP BY c.id, c.full_name, c.email, c.tier;

CREATE VIEW v_product_sales_stats AS
SELECT
  p.id AS product_id,
  p.sku,
  p.name,
  cat.name AS category_name,
  p.price,
  p.stock_qty,
  COALESCE(SUM(oi.quantity), 0) AS units_sold,
  COALESCE(SUM(oi.line_total), 0.00) AS gross_revenue,
  ROUND(AVG(r.rating)::numeric, 2) AS avg_rating
FROM products p
JOIN categories cat ON cat.id = p.category_id
LEFT JOIN order_items oi ON oi.product_id = p.id
LEFT JOIN reviews r ON r.product_id = p.id
GROUP BY p.id, p.sku, p.name, cat.name, p.price, p.stock_qty;

-- Seed categories
INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
  ('hardware', 'Hardware & Peripherals', NULL, 1),
  ('keyboards', 'Mechanical Keyboards ⌨️', 1, 2),
  ('monitors', '4K & Studio Monitors', 1, 3),
  ('cloud-saas', 'Cloud & DevTools SaaS ☁️', NULL, 4),
  ('accessories', 'Desk Accessories', 1, 5);

-- Seed customers (includes Chinese, emoji, NULLs, JSONB, arrays)
INSERT INTO customers (email, full_name, tier, country_code, city, phone, is_active, lifetime_value, preferences, tags, notes) VALUES
  ('qi.chen@netcatty.dev', '陈琪 (Qi Chen) 🚀', 'enterprise', 'CN', '上海静安区', '+86-138-0013-8000', TRUE, 12890.50, '{"theme":"dark","locale":"zh-CN","notifications":{"email":true,"slack":true}}', ARRAY['vip','beta','founder'], '核心企业客户，偏好深色主题 🔥'),
  ('alice.morgan@acme.io', 'Alice Morgan', 'pro', 'US', 'San Francisco', '+1-415-555-0142', TRUE, 4320.00, '{"theme":"light","locale":"en-US","currency":"USD"}', ARRAY['pro','early-adopter'], NULL),
  ('kenji.sato@tokyo-ops.jp', '佐藤健司 (Kenji Sato)', 'enterprise', 'JP', 'Tokyo', '+81-3-5555-0199', TRUE, 9875.25, '{"theme":"dark","locale":"ja-JP","digest":"weekly"}', ARRAY['vip','apac'], 'Requires invoice PDF in JPY'),
  ('lin.wei@cloudcraft.cn', '林伟', 'pro', 'CN', '深圳南山区', NULL, TRUE, 2150.00, '{"theme":"system","locale":"zh-CN"}', ARRAY['dev','china'], '机械键盘发烧友 ⭐'),
  ('elena.rossi@milano.it', 'Elena Rossi', 'standard', 'IT', 'Milan', '+39-02-5550192', TRUE, 640.80, '{"theme":"light","locale":"it-IT"}', ARRAY['eu'], NULL),
  ('marcus.vance@nordic.se', 'Marcus Vance', 'free', 'SE', 'Stockholm', NULL, FALSE, 0.00, '{"theme":"dark","marketing":false}', ARRAY[]::TEXT[], 'Churned trial account'),
  ('sophie.laurent@paris.fr', 'Sophie Laurent ✨', 'pro', 'FR', 'Paris', '+33-1-42-68-53-00', TRUE, 3499.99, '{"theme":"light","locale":"fr-FR","beta":true}', ARRAY['eu','design'], 'Design systems lead'),
  ('david.kim@seoultech.kr', '김다윗 (David Kim)', 'standard', 'KR', 'Seoul', '+82-2-555-0188', TRUE, 1120.40, '{"theme":"dark","locale":"ko-KR"}', ARRAY['apac'], NULL);

-- Seed products
INSERT INTO products (sku, category_id, name, description, price, cost, stock_qty, is_published, specs, checksum) VALUES
  ('KB-NC-75', 2, 'Netcatty Tactile 75% 机械键盘 ⌨️', 'CNC 铝合金机身，热插拔静音段落轴，支持 QMK/VIA', 189.00, 92.50, 140, TRUE, '{"switches":"Tactile 55g","layout":"75%","wireless":["Bluetooth 5.3","2.4GHz"],"weight_g":1420}', decode('deadbeef01020304', 'hex')),
  ('KB-LP-65', 2, 'AirSlim 65 Low-Profile Keyboard', 'Ultra-thin anodized aluminum travel keyboard', 149.00, 71.00, 85, TRUE, '{"switches":"Low-Profile Brown","layout":"65%","weight_g":620}', decode('cafebabe11223344', 'hex')),
  ('MON-4K-27', 3, 'StudioPro 27" 4K HiDPI Monitor', 'IPS Black 2000:1 contrast, 98% DCI-P3, USB-C 96W PD', 699.00, 410.00, 32, TRUE, '{"resolution":"3840x2160","refresh_hz":120,"ports":["USB-C","DP 1.4","HDMI 2.1"]}', NULL),
  ('SAAS-PRO-YR', 4, 'Netcatty Cloud Sync Pro (Annual) 🚀', 'End-to-end encrypted vault & database sync across unlimited devices', 96.00, 8.00, 999999, TRUE, '{"billing":"annual","seats":1,"encryption":"AES-256-GCM"}', NULL),
  ('SAAS-ENT-YR', 4, 'Netcatty Enterprise Team Suite (10 Seats)', 'SSO/SAML, audit logs, bastion policies, priority support', 1490.00, 120.00, 999999, TRUE, '{"billing":"annual","seats":10,"sla":"99.95%"}', NULL),
  ('ACC-HUB-TB4', 5, 'ThunderDock 4 Pro Hub', '12-in-1 Thunderbolt 4 aluminum desktop dock', 249.00, 118.00, 54, TRUE, '{"bandwidth_gbps":40,"ethernet":"2.5GbE"}', decode('0011223344556677', 'hex')),
  ('ACC-MAT-XL', 5, 'Wool Felt Desk Mat XL — 炭黑灰', 'Merino wool desk mat with anti-slip cork base', 45.00, 14.20, 210, TRUE, '{"size_mm":"900x400","material":"Merino Wool"}', NULL),
  ('KB-PROTO-01', 2, 'Unreleased Split Ergo Prototype', NULL, 299.00, NULL, 0, FALSE, '{"stage":"prototype"}', NULL);

-- Seed orders
INSERT INTO orders (order_no, customer_id, status, currency, subtotal, discount, tax, total_amount, shipping_address, memo, placed_at) VALUES
  ('ORD-2026-0001', 1, 'delivered', 'USD', 1679.00, 100.00, 0.00, 1579.00, '{"city":"上海","district":"静安区","postal":"200040","country":"CN"}', '请工作日送达 🎉', NOW() - INTERVAL '25 days'),
  ('ORD-2026-0002', 2, 'delivered', 'USD', 948.00, 0.00, 80.58, 1028.58, '{"city":"San Francisco","state":"CA","postal":"94107","country":"US"}', NULL, NOW() - INTERVAL '18 days'),
  ('ORD-2026-0003', 3, 'shipped', 'USD', 1739.00, 150.00, 0.00, 1589.00, '{"city":"Tokyo","ward":"Shibuya","postal":"150-0002","country":"JP"}', 'Express courier requested', NOW() - INTERVAL '9 days'),
  ('ORD-2026-0004', 4, 'paid', 'USD', 234.00, 10.00, 0.00, 224.00, '{"city":"深圳","district":"南山区","postal":"518057","country":"CN"}', '附带试轴器 🙏', NOW() - INTERVAL '4 days'),
  ('ORD-2026-0005', 5, 'pending', 'EUR', 194.00, 0.00, 42.68, 236.68, '{"city":"Milan","postal":"20121","country":"IT"}', NULL, NOW() - INTERVAL '2 days'),
  ('ORD-2026-0006', 7, 'delivered', 'EUR', 948.00, 50.00, 179.60, 1077.60, '{"city":"Paris","postal":"75008","country":"FR"}', 'Gift wrap requested ✨', NOW() - INTERVAL '12 days'),
  ('ORD-2026-0007', 8, 'cancelled', 'USD', 149.00, 0.00, 0.00, 149.00, '{"city":"Seoul","postal":"06035","country":"KR"}', 'Customer changed switch preference', NOW() - INTERVAL '7 days'),
  ('ORD-2026-0008', 1, 'paid', 'USD', 744.00, 0.00, 0.00, 744.00, '{"city":"上海","district":"静安区","postal":"200040","country":"CN"}', 'Studio setup upgrade 🔥', NOW() - INTERVAL '1 day');

-- Seed order_items
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 5, 1, 1490.00),
  (1, 1, 1, 189.00),
  (2, 3, 1, 699.00),
  (2, 6, 1, 249.00),
  (3, 5, 1, 1490.00),
  (3, 6, 1, 249.00),
  (4, 1, 1, 189.00),
  (4, 7, 1, 45.00),
  (5, 2, 1, 149.00),
  (5, 7, 1, 45.00),
  (6, 3, 1, 699.00),
  (6, 6, 1, 249.00),
  (7, 2, 1, 149.00),
  (8, 3, 1, 699.00),
  (8, 7, 1, 45.00);

-- Seed reviews
INSERT INTO reviews (product_id, customer_id, rating, title, body, verified_purchase) VALUES
  (1, 1, 5, '手感极佳的静音段落轴！🔥', '铝坨坨质感拉满，蓝牙切三台设备零延迟，写 SQL 很舒服。', TRUE),
  (1, 4, 5, 'Best 75% board I own ⭐', 'Zero ping out of the box and VIA worked immediately.', TRUE),
  (3, 2, 4, 'Crisp 4K text on macOS', 'Colors and HiDPI scaling are great; stand could tilt slightly lower.', TRUE),
  (5, 3, 5, 'Seamless team rollout 🚀', 'Bastion SSH + vault sync saved our SRE team hours every week.', TRUE),
  (6, 7, 4, 'Solid Thunderbolt 4 hub', 'Runs cool under dual 4K display load.', TRUE),
  (7, 5, 5, 'Warm desk aesthetic', NULL, FALSE);

-- Seed audit_events
INSERT INTO analytics.audit_events (entity_type, entity_id, action, payload) VALUES
  ('order', 1, 'created', '{"order_no":"ORD-2026-0001","total":1579.00}'),
  ('order', 1, 'status_changed', '{"from":"paid","to":"delivered"}'),
  ('customer', 1, 'tier_upgraded', '{"from":"pro","to":"enterprise"}');
