// Plugin-owned catalog carried forward from the experimental snapshot.
// A catalog entry does not imply that a driver is available on Netcatty main.
import type { DatabaseDriverProfile } from './databaseTypes';
export type DriverProfile = DatabaseDriverProfile;
export const drivers = [
  {
    "id": "sqlite",
    "label": "SQLite",
    "category": "lightweight",
    "wireFamily": "sqlite",
    "defaultPort": 0,
    "fields": [
      "source"
    ],
    "icon": "sqlite",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "fixture"
  },
  {
    "id": "postgres",
    "label": "PostgreSQL",
    "category": "relational",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "postgresql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "mysql",
    "label": "MySQL",
    "category": "relational",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "mariadb",
    "label": "MariaDB",
    "category": "relational",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "mariadb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "goldendb",
    "label": "GoldenDB",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "goldendb",
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/goldendb.yaml; crates/ndb-sql-dialect/src/sql_dialect/descriptor.rs; MySQL wire-compatible transport profile",
    "qualification": "alias",
    "variants": [
      {
        "id": "goldendb-mysql",
        "label": "GoldenDB / MySQL endpoint",
        "defaultPort": 3306,
        "wireFamily": "mysql",
        "authPolicy": "mysql",
        "metadata": "mysql",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "opengauss",
    "label": "openGauss",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "opengauss",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias",
    "variants": [
      {
        "id": "opengauss-pg",
        "label": "openGauss / PG-compatible endpoint",
        "defaultPort": 5432,
        "wireFamily": "postgres",
        "authPolicy": "gauss-legacy",
        "metadata": "pg",
        "modeCheck": "pg-compatibility"
      }
    ]
  },
  {
    "id": "gaussdb",
    "label": "GaussDB",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "gaussdb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias",
    "variants": [
      {
        "id": "gaussdb-dws",
        "label": "GaussDB DWS",
        "defaultPort": 8000,
        "wireFamily": "postgres",
        "authPolicy": "gauss-legacy",
        "metadata": "pg",
        "modeCheck": "none"
      },
      {
        "id": "gaussdb-mysql",
        "label": "GaussDB for MySQL",
        "defaultPort": 3306,
        "wireFamily": "mysql",
        "authPolicy": "mysql",
        "metadata": "mysql",
        "modeCheck": "none"
      },
      {
        "id": "gaussdb-native",
        "label": "GaussDB native / M-compatible",
        "defaultPort": 5432,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "kingbase",
    "label": "KingbaseES",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 54321,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "kingbase",
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/kingbase.yaml; crates/ndb-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias",
    "variants": [
      {
        "id": "kingbase-pg",
        "label": "KingbaseES / PG mode",
        "defaultPort": 54321,
        "wireFamily": "postgres",
        "authPolicy": "postgres",
        "metadata": "sys",
        "modeCheck": "none"
      },
      {
        "id": "kingbase-oracle",
        "label": "KingbaseES / Oracle mode",
        "defaultPort": 54321,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "highgo",
    "label": "HighGo",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 5866,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "highgo",
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/highgo.yaml; crates/ndb-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias",
    "variants": [
      {
        "id": "highgo-pg",
        "label": "HighGo / PG-compatible edition",
        "defaultPort": 5866,
        "wireFamily": "postgres",
        "authPolicy": "postgres",
        "metadata": "pg",
        "modeCheck": "none"
      },
      {
        "id": "highgo-secure",
        "label": "HighGo / secure or national-crypto edition",
        "defaultPort": 5866,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "vastbase",
    "label": "Vastbase",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "vastbase",
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/vastbase.yaml; crates/ndb-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias",
    "variants": [
      {
        "id": "vastbase-g100-pg",
        "label": "Vastbase G100 / PG mode",
        "defaultPort": 5432,
        "wireFamily": "postgres",
        "authPolicy": "gauss-legacy",
        "metadata": "pg",
        "modeCheck": "pg-compatibility"
      },
      {
        "id": "vastbase-g100-other",
        "label": "Vastbase G100 / other modes",
        "defaultPort": 5432,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      },
      {
        "id": "vastbase-e100",
        "label": "Vastbase E100",
        "defaultPort": 5432,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "uxdb",
    "label": "UXDB",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 52025,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "uxdb",
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/uxdb.yaml; crates/ndb-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias"
  },
  {
    "id": "gbase8c",
    "label": "GBase",
    "category": "domestic",
    "wireFamily": "unpackaged",
    "defaultPort": 5432,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "gbase8c",
    "source": "plugins/connection-types/profiles/catalog.yaml; Native vendor driver required; PG-compatible variant supported",
    "qualification": "catalog",
    "variants": [
      {
        "id": "gbase-8c-pg",
        "label": "GBase 8c / PG-compatible mode",
        "defaultPort": 5432,
        "wireFamily": "postgres",
        "authPolicy": "gauss-legacy",
        "metadata": "pg",
        "modeCheck": "pg-compatibility"
      },
      {
        "id": "gbase-8c",
        "label": "GBase 8c",
        "defaultPort": 5432,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      },
      {
        "id": "gbase-8a",
        "label": "GBase 8a",
        "defaultPort": 5258,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      },
      {
        "id": "gbase-8s",
        "label": "GBase 8s",
        "defaultPort": 9088,
        "wireFamily": "unpackaged",
        "authPolicy": "none",
        "metadata": "none",
        "modeCheck": "none"
      }
    ]
  },
  {
    "id": "tidb",
    "label": "TiDB",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 4000,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "tidb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "oceanbase",
    "label": "OceanBase",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 2883,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "oceanbase",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "dameng",
    "label": "Dameng",
    "category": "domestic",
    "wireFamily": "unpackaged",
    "defaultPort": 5236,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "dameng",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "oracle",
    "label": "Oracle",
    "category": "relational",
    "wireFamily": "unpackaged",
    "defaultPort": 1521,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "oracle",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "sqlserver",
    "label": "SQL Server",
    "category": "relational",
    "wireFamily": "mssql",
    "defaultPort": 1433,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "sqlserver",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "clickhouse",
    "label": "ClickHouse",
    "category": "analytics",
    "wireFamily": "clickhouse",
    "defaultPort": 8123,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "redis",
    "label": "Redis",
    "category": "document",
    "wireFamily": "redis",
    "defaultPort": 6379,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "mongodb",
    "label": "MongoDB",
    "category": "document",
    "wireFamily": "mongodb",
    "defaultPort": 27017,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "mongodb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "firebird",
    "label": "Firebird",
    "category": "relational",
    "wireFamily": "unpackaged",
    "defaultPort": 3050,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": "firebird",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "duckdb",
    "label": "DuckDB",
    "category": "analytics",
    "wireFamily": "unpackaged",
    "defaultPort": 0,
    "fields": [
      "source"
    ],
    "icon": "duckdb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "neo4j",
    "label": "Neo4j",
    "category": "graph",
    "wireFamily": "graph",
    "defaultPort": 7687,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "neo4j",
    "source": "plugins/connection-types/neo4j.yaml",
    "qualification": "wire"
  },
  {
    "id": "nebula",
    "label": "NebulaGraph",
    "category": "graph",
    "wireFamily": "unpackaged",
    "defaultPort": 9669,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "neo4j",
    "source": "plugins/connection-types/nebula.yaml",
    "qualification": "catalog"
  },
  {
    "id": "qdrant",
    "label": "Qdrant",
    "category": "graph",
    "wireFamily": "search",
    "defaultPort": 6333,
    "fields": ["hostname", "port", "apiKey", "tls"],
    "icon": "qdrant",
    "source": "plugins/connection-types/qdrant.yaml",
    "qualification": "wire"
  },
  {
    "id": "chromadb",
    "label": "ChromaDB",
    "category": "graph",
    "wireFamily": "search",
    "defaultPort": 8000,
    "fields": ["hostname", "port", "apiKey", "tls"],
    "icon": "qdrant",
    "source": "plugins/connection-types/chromadb.yaml",
    "qualification": "wire"
  },
  {
    "id": "weaviate",
    "label": "Weaviate",
    "category": "graph",
    "wireFamily": "search",
    "defaultPort": 8080,
    "fields": ["hostname", "port", "apiKey", "tls"],
    "icon": "qdrant",
    "source": "plugins/connection-types/weaviate.yaml",
    "qualification": "wire"
  },
  {
    "id": "elasticsearch",
    "label": "Elasticsearch",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 9200,
    "fields": ["hostname", "port", "username", "password", "apiKey", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/elasticsearch.yaml",
    "qualification": "wire"
  },
  {
    "id": "easysearch",
    "label": "Easysearch",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 9200,
    "fields": ["hostname", "port", "username", "password", "apiKey", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/easysearch.yaml",
    "qualification": "wire"
  },
  {
    "id": "meilisearch",
    "label": "Meilisearch",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 7700,
    "fields": ["hostname", "port", "apiKey", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/meilisearch.yaml",
    "qualification": "wire"
  },
  {
    "id": "couchdb",
    "label": "Apache CouchDB",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 5984,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "mongodb",
    "source": "plugins/connection-types/couchdb.yaml",
    "qualification": "wire"
  },
  {
    "id": "manticoresearch",
    "label": "Manticore Search",
    "category": "document",
    "wireFamily": "mysql",
    "defaultPort": 9306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/manticoresearch.yaml",
    "qualification": "alias"
  },
  {
    "id": "influxdb",
    "label": "InfluxDB",
    "category": "timeseries",
    "wireFamily": "http_sql",
    "defaultPort": 8086,
    "fields": ["hostname", "port", "database", "username", "password", "apiKey", "org", "tls"],
    "icon": "influxdb",
    "source": "plugins/connection-types/influxdb.yaml",
    "qualification": "wire"
  },
  {
    "id": "influxdb3",
    "label": "InfluxDB 3",
    "category": "timeseries",
    "wireFamily": "http_sql",
    "defaultPort": 8181,
    "fields": ["hostname", "port", "database", "apiKey", "tls"],
    "icon": "influxdb",
    "source": "plugins/connection-types/influxdb3.yaml",
    "qualification": "wire"
  },
  {
    "id": "tdengine",
    "label": "TDengine",
    "category": "timeseries",
    "wireFamily": "http_sql",
    "defaultPort": 6041,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "tdengine",
    "source": "plugins/connection-types/tdengine.yaml",
    "qualification": "wire"
  },
  {
    "id": "questdb",
    "label": "QuestDB",
    "category": "timeseries",
    "wireFamily": "postgres",
    "defaultPort": 8812,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "influxdb",
    "source": "plugins/connection-types/questdb.yaml",
    "qualification": "alias"
  },
  {
    "id": "victoriametrics",
    "label": "VictoriaMetrics",
    "category": "timeseries",
    "wireFamily": "http_sql",
    "defaultPort": 8428,
    "fields": ["hostname", "port", "username", "password", "apiKey", "tls"],
    "icon": "tdengine",
    "source": "plugins/connection-types/victoriametrics.yaml",
    "qualification": "wire"
  },
  {
    "id": "cockroachdb",
    "label": "CockroachDB",
    "category": "relational",
    "wireFamily": "postgres",
    "defaultPort": 26257,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "cockroachdb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "dolt",
    "label": "Dolt",
    "category": "relational",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "doris",
    "label": "Apache Doris",
    "category": "analytics",
    "wireFamily": "mysql",
    "defaultPort": 9030,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "doris",
    "source": "plugins/connection-types/doris.yaml",
    "qualification": "alias"
  },
  {
    "id": "starrocks",
    "label": "StarRocks",
    "category": "analytics",
    "wireFamily": "mysql",
    "defaultPort": 9030,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "doris",
    "source": "plugins/connection-types/starrocks.yaml",
    "qualification": "alias"
  },
  {
    "id": "selectdb",
    "label": "SelectDB",
    "category": "analytics",
    "wireFamily": "mysql",
    "defaultPort": 9030,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "doris",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "trino",
    "label": "Trino",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 8080,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "trino",
    "source": "plugins/connection-types/trino.yaml",
    "qualification": "wire"
  },
  {
    "id": "prestosql",
    "label": "PrestoSQL",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 8080,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "trino",
    "source": "plugins/connection-types/prestosql.yaml",
    "qualification": "wire"
  },
  {
    "id": "databend",
    "label": "Databend",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 8000,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/databend.yaml",
    "qualification": "wire"
  },
  {
    "id": "redshift",
    "label": "Amazon Redshift",
    "category": "analytics",
    "wireFamily": "postgres",
    "defaultPort": 5439,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "postgresql",
    "source": "plugins/connection-types/redshift.yaml",
    "qualification": "alias"
  },
  {
    "id": "cloudberry",
    "label": "Apache Cloudberry",
    "category": "analytics",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "postgresql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "rqlite",
    "label": "RQLite",
    "category": "lightweight",
    "wireFamily": "http_sql",
    "defaultPort": 4001,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "sqlite",
    "source": "plugins/connection-types/rqlite.yaml",
    "qualification": "wire"
  },
  {
    "id": "turso",
    "label": "Turso",
    "category": "lightweight",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["hostname", "port", "apiKey", "tls"],
    "icon": "sqlite",
    "source": "plugins/connection-types/turso.yaml",
    "qualification": "wire"
  },
  {
    "id": "polardb",
    "label": "PolarDB",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "tdsql",
    "label": "TDSQL",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "greatsql",
    "label": "GreatSQL",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "opentenbase",
    "label": "OpenTenBase",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 11000,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "postgresql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "kwdb",
    "label": "KWDB",
    "category": "domestic",
    "wireFamily": "postgres",
    "defaultPort": 26257,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "cockroachdb",
    "source": "plugins/connection-types/kwdb.yaml",
    "qualification": "alias"
  },
  {
    "id": "etcd",
    "label": "etcd",
    "category": "registry",
    "wireFamily": "kv",
    "defaultPort": 2379,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "etcd",
    "source": "plugins/connection-types/etcd.yaml",
    "qualification": "wire"
  },
  {
    "id": "consul",
    "label": "Consul",
    "category": "registry",
    "wireFamily": "kv",
    "defaultPort": 8500,
    "fields": ["hostname", "port", "apiKey", "namespace", "tls"],
    "icon": "consul",
    "source": "plugins/connection-types/consul.yaml",
    "qualification": "wire"
  },
  {
    "id": "nacos",
    "label": "Nacos",
    "category": "registry",
    "wireFamily": "kv",
    "defaultPort": 8848,
    "fields": ["hostname", "port", "username", "password", "namespace", "tls"],
    "icon": "etcd",
    "source": "plugins/connection-types/nacos.yaml",
    "qualification": "wire"
  },
  // --- Wave D (3a): Live Wire-Compatible Aliases ---
  {
    "id": "oceanbase-oracle",
    "label": "OceanBase (Oracle Mode)",
    "category": "domestic",
    "wireFamily": "mysql",
    "defaultPort": 2883,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "oceanbase",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "custom_postgres",
    "label": "Custom (PostgreSQL)",
    "category": "relational",
    "wireFamily": "postgres",
    "defaultPort": 5432,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "postgresql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "custom_mysql",
    "label": "Custom (MySQL)",
    "category": "relational",
    "wireFamily": "mysql",
    "defaultPort": 3306,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mysql",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "mongodb-legacy",
    "label": "MongoDB (Legacy)",
    "category": "document",
    "wireFamily": "mongodb",
    "defaultPort": 27017,
    "fields": ["hostname", "port", "database", "username", "password", "authSource", "tls"],
    "icon": "mongodb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "etcd-v2",
    "label": "etcd 2.x (v2 API)",
    "category": "registry",
    "wireFamily": "kv",
    "defaultPort": 2379,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "etcd",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  // --- Wave D (3b): Live Pure-TS HTTP & Binary TCP Protocol Drivers ---
  {
    "id": "cloudflare-d1",
    "label": "Cloudflare D1",
    "category": "lightweight",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["hostname", "accountId", "database", "apiKey", "tls"],
    "icon": "sqlite",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "solr",
    "label": "Apache Solr",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 8983,
    "fields": ["hostname", "port", "username", "password", "httpPath", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "milvus",
    "label": "Milvus",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 19530,
    "fields": ["hostname", "port", "database", "username", "password", "apiKey", "tls"],
    "icon": "qdrant",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "dynamodb",
    "label": "Amazon DynamoDB",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 443,
    "fields": ["hostname", "port", "region", "username", "password", "tls"],
    "icon": "mongodb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "hbase",
    "label": "Apache HBase (REST)",
    "category": "document",
    "wireFamily": "search",
    "defaultPort": 8080,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "elasticsearch",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "rabbitmq",
    "label": "RabbitMQ",
    "category": "messaging",
    "wireFamily": "mq",
    "defaultPort": 15672,
    "fields": ["hostname", "port", "vhost", "username", "password", "tls"],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "pulsar",
    "label": "Apache Pulsar",
    "category": "messaging",
    "wireFamily": "mq",
    "defaultPort": 8080,
    "fields": ["hostname", "port", "org", "namespace", "apiKey", "tls"],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "mqtt",
    "label": "MQTT Broker",
    "category": "messaging",
    "wireFamily": "mq",
    "defaultPort": 1883,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "kafka",
    "label": "Apache Kafka",
    "category": "messaging",
    "wireFamily": "mq",
    "defaultPort": 9092,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "mq",
    "label": "Message Queue (RabbitMQ / Pulsar)",
    "category": "messaging",
    "wireFamily": "mq",
    "defaultPort": 15672,
    "fields": ["hostname", "port", "vhost", "username", "password", "tls"],
    "icon": "redis",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  {
    "id": "scylladb",
    "label": "ScyllaDB",
    "category": "document",
    "wireFamily": "cql",
    "defaultPort": 9042,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mongodb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
  },
  { "id": "dm", "label": "DM (Dameng Alias)", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 5236, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "exasol", "label": "Exasol", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 8563, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  {
    "id": "iotdb",
    "label": "Apache IoTDB (REST)",
    "category": "timeseries",
    "wireFamily": "http_sql",
    "defaultPort": 18080,
    "fields": ["hostname", "port", "username", "password", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "kylin",
    "label": "Apache Kylin",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 7070,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "databricks",
    "label": "Databricks SQL",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["hostname", "warehouseId", "database", "apiKey", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "snowflake",
    "label": "Snowflake",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["hostname", "warehouseId", "database", "schema", "apiKey", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "bigquery",
    "label": "Google BigQuery",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["accountId", "database", "region", "apiKey", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "salesforce",
    "label": "Salesforce SOQL",
    "category": "analytics",
    "wireFamily": "http_sql",
    "defaultPort": 443,
    "fields": ["hostname", "apiKey", "tls"],
    "icon": "clickhouse",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "cassandra",
    "label": "Apache Cassandra / ScyllaDB",
    "category": "document",
    "wireFamily": "cql",
    "defaultPort": 9042,
    "fields": ["hostname", "port", "database", "username", "password", "tls"],
    "icon": "mongodb",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  {
    "id": "zookeeper",
    "label": "Apache ZooKeeper",
    "category": "registry",
    "wireFamily": "kv",
    "defaultPort": 2181,
    "fields": ["hostname", "port", "tls"],
    "icon": "consul",
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "wire"
  },
  // --- Wave D (3c): Honest Catalog Entries (JDBC / OCI / Native C / Thrift / gRPC) ---
  { "id": "yashandb", "label": "YashanDB", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 1688, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "xugu", "label": "XuGuDB", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 5138, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "oscar", "label": "ShenTong (Oscar)", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 2003, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "sundb", "label": "SunDB", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 22000, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "gbase", "label": "GBase", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 5258, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "gbase8a", "label": "GBase 8a", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 5258, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "gbase8s", "label": "GBase 8s", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 9088, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "db2", "label": "IBM Db2", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 50000, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "informix", "label": "IBM Informix", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 9088, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "saphana", "label": "SAP HANA", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 30015, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "teradata", "label": "Teradata", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 1025, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "vertica", "label": "Vertica", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 5433, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "iris", "label": "InterSystems IRIS", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 1972, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "cache", "label": "InterSystems Caché", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 1972, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "h2", "label": "H2 Database", "category": "lightweight", "wireFamily": "unpackaged", "defaultPort": 9092, "fields": ["hostname", "port", "database", "username", "password"], "icon": "sqlite", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "h2-legacy", "label": "H2 Database (Legacy)", "category": "lightweight", "wireFamily": "unpackaged", "defaultPort": 9092, "fields": ["hostname", "port", "database", "username", "password"], "icon": "sqlite", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "access", "label": "Microsoft Access", "category": "lightweight", "wireFamily": "unpackaged", "defaultPort": 0, "fields": ["source"], "icon": "sqlite", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "hive", "label": "Apache Hive", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 10000, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "kyuubi", "label": "Apache Kyuubi", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 10009, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "impala", "label": "Apache Impala", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 21050, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "spark", "label": "Apache Spark SQL", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 10015, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "transwarp-inceptor", "label": "Transwarp Inceptor", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 10000, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "argo", "label": "Transwarp ArgoDB", "category": "domestic", "wireFamily": "unpackaged", "defaultPort": 10000, "fields": ["hostname", "port", "database", "username", "password"], "icon": "dameng", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "ignite", "label": "Apache Ignite 2", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 10800, "fields": ["hostname", "port", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "ignite3", "label": "Apache Ignite 3", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 10800, "fields": ["hostname", "port", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "spanner", "label": "Google Cloud Spanner", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 443, "fields": ["accountId", "database"], "icon": "postgresql", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "rocketmq", "label": "Apache RocketMQ", "category": "messaging", "wireFamily": "unpackaged", "defaultPort": 9876, "fields": ["hostname", "port", "username", "password"], "icon": "redis", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "dremio", "label": "Dremio", "category": "analytics", "wireFamily": "unpackaged", "defaultPort": 31010, "fields": ["hostname", "port", "database", "username", "password"], "icon": "clickhouse", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "jdbc", "label": "Generic JDBC", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 0, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" },
  { "id": "jdbcx", "label": "Extended JDBC (JDBCx)", "category": "relational", "wireFamily": "unpackaged", "defaultPort": 0, "fields": ["hostname", "port", "database", "username", "password"], "icon": "oracle", "source": "plugins/connection-types/profiles/catalog.yaml", "qualification": "catalog" }
] as const satisfies readonly DriverProfile[];
export type DriverId = typeof drivers[number]['id'];
export type DriverCategory = DriverProfile['category'];
export const driverById = (id: DriverId): DriverProfile => drivers.find(driver => driver.id === id)!;
export const filterDrivers = (category: DriverCategory | 'all', search: string) => drivers.filter(driver => (category === 'all' || driver.category === category) && `${driver.label} ${driver.id} ${driver.wireFamily}`.toLowerCase().includes(search.trim().toLowerCase()));
