// Generated from the public host contract registry; drift is checked in tests.
import type { DatabaseDriverId } from '@netcatty/plugin-contract';
export type DriverProfile = { id: DatabaseDriverId; label: string; category: 'lightweight' | 'relational' | 'domestic' | 'analytics' | 'document'; wireFamily: 'sqlite' | 'postgres' | 'mysql' | 'unpackaged'; defaultPort: number; fields: readonly string[]; icon: string | null; source: string; qualification: string };
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/goldendb.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs; agents/drivers/goldendb/src/main/java/com/dbx/agent/goldendb/GoldendbAgent.java buildUrl jdbc:mysql",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/kingbase.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/highgo.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; plugins/connection-types/vastbase.yaml; crates/dbx-sql-dialect/src/sql_dialect/descriptor.rs",
    "qualification": "alias"
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
    "icon": null,
    "source": "plugins/connection-types/profiles/catalog.yaml; agents/drivers/gbase8c/src/main/java/com/dbx/agent/gbase8c/Gbase8cAgent.java requires vendor driver",
    "qualification": "catalog"
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
