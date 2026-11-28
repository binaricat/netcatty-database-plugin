/**
 * Pure-TS MongoDB Aggregation BI Helpers (100% browser-sandbox compatible, zero `node:*`).
 *
 * Powers native MongoDB (`mongodb` & `mongodb-legacy`) BI analytics:
 * - JSON query parsing & formatting (`{ "collection": "...", "pipeline": [...] }`)
 * - Recursive read-only pipeline guard rejecting `$out` and `$merge` at any nesting depth
 * - Bounded `$limit` injection for safe BI charting
 * - Deterministic document-to-`QueryResultSet` flattening (expanding grouped `_id` objects
 *   and unwrapping Extended JSON scalars so `recommendChartConfig` / `buildBiChartProps` work seamlessly)
 */

import type { CellValue, ColumnMeta, MongoDocument, QueryResultSet } from '../drivers/types';

export interface MongoBiQuerySpec {
  collection: string;
  pipeline: Record<string, unknown>[];
  database?: string;
}

const FORBIDDEN_WRITE_STAGES = new Set(['$out', '$merge']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

/**
 * Recursively asserts that a MongoDB aggregation pipeline contains zero write stages
 * (`$out`, `$merge`), including inside nested `$lookup.pipeline`, `$unionWith.pipeline`,
 * and `$facet` sub-pipelines.
 */
export function assertReadOnlyMongoPipeline(pipeline: unknown): asserts pipeline is Record<string, unknown>[] {
  if (!Array.isArray(pipeline)) {
    throw new Error('MongoDB BI query pipeline must be a JSON array of aggregation stage objects.');
  }
  const inspectStages = (stages: unknown[], path: string) => {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!isPlainRecord(stage)) {
        throw new Error(`MongoDB pipeline stage at ${path}[${i}] must be a JSON object.`);
      }
      for (const [key, val] of Object.entries(stage)) {
        const lower = key.trim().toLowerCase();
        if (FORBIDDEN_WRITE_STAGES.has(lower)) {
          throw new Error(
            `Read-only MongoDB BI guard blocked write stage "${key}". Only read-only aggregation pipelines are permitted.`,
          );
        }
        if (lower === '$lookup' && isPlainRecord(val) && Array.isArray(val.pipeline)) {
          inspectStages(val.pipeline, `${path}[${i}].$lookup.pipeline`);
        } else if (lower === '$unionwith' && isPlainRecord(val) && Array.isArray(val.pipeline)) {
          inspectStages(val.pipeline, `${path}[${i}].$unionWith.pipeline`);
        } else if (lower === '$facet' && isPlainRecord(val)) {
          for (const [branch, sub] of Object.entries(val)) {
            if (Array.isArray(sub)) {
              inspectStages(sub, `${path}[${i}].$facet.${branch}`);
            }
          }
        }
      }
    }
  };
  inspectStages(pipeline, 'pipeline');
}

/**
 * Parses a MongoDB BI query string of the form `{ "collection": "orders", "pipeline": [...] }`
 * and enforces strict read-only stage validation.
 */
export function parseMongoBiQuery(raw: string): MongoBiQuerySpec {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/;+\s*$/, '')
    .trim();
  if (!trimmed) {
    throw new Error('MongoDB BI query is empty. Expected JSON: {"collection":"<name>","pipeline":[...]}');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Invalid MongoDB BI query JSON: ${err instanceof Error ? err.message : String(err)}. Expected {"collection":"<name>","pipeline":[...]}`,
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('MongoDB BI query must be a JSON object: {"collection":"<name>","pipeline":[...]}');
  }
  const collection = typeof parsed.collection === 'string' ? parsed.collection.trim() : '';
  if (!collection) {
    throw new Error('MongoDB BI query requires a non-empty "collection" string.');
  }
  const pipelineRaw = parsed.pipeline ?? [];
  assertReadOnlyMongoPipeline(pipelineRaw);
  const database = typeof parsed.database === 'string' && parsed.database.trim() ? parsed.database.trim() : undefined;
  return { collection, pipeline: pipelineRaw, ...(database ? { database } : {}) };
}

/**
 * Formats a MongoDB BI query spec into canonical pretty-printed JSON.
 */
export function formatMongoBiQuery(spec: MongoBiQuerySpec): string {
  const payload: Record<string, unknown> = {
    collection: spec.collection,
    pipeline: spec.pipeline,
  };
  if (spec.database) payload.database = spec.database;
  return JSON.stringify(payload, null, 2);
}

/**
 * Ensures a read-only aggregation pipeline returns at most `maxRows` documents.
 */
export function appendMongoSafeLimit(
  pipeline: readonly Record<string, unknown>[],
  maxRows = 500,
): Record<string, unknown>[] {
  const safeCap = Math.max(1, Math.min(500, Math.floor(maxRows)));
  const last = pipeline[pipeline.length - 1];
  if (last && typeof last.$limit === 'number' && Number.isFinite(last.$limit) && last.$limit > 0 && last.$limit <= safeCap) {
    return [...pipeline];
  }
  return [...pipeline, { $limit: safeCap }];
}

function unwrapMongoScalar(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;

  if (isPlainRecord(value)) {
    // Extended JSON v2 & BSON wrapper unwrapping
    if (typeof value.$oid === 'string') return value.$oid;
    if (typeof value.$date === 'string') return value.$date;
    if (isPlainRecord(value.$date) && typeof value.$date.$numberLong === 'string') {
      const ms = Number(value.$date.$numberLong);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : value.$date.$numberLong;
    }
    if (typeof value.$numberDecimal === 'string') {
      const n = Number(value.$numberDecimal);
      return Number.isFinite(n) ? n : value.$numberDecimal;
    }
    if (typeof value.$numberDouble === 'string') {
      const n = Number(value.$numberDouble);
      return Number.isFinite(n) ? n : value.$numberDouble;
    }
    if (typeof value.$numberInt === 'string') {
      const n = Number(value.$numberInt);
      return Number.isFinite(n) ? n : value.$numberInt;
    }
    if (typeof value.$numberLong === 'string') {
      const n = Number(value.$numberLong);
      return Number.isSafeInteger(n) ? n : value.$numberLong;
    }
    // BSON ObjectId/Decimal128 runtime objects with toHexString / toString
    const maybeBson = value as { _bsontype?: string; toHexString?: () => string; toString?: () => string };
    if (maybeBson._bsontype === 'ObjectId' && typeof maybeBson.toHexString === 'function') {
      return maybeBson.toHexString();
    }
    if (maybeBson._bsontype === 'Decimal128' && typeof maybeBson.toString === 'function') {
      const n = Number(maybeBson.toString());
      return Number.isFinite(n) ? n : maybeBson.toString();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '[Object]';
    }
  }

  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[Array]';
    }
  }
  return String(value);
}

function isEjsonWrapper(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0].startsWith('$')) return true;
  const maybeBson = obj as { _bsontype?: string };
  return typeof maybeBson._bsontype === 'string';
}

function flattenDocument(doc: MongoDocument): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  const topKeys = new Set(Object.keys(doc));

  for (const [key, val] of Object.entries(doc)) {
    if (key === '_id' && isPlainRecord(val) && !isEjsonWrapper(val)) {
      const subEntries = Object.entries(val);
      if (subEntries.length === 0) {
        out._id = null;
      } else {
        for (const [subKey, subVal] of subEntries) {
          const targetKey = topKeys.has(subKey) && subKey !== '_id' ? `_id.${subKey}` : subKey;
          out[targetKey] = unwrapMongoScalar(subVal);
        }
      }
      continue;
    }

    if (isPlainRecord(val) && !isEjsonWrapper(val)) {
      const subEntries = Object.entries(val);
      if (subEntries.length > 0 && subEntries.length <= 8) {
        for (const [subKey, subVal] of subEntries) {
          out[`${key}.${subKey}`] = unwrapMongoScalar(subVal);
        }
        continue;
      }
    }

    out[key] = unwrapMongoScalar(val);
  }
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function inferColumnDataType(values: CellValue[]): string {
  let hasNumber = false;
  let allInts = true;
  let hasBool = false;
  let hasDate = false;
  let hasText = false;

  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      hasNumber = true;
      if (!Number.isInteger(v)) allInts = false;
    } else if (typeof v === 'boolean') {
      hasBool = true;
    } else if (typeof v === 'string') {
      if (ISO_DATE_RE.test(v.trim())) {
        hasDate = true;
      } else {
        hasText = true;
      }
    } else {
      hasText = true;
    }
  }

  if (hasNumber && !hasText && !hasDate && !hasBool) return allInts ? 'INTEGER' : 'DOUBLE';
  if (hasDate && !hasText && !hasNumber && !hasBool) return 'TIMESTAMP';
  if (hasBool && !hasText && !hasNumber && !hasDate) return 'BOOLEAN';
  return 'TEXT';
}

/**
 * Converts MongoDB aggregation output documents into a tabular `QueryResultSet`
 * compatible with `recommendChartConfig`, `buildBiChartProps`, and `PluginDataGrid`.
 */
export function flattenMongoDocsToResultSet(
  docs: readonly MongoDocument[],
  executionMs = 0,
  queryText = '',
): QueryResultSet {
  const flatDocs = docs.map((d) => flattenDocument(d));
  const colNames: string[] = [];
  const seen = new Set<string>();
  for (const row of flatDocs) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        colNames.push(key);
      }
    }
  }

  const columns: ColumnMeta[] = colNames.map((name) => {
    const sample = flatDocs.slice(0, 100).map((r) => (Object.prototype.hasOwnProperty.call(r, name) ? r[name] : null));
    return {
      name,
      dataType: inferColumnDataType(sample),
      isPrimaryKey: name === '_id',
      nullable: true,
    };
  });

  const rows: CellValue[][] = flatDocs.map((r) =>
    colNames.map((name) => (Object.prototype.hasOwnProperty.call(r, name) ? r[name] : null)),
  );

  return {
    sql: queryText,
    columns,
    rows,
    rowCount: rows.length,
    affectedRows: 0,
    executionMs,
    truncated: false,
    commandTag: 'AGGREGATE',
  };
}
