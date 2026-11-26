-- MySQL 8.4 rich SaaS / e-commerce demo seed for Netcatty Database tests

GRANT PROCESS ON *.* TO 'netcatty'@'%';
GRANT ALL PRIVILEGES ON shop_demo.* TO 'netcatty'@'%';
FLUSH PRIVILEGES;

USE shop_demo;

CREATE TABLE customers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(160) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  tier ENUM('free', 'standard', 'pro', 'enterprise') NOT NULL DEFAULT 'standard',
  country_code CHAR(2) NOT NULL DEFAULT 'US',
  city VARCHAR(80) NULL,
  phone VARCHAR(40) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  lifetime_value DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  preferences JSON NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_customers_tier_country (tier, country_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  parent_id INT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(48) NOT NULL UNIQUE,
  category_id INT NOT NULL,
  name VARCHAR(180) NOT NULL,
  description TEXT NULL,
  price DECIMAL(12, 2) NOT NULL,
  cost DECIMAL(12, 2) NULL,
  stock_qty INT NOT NULL DEFAULT 0,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  specs JSON NOT NULL,
  checksum VARBINARY(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_products_cat_price (category_id, price DESC),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(40) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL,
  status ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded') NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal DECIMAL(14, 2) NOT NULL,
  discount DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  tax DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(14, 2) NOT NULL,
  shipping_address JSON NULL,
  memo TEXT NULL,
  placed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_customer_placed (customer_id, placed_at DESC),
  INDEX idx_orders_status_placed (status, placed_at DESC),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  line_total DECIMAL(14, 2) AS (quantity * unit_price) STORED,
  INDEX idx_order_items_order_prod (order_id, product_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reviews (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  rating TINYINT NOT NULL,
  title VARCHAR(160) NULL,
  body TEXT NULL,
  verified_purchase TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reviews_prod_cust (product_id, customer_id),
  INDEX idx_reviews_product_rating (product_id, rating DESC),
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(48) NOT NULL,
  entity_id BIGINT NOT NULL,
  action VARCHAR(48) NOT NULL,
  payload JSON NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER //
CREATE TRIGGER trg_orders_status_audit
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
  IF NEW.status <> OLD.status THEN
    INSERT INTO audit_events (entity_type, entity_id, action, payload)
    VALUES ('order', NEW.id, 'status_changed', JSON_OBJECT('from', OLD.status, 'to', NEW.status));
  END IF;
END //
DELIMITER ;

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
  ROUND(AVG(r.rating), 2) AS avg_rating
FROM products p
JOIN categories cat ON cat.id = p.category_id
LEFT JOIN order_items oi ON oi.product_id = p.id
LEFT JOIN reviews r ON r.product_id = p.id
GROUP BY p.id, p.sku, p.name, cat.name, p.price, p.stock_qty;

INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
  ('hardware', 'Hardware & Peripherals', NULL, 1),
  ('keyboards', 'Mechanical Keyboards ⌨️', 1, 2),
  ('monitors', '4K & Studio Monitors', 1, 3),
  ('cloud-saas', 'Cloud & DevTools SaaS ☁️', NULL, 4),
  ('accessories', 'Desk Accessories', 1, 5);

INSERT INTO customers (email, full_name, tier, country_code, city, phone, is_active, lifetime_value, preferences, notes) VALUES
  ('qi.chen@netcatty.dev', '陈琪 (Qi Chen) 🚀', 'enterprise', 'CN', '上海静安区', '+86-138-0013-8000', 1, 12890.50, JSON_OBJECT('theme', 'dark', 'locale', 'zh-CN', 'vip', true), '核心企业客户，偏好深色主题 🔥'),
  ('alice.morgan@acme.io', 'Alice Morgan', 'pro', 'US', 'San Francisco', '+1-415-555-0142', 1, 4320.00, JSON_OBJECT('theme', 'light', 'locale', 'en-US'), NULL),
  ('kenji.sato@tokyo-ops.jp', '佐藤健司 (Kenji Sato)', 'enterprise', 'JP', 'Tokyo', '+81-3-5555-0199', 1, 9875.25, JSON_OBJECT('theme', 'dark', 'locale', 'ja-JP'), 'Requires invoice PDF in JPY'),
  ('lin.wei@cloudcraft.cn', '林伟', 'pro', 'CN', '深圳南山区', NULL, 1, 2150.00, JSON_OBJECT('theme', 'system', 'locale', 'zh-CN'), '机械键盘发烧友 ⭐'),
  ('elena.rossi@milano.it', 'Elena Rossi', 'standard', 'IT', 'Milan', '+39-02-5550192', 1, 640.80, JSON_OBJECT('theme', 'light', 'locale', 'it-IT'), NULL),
  ('marcus.vance@nordic.se', 'Marcus Vance', 'free', 'SE', 'Stockholm', NULL, 0, 0.00, JSON_OBJECT('theme', 'dark', 'marketing', false), 'Churned trial account');

INSERT INTO products (sku, category_id, name, description, price, cost, stock_qty, is_published, specs, checksum) VALUES
  ('KB-NC-75', 2, 'Netcatty Tactile 75% 机械键盘 ⌨️', 'CNC 铝合金机身，热插拔静音段落轴，支持 QMK/VIA', 189.00, 92.50, 140, 1, JSON_OBJECT('switches', 'Tactile 55g', 'layout', '75%', 'weight_g', 1420), UNHEX('DEADBEEF01020304')),
  ('KB-LP-65', 2, 'AirSlim 65 Low-Profile Keyboard', 'Ultra-thin anodized aluminum travel keyboard', 149.00, 71.00, 85, 1, JSON_OBJECT('switches', 'Low-Profile Brown', 'layout', '65%', 'weight_g', 620), UNHEX('CAFEBABE11223344')),
  ('MON-4K-27', 3, 'StudioPro 27" 4K HiDPI Monitor', 'IPS Black 2000:1 contrast, 98% DCI-P3, USB-C 96W PD', 699.00, 410.00, 32, 1, JSON_OBJECT('resolution', '3840x2160', 'refresh_hz', 120), NULL),
  ('SAAS-PRO-YR', 4, 'Netcatty Cloud Sync Pro (Annual) 🚀', 'End-to-end encrypted vault & database sync', 96.00, 8.00, 999999, 1, JSON_OBJECT('billing', 'annual', 'seats', 1), NULL),
  ('SAAS-ENT-YR', 4, 'Netcatty Enterprise Team Suite (10 Seats)', 'SSO/SAML, audit logs, bastion policies', 1490.00, 120.00, 999999, 1, JSON_OBJECT('billing', 'annual', 'seats', 10), NULL),
  ('ACC-HUB-TB4', 5, 'ThunderDock 4 Pro Hub', '12-in-1 Thunderbolt 4 aluminum desktop dock', 249.00, 118.00, 54, 1, JSON_OBJECT('bandwidth_gbps', 40, 'ethernet', '2.5GbE'), UNHEX('0011223344556677')),
  ('ACC-MAT-XL', 5, 'Wool Felt Desk Mat XL — 炭黑灰', 'Merino wool desk mat with anti-slip cork base', 45.00, 14.20, 210, 1, JSON_OBJECT('size_mm', '900x400', 'material', 'Merino Wool'), NULL);

INSERT INTO orders (order_no, customer_id, status, currency, subtotal, discount, tax, total_amount, shipping_address, memo, placed_at) VALUES
  ('ORD-2026-0001', 1, 'delivered', 'USD', 1679.00, 100.00, 0.00, 1579.00, JSON_OBJECT('city', '上海', 'district', '静安区', 'country', 'CN'), '请工作日送达 🎉', NOW() - INTERVAL 25 DAY),
  ('ORD-2026-0002', 2, 'delivered', 'USD', 948.00, 0.00, 80.58, 1028.58, JSON_OBJECT('city', 'San Francisco', 'state', 'CA', 'country', 'US'), NULL, NOW() - INTERVAL 18 DAY),
  ('ORD-2026-0003', 3, 'shipped', 'USD', 1739.00, 150.00, 0.00, 1589.00, JSON_OBJECT('city', 'Tokyo', 'ward', 'Shibuya', 'country', 'JP'), 'Express courier requested', NOW() - INTERVAL 9 DAY),
  ('ORD-2026-0004', 4, 'paid', 'USD', 234.00, 10.00, 0.00, 224.00, JSON_OBJECT('city', '深圳', 'district', '南山区', 'country', 'CN'), '附带试轴器 🙏', NOW() - INTERVAL 4 DAY),
  ('ORD-2026-0005', 5, 'pending', 'EUR', 194.00, 0.00, 42.68, 236.68, JSON_OBJECT('city', 'Milan', 'country', 'IT'), NULL, NOW() - INTERVAL 2 DAY);

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
  (5, 7, 1, 45.00);

INSERT INTO reviews (product_id, customer_id, rating, title, body, verified_purchase) VALUES
  (1, 1, 5, '手感极佳的静音段落轴！🔥', '铝坨坨质感拉满，蓝牙切三台设备零延迟，写 SQL 很舒服。', 1),
  (1, 4, 5, 'Best 75% board I own ⭐', 'Zero ping out of the box and VIA worked immediately.', 1),
  (3, 2, 4, 'Crisp 4K text on macOS', 'Colors and HiDPI scaling are great.', 1),
  (5, 3, 5, 'Seamless team rollout 🚀', 'Bastion SSH + vault sync saved our SRE team hours.', 1);

INSERT INTO audit_events (entity_type, entity_id, action, payload) VALUES
  ('order', 1, 'created', JSON_OBJECT('order_no', 'ORD-2026-0001', 'total', 1579.00)),
  ('customer', 1, 'tier_upgraded', JSON_OBJECT('from', 'pro', 'to', 'enterprise'));
