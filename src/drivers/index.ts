/**
 * Unified Multi-Database Driver Factory & Barrel Exports.
 * Production UI should prefer `createDriverAsync` from `./lazyFactory` so heavy
 * wire-protocol drivers and `bson` stay code-split out of initial `browser.js`.
 */

export * from './types';
export * from './streamBuffer';
export * from './crypto';
export * from './httpClient';
export * from './sqlDialect';
export * from './postgresDriver';
export * from './mysqlDriver';
export * from './sqliteDriver';
export * from './clickhouseDriver';
export * from './mssqlDriver';
export * from './httpSqlDriver';
export * from './redisDriver';
export * from './mongoDriver';
export * from './neo4jDriver';
export * from './searchVectorDriver';
export * from './kvHttpDriver';
export * from './cassandraDriver';
export * from './mqHttpDriver';
export * from './mqttDriver';
export * from './kafkaDriver';
export * from './zookeeperDriver';
export { createDriverAsync, type AnyDatabaseDriver } from './lazyFactory';

import { CassandraDriver } from './cassandraDriver';
import { ClickHouseDriver } from './clickhouseDriver';
import { HttpSqlDriver } from './httpSqlDriver';
import { KafkaDriver } from './kafkaDriver';
import { KvHttpDriver } from './kvHttpDriver';
import { PureMongoDriver } from './mongoDriver';
import { MqHttpDriver } from './mqHttpDriver';
import { MqttDriver } from './mqttDriver';
import { MssqlDriver } from './mssqlDriver';
import { MysqlDriver } from './mysqlDriver';
import { Neo4jDriver } from './neo4jDriver';
import { PostgresDriver } from './postgresDriver';
import { PureRedisDriver } from './redisDriver';
import { SearchVectorDriver } from './searchVectorDriver';
import { SqliteDriver } from './sqliteDriver';
import { ZookeeperDriver } from './zookeeperDriver';
import type { AnyDatabaseDriver } from './lazyFactory';
import {
  resolveEngineFamily,
  type DatabaseEngineId,
  type GraphDriver,
  type KvDriver,
  type MongoDriver,
  type MqDriver,
  type RedisDriver,
  type RelationalDriver,
  type SearchDriver,
} from './types';

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
    case 'mssql':
      return new MssqlDriver();
    case 'http_sql':
      return new HttpSqlDriver(engine);
    case 'cql':
      return new CassandraDriver(engine);
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

export function createGraphDriver(): GraphDriver {
  return new Neo4jDriver();
}

export function createSearchDriver(engine: DatabaseEngineId): SearchDriver {
  return new SearchVectorDriver(engine);
}

export function createKvDriver(engine: DatabaseEngineId): KvDriver {
  return engine === 'zookeeper' ? new ZookeeperDriver() : new KvHttpDriver(engine);
}

export function createMqDriver(engine: DatabaseEngineId): MqDriver {
  if (engine === 'mqtt') return new MqttDriver();
  if (engine === 'kafka') return new KafkaDriver();
  return new MqHttpDriver(engine === 'mq' ? 'pulsar' : engine);
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
    case 'mssql':
      return new MssqlDriver();
    case 'http_sql':
      return new HttpSqlDriver(engine);
    case 'cql':
      return new CassandraDriver(engine);
    case 'redis':
      return new PureRedisDriver();
    case 'mongodb':
      return new PureMongoDriver();
    case 'graph':
      return new Neo4jDriver();
    case 'search':
      return new SearchVectorDriver(engine);
    case 'kv':
      return engine === 'zookeeper' ? new ZookeeperDriver() : new KvHttpDriver(engine);
    case 'mq':
      return createMqDriver(engine);
  }
}
