/**
 * Unified EXPLAIN plan parser for PostgreSQL, MySQL/MariaDB, SQLite, and ClickHouse.
 */

import type { ExplainNode, ExplainResult } from '../drivers/types';

let nodeSeq = 0;
function nextId(): string {
  return `plan-${++nodeSeq}`;
}

function parsePgPlanNode(plan: Record<string, unknown>): ExplainNode {
  const warnings: string[] = [];
  const nodeType = String(plan['Node Type'] ?? 'Plan');
  const relation = typeof plan['Relation Name'] === 'string' ? plan['Relation Name'] : undefined;
  const planRows = typeof plan['Plan Rows'] === 'number' ? plan['Plan Rows'] : undefined;
  const actualRows = typeof plan['Actual Rows'] === 'number' ? plan['Actual Rows'] : undefined;
  if (nodeType === 'Seq Scan' && (planRows ?? 0) > 1000) {
    warnings.push('Sequential scan on large table');
  }
  if (planRows !== undefined && actualRows !== undefined && planRows > 0) {
    const ratio = actualRows / planRows;
    if (ratio > 10 || ratio < 0.1) {
      warnings.push(`Row estimate mismatch (est ${planRows} vs actual ${actualRows})`);
    }
  }
  const childPlans = Array.isArray(plan['Plans']) ? plan['Plans'] : [];
  return {
    id: nextId(),
    nodeType,
    relation,
    alias: typeof plan['Alias'] === 'string' ? plan['Alias'] : undefined,
    indexName: typeof plan['Index Name'] === 'string' ? plan['Index Name'] : undefined,
    startupCost: typeof plan['Startup Cost'] === 'number' ? plan['Startup Cost'] : undefined,
    totalCost: typeof plan['Total Cost'] === 'number' ? plan['Total Cost'] : undefined,
    planRows,
    actualRows,
    actualTimeMs: typeof plan['Actual Total Time'] === 'number' ? plan['Actual Total Time'] : undefined,
    loops: typeof plan['Actual Loops'] === 'number' ? plan['Actual Loops'] : undefined,
    filter:
      typeof plan['Filter'] === 'string'
        ? plan['Filter']
        : typeof plan['Index Cond'] === 'string'
          ? plan['Index Cond']
          : typeof plan['Hash Cond'] === 'string'
            ? plan['Hash Cond']
            : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    children: childPlans
      .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
      .map((c) => parsePgPlanNode(c)),
  };
}

export function parsePostgresExplainJson(rawJson: unknown, analyzed = false): ExplainResult {
  nodeSeq = 0;
  const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const top = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>) : (parsed as Record<string, unknown>);
  const planObj = (top?.['Plan'] ?? top ?? {}) as Record<string, unknown>;
  const root = parsePgPlanNode(planObj);
  const execTime =
    typeof top?.['Execution Time'] === 'number'
      ? top['Execution Time']
      : root.actualTimeMs;
  return {
    dialect: 'postgres',
    analyzed,
    root,
    totalCost: root.totalCost,
    actualTimeMs: execTime,
    rawJson: parsed,
    rawText: JSON.stringify(parsed, null, 2),
  };
}

function parseMysqlJsonNode(obj: Record<string, unknown>, label = 'Query Block'): ExplainNode {
  const children: ExplainNode[] = [];
  const warnings: string[] = [];

  if (obj.table && typeof obj.table === 'object') {
    const t = obj.table as Record<string, unknown>;
    const accessType = String(t.access_type ?? 'SCAN');
    const tableName = typeof t.table_name === 'string' ? t.table_name : undefined;
    const costInfo = (t.cost_info ?? {}) as Record<string, unknown>;
    const evalCost = costInfo.eval_cost !== undefined ? Number(costInfo.eval_cost) : undefined;
    const readCost = costInfo.read_cost !== undefined ? Number(costInfo.read_cost) : undefined;
    const totalCost =
      evalCost !== undefined && readCost !== undefined
        ? evalCost + readCost
        : readCost ?? evalCost;
    if (accessType === 'ALL') warnings.push('Full table scan (access_type = ALL)');
    return {
      id: nextId(),
      nodeType: `Table ${accessType}`,
      relation: tableName,
      indexName: typeof t.key === 'string' ? t.key : undefined,
      totalCost: Number.isFinite(totalCost) ? totalCost : undefined,
      planRows: typeof t.rows_examined_per_scan === 'number' ? t.rows_examined_per_scan : undefined,
      filter: typeof t.attached_condition === 'string' ? t.attached_condition : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      children: [],
    };
  }

  if (obj.nested_loop && Array.isArray(obj.nested_loop)) {
    for (const item of obj.nested_loop) {
      if (item && typeof item === 'object') {
        children.push(parseMysqlJsonNode(item as Record<string, unknown>, 'Nested Loop Item'));
      }
    }
  }
  if (obj.ordering_operation && typeof obj.ordering_operation === 'object') {
    children.push(parseMysqlJsonNode(obj.ordering_operation as Record<string, unknown>, 'Ordering'));
  }
  if (obj.grouping_operation && typeof obj.grouping_operation === 'object') {
    children.push(parseMysqlJsonNode(obj.grouping_operation as Record<string, unknown>, 'Grouping'));
  }
  if (obj.query_block && typeof obj.query_block === 'object') {
    return parseMysqlJsonNode(obj.query_block as Record<string, unknown>, 'Query Block');
  }

  const costInfo = (obj.cost_info ?? {}) as Record<string, unknown>;
  const queryCost = costInfo.query_cost !== undefined ? Number(costInfo.query_cost) : undefined;

  return {
    id: nextId(),
    nodeType: label,
    totalCost: Number.isFinite(queryCost) ? queryCost : undefined,
    children,
  };
}

export function parseMysqlExplainJson(rawJson: unknown, analyzed = false): ExplainResult {
  nodeSeq = 0;
  const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const root = parseMysqlJsonNode((parsed ?? {}) as Record<string, unknown>, 'Query Block');
  return {
    dialect: 'mysql',
    analyzed,
    root,
    totalCost: root.totalCost,
    rawJson: parsed,
    rawText: typeof rawJson === 'string' ? rawJson : JSON.stringify(parsed, null, 2),
  };
}

export function parseSqliteExplainQueryPlan(
  rows: Array<{ id: number; parent: number; detail: string }>,
): ExplainResult {
  nodeSeq = 0;
  const map = new Map<number, ExplainNode>();
  const roots: ExplainNode[] = [];

  for (const r of rows) {
    const detail = r.detail;
    const isScan = /\bSCAN\b/i.test(detail) && !/\bUSING (?:COVERING )?INDEX\b/i.test(detail);
    const tblMatch = /\b(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([A-Za-z0-9_"`]+)/i.exec(detail);
    const idxMatch = /\bUSING (?:COVERING )?INDEX\s+([A-Za-z0-9_"`]+)/i.exec(detail);
    const node: ExplainNode = {
      id: `sqlite-${r.id}`,
      nodeType: detail.split(/\s+/).slice(0, 2).join(' ') || 'STEP',
      relation: tblMatch?.[1]?.replaceAll('"', '').replaceAll('`', ''),
      indexName: idxMatch?.[1]?.replaceAll('"', '').replaceAll('`', ''),
      detail,
      warnings: isScan ? ['Full table scan'] : undefined,
      children: [],
    };
    map.set(r.id, node);
  }

  for (const r of rows) {
    const node = map.get(r.id)!;
    const parent = map.get(r.parent);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const root: ExplainNode =
    roots.length === 1
      ? roots[0]
      : { id: nextId(), nodeType: 'QUERY PLAN', children: roots };

  return {
    dialect: 'sqlite',
    analyzed: false,
    root,
    rawText: rows.map((r) => `${r.id}|${r.parent}|${r.detail}`).join('\n'),
  };
}

export function parseClickHouseExplainText(lines: string[]): ExplainResult {
  nodeSeq = 0;
  const stack: Array<{ indent: number; node: ExplainNode }> = [];
  const roots: ExplainNode[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const detail = line.trim();
    const node: ExplainNode = {
      id: nextId(),
      nodeType: detail.split(/\s+/)[0] || 'Plan',
      detail,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ indent, node });
  }

  const root: ExplainNode =
    roots.length === 1
      ? roots[0]
      : { id: nextId(), nodeType: 'ClickHouse Plan', children: roots };

  return {
    dialect: 'clickhouse',
    analyzed: false,
    root,
    rawText: lines.join('\n'),
  };
}
