#!/bin/sh
set -eu

CLI="redis-cli -h redis -p 6379 -a netcatty_redis_pass --no-auth-warning"

echo "Seeding Redis DB 0..."
$CLI -n 0 SET "app:user:1001" '{"id":1001,"name":"陈琪 🚀","role":"enterprise","locale":"zh-CN"}' EX 86400
$CLI -n 0 SET "app:user:1002" '{"id":1002,"name":"Alice Morgan","role":"pro","locale":"en-US"}' EX 43200
$CLI -n 0 SET "app:config:theme" "obsidian-dark"
$CLI -n 0 SET "app:config:feature_flags" '{"ssh_tunnel":true,"er_diagram":true,"ai_sql":true}'
$CLI -n 0 SET "cache:session:s_9a8b7c" '{"user_id":1001,"ip":"10.0.0.14","ua":"Netcatty/2.0"}' EX 3600
$CLI -n 0 SET "cache:session:s_1d2e3f" '{"user_id":1002,"ip":"10.0.0.22","ua":"Netcatty/2.0"}' EX 1800
$CLI -n 0 SET "cache:session:s_4g5h6i" '{"user_id":1003,"ip":"10.0.0.35","ua":"Netcatty/2.0"}' EX 7200

$CLI -n 0 DEL "queue:orders"
$CLI -n 0 RPUSH "queue:orders" \
  '{"order_no":"ORD-2026-0001","status":"processing","amount":1579.00}' \
  '{"order_no":"ORD-2026-0004","status":"queued","amount":224.00}' \
  '{"order_no":"ORD-2026-0008","status":"priority 🔥","amount":744.00}'

$CLI -n 0 DEL "tags:featured"
$CLI -n 0 SADD "tags:featured" "mechanical-keyboard" "4k-monitor" "cloud-sync" "中文标签" "rocket-🚀"

$CLI -n 0 DEL "leaderboard:sales"
$CLI -n 0 ZADD "leaderboard:sales" 12890.50 "user:1001:陈琪" 9875.25 "user:1003:Kenji" 4320.00 "user:1002:Alice" 3499.99 "user:1007:Sophie" 2150.00 "user:1004:林伟"

$CLI -n 0 DEL "metrics:daily"
$CLI -n 0 HSET "metrics:daily" \
  "date" "2026-11-26" \
  "active_users" "1842" \
  "orders_paid" "127" \
  "revenue_usd" "48290.75" \
  "p95_latency_ms" "14.2" \
  "note" "黑五预热峰值 🎉"
$CLI -n 0 EXPIRE "metrics:daily" 604800

$CLI -n 0 DEL "events:orders"
$CLI -n 0 XADD "events:orders" "*" event "order_created" order_no "ORD-2026-0001" customer "陈琪" total "1579.00"
$CLI -n 0 XADD "events:orders" "*" event "payment_captured" order_no "ORD-2026-0001" provider "stripe" status "ok"
$CLI -n 0 XADD "events:orders" "*" event "shipment_dispatched" order_no "ORD-2026-0003" carrier "DHL" emoji "📦"

echo "Seeding Redis DB 1..."
$CLI -n 1 SET "app:user:2001" '{"id":2001,"name":"Staging Tester","env":"staging"}' EX 900
$CLI -n 1 SET "cache:rate_limit:api:10.0.0.1" "42" EX 300
$CLI -n 1 HSET "metrics:staging" "build" "alpha.35" "healthy" "true" "region" "ap-east-1"

echo "Redis seed complete!"
