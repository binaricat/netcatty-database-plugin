-- MariaDB 11 rich SaaS / e-commerce demo seed for Netcatty Database tests

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

INSERT INTO categories (slug, name, parent_id, sort_order) VALUES
  ('hardware', 'Hardware & Peripherals', NULL, 1),
  ('keyboards', 'Mechanical Keyboards ⌨️', 1, 2),
  ('cloud-saas', 'Cloud & DevTools SaaS ☁️', NULL, 3);

INSERT INTO customers (email, full_name, tier, country_code, city, phone, is_active, lifetime_value, preferences, notes) VALUES
  ('qi.chen@netcatty.dev', '陈琪 (Qi Chen) 🚀', 'enterprise', 'CN', '上海静安区', '+86-138-0013-8000', 1, 12890.50, '{"theme":"dark","locale":"zh-CN"}', 'MariaDB 测试客户 🔥'),
  ('alice.morgan@acme.io', 'Alice Morgan', 'pro', 'US', 'San Francisco', '+1-415-555-0142', 1, 4320.00, '{"theme":"light","locale":"en-US"}', NULL),
  ('lin.wei@cloudcraft.cn', '林伟', 'pro', 'CN', '深圳南山区', NULL, 1, 2150.00, '{"theme":"system","locale":"zh-CN"}', '机械键盘发烧友 ⭐');

INSERT INTO products (sku, category_id, name, description, price, cost, stock_qty, is_published, specs, checksum) VALUES
  ('KB-NC-75', 2, 'Netcatty Tactile 75% 机械键盘 ⌨️', 'CNC 铝合金机身，热插拔静音段落轴', 189.00, 92.50, 140, 1, '{"switches":"Tactile 55g","layout":"75%"}', UNHEX('DEADBEEF01020304')),
  ('SAAS-PRO-YR', 3, 'Netcatty Cloud Sync Pro 🚀', 'End-to-end encrypted vault sync', 96.00, 8.00, 999999, 1, '{"billing":"annual","seats":1}', NULL);

INSERT INTO orders (order_no, customer_id, status, currency, subtotal, discount, tax, total_amount, shipping_address, memo) VALUES
  ('MDB-2026-0001', 1, 'delivered', 'USD', 285.00, 10.00, 0.00, 275.00, '{"city":"上海","country":"CN"}', 'MariaDB 11 联调订单 🎉'),
  ('MDB-2026-0002', 2, 'paid', 'USD', 96.00, 0.00, 7.68, 103.68, '{"city":"San Francisco","country":"US"}', NULL);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 189.00),
  (1, 2, 1, 96.00),
  (2, 2, 1, 96.00);

INSERT INTO reviews (product_id, customer_id, rating, title, body, verified_purchase) VALUES
  (1, 1, 5, '手感很棒 🔥', 'MariaDB 中文与 Emoji 写入测试通过。', 1);
