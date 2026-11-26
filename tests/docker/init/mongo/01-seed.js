// MongoDB 7 rich SaaS / e-commerce demo seed for Netcatty Database tests

const shopDb = db.getSiblingDB('shop_demo');

// Also create netcatty user inside shop_demo so both authSource=admin and authSource=shop_demo work
shopDb.createUser({
  user: 'netcatty',
  pwd: 'netcatty_mongo_pass',
  roles: [
    { role: 'readWrite', db: 'shop_demo' },
    { role: 'dbAdmin', db: 'shop_demo' }
  ]
});

const u1 = ObjectId();
const u2 = ObjectId();
const u3 = ObjectId();
const u4 = ObjectId();

shopDb.users.insertMany([
  {
    _id: u1,
    email: 'qi.chen@netcatty.dev',
    fullName: '陈琪 (Qi Chen) 🚀',
    tier: 'enterprise',
    active: true,
    address: { country: 'CN', city: '上海静安区', postalCode: '200040' },
    tags: ['vip', 'founder', 'beta'],
    preferences: { theme: 'dark', locale: 'zh-CN', notifications: { email: true, push: true } },
    lifetimeValue: NumberDecimal('12890.50'),
    createdAt: new Date('2026-01-15T08:30:00Z')
  },
  {
    _id: u2,
    email: 'alice.morgan@acme.io',
    fullName: 'Alice Morgan',
    tier: 'pro',
    active: true,
    address: { country: 'US', city: 'San Francisco', state: 'CA', postalCode: '94107' },
    tags: ['pro', 'early-adopter'],
    preferences: { theme: 'light', locale: 'en-US' },
    lifetimeValue: NumberDecimal('4320.00'),
    notes: null,
    createdAt: new Date('2026-03-22T14:15:00Z')
  },
  {
    _id: u3,
    email: 'kenji.sato@tokyo-ops.jp',
    fullName: '佐藤健司 (Kenji Sato)',
    tier: 'enterprise',
    active: true,
    address: { country: 'JP', city: 'Tokyo', ward: 'Shibuya' },
    tags: ['vip', 'apac'],
    preferences: { theme: 'dark', locale: 'ja-JP' },
    lifetimeValue: NumberDecimal('9875.25'),
    createdAt: new Date('2026-04-10T02:00:00Z')
  },
  {
    _id: u4,
    email: 'lin.wei@cloudcraft.cn',
    fullName: '林伟 ⭐',
    tier: 'pro',
    active: true,
    address: { country: 'CN', city: '深圳南山区' },
    tags: ['dev', 'keyboards'],
    preferences: { theme: 'system', locale: 'zh-CN' },
    lifetimeValue: NumberDecimal('2150.00'),
    createdAt: new Date('2026-06-01T11:45:00Z')
  }
]);
shopDb.users.createIndex({ email: 1 }, { unique: true });
shopDb.users.createIndex({ tier: 1, 'address.country': 1 });

const p1 = ObjectId();
const p2 = ObjectId();
const p3 = ObjectId();
const p4 = ObjectId();

shopDb.products.insertMany([
  {
    _id: p1,
    sku: 'KB-NC-75',
    name: 'Netcatty Tactile 75% 机械键盘 ⌨️',
    category: 'keyboards',
    price: 189.0,
    stock: 140,
    published: true,
    specs: { switches: 'Tactile 55g', wireless: ['BT 5.3', '2.4GHz'], weightGrams: 1420 },
    ratings: { avg: 4.95, count: 84 },
    updatedAt: new Date('2026-11-10T09:00:00Z')
  },
  {
    _id: p2,
    sku: 'MON-4K-27',
    name: 'StudioPro 27" 4K HiDPI Monitor',
    category: 'monitors',
    price: 699.0,
    stock: 32,
    published: true,
    specs: { resolution: '3840x2160', refreshHz: 120, ports: ['USB-C 96W', 'DP 1.4', 'HDMI 2.1'] },
    ratings: { avg: 4.7, count: 41 },
    updatedAt: new Date('2026-11-12T16:20:00Z')
  },
  {
    _id: p3,
    sku: 'SAAS-ENT-YR',
    name: 'Netcatty Enterprise Team Suite (10 Seats) 🚀',
    category: 'cloud-saas',
    price: 1490.0,
    stock: 999999,
    published: true,
    specs: { billing: 'annual', seats: 10, sla: '99.95%' },
    ratings: { avg: 5.0, count: 19 },
    updatedAt: new Date('2026-11-18T00:00:00Z')
  },
  {
    _id: p4,
    sku: 'ACC-MAT-XL',
    name: 'Wool Felt Desk Mat XL — 炭黑灰',
    category: 'accessories',
    price: 45.0,
    stock: 210,
    published: true,
    specs: { sizeMm: '900x400', material: 'Merino Wool' },
    ratings: { avg: 4.85, count: 112 },
    updatedAt: new Date('2026-11-20T12:00:00Z')
  }
]);
shopDb.products.createIndex({ sku: 1 }, { unique: true });
shopDb.products.createIndex({ category: 1, price: -1 });

shopDb.orders.insertMany([
  {
    orderNo: 'ORD-2026-0001',
    userId: u1,
    status: 'delivered',
    currency: 'USD',
    items: [
      { productId: p3, sku: 'SAAS-ENT-YR', qty: 1, unitPrice: 1490.0 },
      { productId: p1, sku: 'KB-NC-75', qty: 1, unitPrice: 189.0 }
    ],
    totals: { subtotal: 1679.0, discount: 100.0, tax: 0.0, grandTotal: 1579.0 },
    memo: '请工作日送达 🎉',
    placedAt: new Date('2026-11-01T10:20:00Z')
  },
  {
    orderNo: 'ORD-2026-0002',
    userId: u2,
    status: 'delivered',
    currency: 'USD',
    items: [
      { productId: p2, sku: 'MON-4K-27', qty: 1, unitPrice: 699.0 }
    ],
    totals: { subtotal: 699.0, discount: 0.0, tax: 59.42, grandTotal: 758.42 },
    memo: null,
    placedAt: new Date('2026-11-08T19:05:00Z')
  },
  {
    orderNo: 'ORD-2026-0003',
    userId: u3,
    status: 'shipped',
    currency: 'USD',
    items: [
      { productId: p3, sku: 'SAAS-ENT-YR', qty: 1, unitPrice: 1490.0 }
    ],
    totals: { subtotal: 1490.0, discount: 150.0, tax: 0.0, grandTotal: 1340.0 },
    memo: 'Express courier requested',
    placedAt: new Date('2026-11-17T06:40:00Z')
  },
  {
    orderNo: 'ORD-2026-0004',
    userId: u4,
    status: 'paid',
    currency: 'USD',
    items: [
      { productId: p1, sku: 'KB-NC-75', qty: 1, unitPrice: 189.0 },
      { productId: p4, sku: 'ACC-MAT-XL', qty: 2, unitPrice: 45.0 }
    ],
    totals: { subtotal: 279.0, discount: 10.0, tax: 0.0, grandTotal: 269.0 },
    memo: '附带试轴器 🔥',
    placedAt: new Date('2026-11-22T13:10:00Z')
  }
]);
shopDb.orders.createIndex({ orderNo: 1 }, { unique: true });
shopDb.orders.createIndex({ userId: 1, placedAt: -1 });
shopDb.orders.createIndex({ status: 1 });

shopDb.audit_logs.insertMany([
  {
    actor: 'qi.chen@netcatty.dev',
    action: 'vault.sync.completed',
    severity: 'info',
    metadata: { itemsSynced: 48, latencyMs: 124, client: 'netcatty-desktop' },
    timestamp: new Date('2026-11-25T08:00:00Z')
  },
  {
    actor: 'system',
    action: 'order.status.changed',
    severity: 'info',
    metadata: { orderNo: 'ORD-2026-0003', from: 'paid', to: 'shipped' },
    timestamp: new Date('2026-11-25T10:30:00Z')
  },
  {
    actor: 'security-bot',
    action: 'ssh.bastion.connected',
    severity: 'notice',
    metadata: { target: 'postgres:5432', tls: true, note: '审计日志测试 🔐' },
    timestamp: new Date('2026-11-26T01:15:00Z')
  }
]);
shopDb.audit_logs.createIndex({ timestamp: -1 });
