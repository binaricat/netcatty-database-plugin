/**
 * Unified Multi-Database Driver Factory & Barrel Exports.
 */

export * from './types';
export * from './streamBuffer';
export * from './crypto';
export * from './sqlDialect';
export * from './postgresDriver';
export * from './mysqlDriver';
export * from './sqliteDriver';
export * from './clickhouseDriver';
export * from './redisDriver';
export * from './mongoDriver';

import { ClickHouseDriver } from './clickhouseDriver';
import { PureMongoDriver } from './mongoDriver';
import { MysqlDriver } from './mysqlDriver';
import { PostgresDriver } from './postgresDriver';
import { PureRedisDriver } from './redisDriver';
import { SqliteDriver } from './sqliteDriver';
import {
  resolveEngineFamily,
  type DatabaseEngineId,
  type MongoDriver,
  type RedisDriver,
  type RelationalDriver,
} from './types';

export type AnyDatabaseDriver = RelationalDriver | RedisDriver | MongoDriver;

export function createRelationalDriver(engine: DatabaseEngineId): RelationalDriver {
  const family = resolveEngineFamily(engine);
  switch (family) {
    case 'postgres':
      return new PostgresDriver(engine);
    case 'mysql':
      return new MysqlDriver(engine);
    case 'sqlite':
      return new SqliteDriver();
    case 'clickhouse':
      return new ClickHouseDriver();
    default:
      throw new Error(`Engine '${engine}' is not a relational SQL driver`);
  }
}

export function createRedisDriver(): RedisDriver {
  return new PureRedisDriver();
}

export function createMongoDriver(): MongoDriver {
  return new PureMongoDriver();
}

export function createDriver(engine: DatabaseEngineId): AnyDatabaseDriver {
  const family = resolveEngineFamily(engine);
  switch (family) {
    case 'postgres':
      return new PostgresDriver(engine);
    case 'mysql':
      return new MysqlDriver(engine);
    case 'sqlite':
      return new SqliteDriver();
    case 'clickhouse':
      return new ClickHouseDriver();
    case 'redis':
      return new PureRedisDriver();
    case 'mongodb':
      return new PureMongoDriver();
  }
}
