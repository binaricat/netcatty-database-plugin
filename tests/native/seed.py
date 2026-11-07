#!/usr/bin/env python3
"""Only owns t303-commerce*.sqlite in the existing host fixture allowlist."""
import argparse, json, sqlite3, signal, time, fcntl
from pathlib import Path
ROOT = Path('/workspace/agent-tools/database/m3b-multitable/fixtures')
p = argparse.ArgumentParser(); p.add_argument('--reset', action='store_true'); p.add_argument('--wal', action='store_true'); args = p.parse_args()
ROOT.mkdir(parents=True, exist_ok=True)
file = ROOT / ('t303-commerce-wal.sqlite' if args.wal else 't303-commerce.sqlite')
lock = open(str(file) + '.t303-lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
if args.reset:
    for suffix in ('', '-wal', '-shm', '-journal'):
        target = Path(str(file) + suffix)
        if target.is_symlink(): raise RuntimeError('Refusing symlink fixture')
        target.unlink(missing_ok=True)
if file.is_symlink(): raise RuntimeError('Refusing symlink fixture')
db = sqlite3.connect(file)
if args.wal: db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
if not db.execute("SELECT name FROM sqlite_master WHERE name='customers'").fetchone():
    db.executescript('''CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, city TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER, status TEXT);
CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, description TEXT);
CREATE TABLE "订单备注_用于验证很长中文对象名称与侧栏省略展示"(id INTEGER PRIMARY KEY, note TEXT);
CREATE VIEW order_totals AS SELECT orders.id order_id, customers.name customer, total_cents, status FROM orders JOIN customers ON customers.id=orders.customer_id;
''')
    db.executemany('INSERT INTO customers VALUES(?,?,?,?)', [(1,'林小满','xiaoman@example.invalid','杭州'),(2,'Alex Morgan',None,'London'),(3,'Empty field','','')])
    db.executemany('INSERT INTO orders VALUES(?,?,?,?)',[(1,1,7400,'paid'),(2,2,3600,'paid'),(3,1,500,'pending')])
    db.executemany('INSERT INTO products VALUES(?,?,?)',[(i, '合成商品 %03d'%i, None if i%3==0 else '' if i%3==1 else '长文本 / Synthetic long description. '*30) for i in range(1,151)])
    db.commit()
if args.wal:
    db.execute('INSERT OR REPLACE INTO "订单备注_用于验证很长中文对象名称与侧栏省略展示" VALUES(1,?)', ('Synthetic stable WAL fixture',))
    db.commit()
    assert Path(str(file) + '-wal').stat().st_size > 32
print(json.dumps({'path':str(file),'synthetic':True,'wal':args.wal}),flush=True)
if args.wal:
    # Keep an idle connection alive: committed WAL, no active writer during reads.
    signal.signal(signal.SIGTERM, lambda *_: exit(0))
    try:
        while True: time.sleep(1)
    finally: db.close()
else: db.close()
