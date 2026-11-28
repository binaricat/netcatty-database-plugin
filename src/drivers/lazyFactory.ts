/**
 * Lazy Code-Split Driver Factory.
 * Every database driver family is dynamically imported on first connect so initial
 * `browser.js` loads zero wire-protocol code and zero `bson` (75 KB) or `sql-asm` (1.2 MB).
 */

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

export type AnyDatabaseDriver =
  | RelationalDriver
  | RedisDriver
  | MongoDriver
  | GraphDriver
  | SearchDriver
  | KvDriver
  | MqDriver;

export async function createDriverAsync(engine: DatabaseEngineId): Promise<AnyDatabaseDriver> {
  const family = resolveEngineFamily(engine);
  switch (family) {
    case 'postgres': {
      const { PostgresDriver } = await import('./postgresDriver');
      return new PostgresDriver(engine);
    }
    case 'mysql': {
      const { MysqlDriver } = await import('./mysqlDriver');
      return new MysqlDriver(engine);
    }
    case 'sqlite': {
      const { SqliteDriver } = await import('./sqliteDriver');
      return new SqliteDriver();
    }
    case 'clickhouse': {
      const { ClickHouseDriver } = await import('./clickhouseDriver');
      return new ClickHouseDriver();
    }
    case 'mssql': {
      const { MssqlDriver } = await import('./mssqlDriver');
      return new MssqlDriver();
    }
    case 'http_sql': {
      const { HttpSqlDriver } = await import('./httpSqlDriver');
      return new HttpSqlDriver(engine);
    }
    case 'cql': {
      const { CassandraDriver } = await import('./cassandraDriver');
      return new CassandraDriver(engine);
    }
    case 'redis': {
      const { PureRedisDriver } = await import('./redisDriver');
      return new PureRedisDriver();
    }
    case 'mongodb': {
      const { PureMongoDriver } = await import('./mongoDriver');
      return new PureMongoDriver();
    }
    case 'graph': {
      const { Neo4jDriver } = await import('./neo4jDriver');
      return new Neo4jDriver();
    }
    case 'search': {
      const { SearchVectorDriver } = await import('./searchVectorDriver');
      return new SearchVectorDriver(engine);
    }
    case 'kv': {
      if (engine === 'zookeeper') {
        const { ZookeeperDriver } = await import('./zookeeperDriver');
        return new ZookeeperDriver();
      }
      const { KvHttpDriver } = await import('./kvHttpDriver');
      return new KvHttpDriver(engine);
    }
    case 'mq': {
      if (engine === 'mqtt') {
        const { MqttDriver } = await import('./mqttDriver');
        return new MqttDriver();
      }
      if (engine === 'kafka') {
        const { KafkaDriver } = await import('./kafkaDriver');
        return new KafkaDriver();
      }
      const { MqHttpDriver } = await import('./mqHttpDriver');
      return new MqHttpDriver(engine === 'mq' ? 'pulsar' : engine);
    }
  }
}
