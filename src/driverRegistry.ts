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
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/goldendb.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs; agents/drivers/goldendb/src/main/java/com/dbx/agent/goldendb/GoldendbAgent.java buildUrl jdbc:mysql",
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
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/kingbase.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
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
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/highgo.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
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
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/vastbase.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/uxdb.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
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
    "source": "plugins/connection-types/profiles/catalog.yaml; agents/drivers/gbase8c/src/main/java/com/dbx/agent/gbase8c/Gbase8cAgent.java requires vendor driver",
    "qualification": "catalog",
    "variants": [
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
    "icon": null,
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
    "icon": null,
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "sqlserver",
    "label": "SQL Server",
    "category": "relational",
    "wireFamily": "unpackaged",
    "defaultPort": 1433,
    "fields": [
      "hostname",
      "port",
      "database",
      "username",
      "password",
      "tls"
    ],
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "catalog"
  },
  {
    "id": "clickhouse",
    "label": "ClickHouse",
    "category": "analytics",
    "wireFamily": "unpackaged",
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
    "qualification": "catalog"
  },
  {
    "id": "redis",
    "label": "Redis",
    "category": "document",
    "wireFamily": "unpackaged",
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
    "qualification": "catalog"
  },
  {
    "id": "mongodb",
    "label": "MongoDB",
    "category": "document",
    "wireFamily": "unpackaged",
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
    "qualification": "catalog"
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
  }
] as const satisfies readonly DriverProfile[];
export type DriverId = typeof drivers[number]['id'];
export type DriverCategory = DriverProfile['category'];
export const driverById = (id: DriverId): DriverProfile => drivers.find(driver => driver.id === id)!;
export const filterDrivers = (category: DriverCategory | 'all', search: string) => drivers.filter(driver => (category === 'all' || driver.category === category) && `${driver.label} ${driver.id} ${driver.wireFamily}`.toLowerCase().includes(search.trim().toLowerCase()));
