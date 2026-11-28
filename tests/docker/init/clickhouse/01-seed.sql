-- ClickHouse 24 analytics demo seed for Netcatty Database tests

CREATE DATABASE IF NOT EXISTS analytics_demo;

CREATE TABLE IF NOT EXISTS analytics_demo.page_views
(
  event_id UInt64,
  session_id String,
  user_id Nullable(UInt64),
  path String,
  referrer Nullable(String),
  country LowCardinality(String),
  device LowCardinality(String),
  duration_ms UInt32,
  meta String,
  occurred_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (country, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS analytics_demo.order_events
(
  event_id UInt64,
  order_no String,
  customer_id UInt64,
  customer_name String,
  event_type LowCardinality(String),
  currency FixedString(3),
  amount Decimal(14, 2),
  region LowCardinality(String),
  note Nullable(String),
  created_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (event_type, created_at, event_id);

INSERT INTO analytics_demo.page_views VALUES
  (1001, 'sess_01', 1, '/workbench/postgres', 'https://netcatty.dev', 'CN', 'desktop', 4280, '{"theme":"dark","locale":"zh-CN"}', '2026-11-20 08:15:10.120'),
  (1002, 'sess_01', 1, '/workbench/er-diagram', '/workbench/postgres', 'CN', 'desktop', 9150, '{"tables":7}', '2026-11-20 08:16:05.450'),
  (1003, 'sess_02', 2, '/pricing', 'https://google.com', 'US', 'desktop', 2310, '{"campaign":"launch"}', '2026-11-21 15:40:00.000'),
  (1004, 'sess_03', NULL, '/docs/ssh-tunnel', NULL, 'JP', 'mobile', 1840, '{"anon":true}', '2026-11-22 03:12:44.890'),
  (1005, 'sess_04', 4, '/store/kb-nc-75', 'https://github.com', 'CN', 'desktop', 6520, '{"tag":"机械键盘 🔥"}', '2026-11-23 11:22:33.000'),
  (1006, 'sess_05', 3, '/workbench/clickhouse', '/workbench/redis', 'JP', 'desktop', 5400, '{"queries":12}', '2026-11-24 06:05:19.250'),
  (1007, 'sess_06', 7, '/workbench/mongodb', NULL, 'FR', 'desktop', 3790, '{"view":"json-tree ✨"}', '2026-11-25 14:55:02.600'),
  (1008, 'sess_07', 1, '/settings/sync', '/workbench/postgres', 'CN', 'desktop', 1290, '{"status":"ok 🚀"}', '2026-11-26 01:02:11.010');

INSERT INTO analytics_demo.order_events VALUES
  (5001, 'ORD-2026-0001', 1, '陈琪 (Qi Chen) 🚀', 'created', 'USD', 1579.00, 'APAC', '企业年付订单', '2026-11-01 10:20:00.000'),
  (5002, 'ORD-2026-0001', 1, '陈琪 (Qi Chen) 🚀', 'paid', 'USD', 1579.00, 'APAC', 'Stripe 成功扣款 🎉', '2026-11-01 10:20:45.120'),
  (5003, 'ORD-2026-0002', 2, 'Alice Morgan', 'paid', 'USD', 1028.58, 'NA', NULL, '2026-11-08 19:05:12.000'),
  (5004, 'ORD-2026-0003', 3, '佐藤健司 (Kenji Sato)', 'shipped', 'USD', 1589.00, 'APAC', 'DHL Express 📦', '2026-11-18 09:00:00.000'),
  (5005, 'ORD-2026-0004', 4, '林伟', 'paid', 'USD', 224.00, 'APAC', '附带试轴器 ⭐', '2026-11-22 13:10:05.500'),
  (5006, 'ORD-2026-0005', 5, 'Elena Rossi', 'created', 'EUR', 236.68, 'EU', NULL, '2026-11-24 16:40:00.000'),
  (5007, 'ORD-2026-0008', 1, '陈琪 (Qi Chen) 🚀', 'paid', 'USD', 744.00, 'APAC', 'Studio setup 🔥', '2026-11-25 18:15:30.000');
