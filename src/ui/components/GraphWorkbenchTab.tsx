/**
 * Neo4j / Graph Database Specialist Workbench Tab:
 * - Cypher editor (`PluginCodeEditor`) with History & Snippets bar + clickable label/rel chips
 * - Visual Graph view powered by host-rendered `PluginErCanvas` (zero inline svg/canvas)
 * - Visual Node / Relationship Create, Edit, Delete panel (parameterized Cypher CREATE/SET/DELETE)
 * - EXPLAIN / PROFILE Cypher Plan tree & raw JSON view
 * - Tabular view (`PluginDataGrid`) and structured JSON view
 */

import React, { useMemo, useState } from 'react';
import {
  PluginCodeEditor,
  PluginDataGrid,
  PluginErCanvas,
  PluginSplitPane,
  type PluginDataGridColumn,
  type PluginErRelation,
  type PluginErTable,
  type PluginWorkbenchShortcut,
} from '@netcatty/plugin-sdk/host-react';
import { Icon } from '../../Icon';
import type {
  CypherPlanNode,
  GraphExplainPlanResult,
} from '../../drivers/neo4jDriver';
import type { GraphDriver, GraphNode, GraphQueryResult, GraphRelationship } from '../../drivers/types';
import type { GraphWorkbenchTabState } from '../types';

export interface GraphWorkbenchTabProps {
  tab: GraphWorkbenchTabState;
  driver: GraphDriver;
  readOnly?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onUpdateTab: (patch: Partial<GraphWorkbenchTabState>) => void;
  onRunCypher: (cypherOverride?: string) => Promise<void>;
  onRefreshSchema: () => Promise<void>;
  onExportSvg?: (svg: string) => void;
  onCopyText?: (text: string, label: string) => void;
  onShortcut?: (detail: { shortcut: PluginWorkbenchShortcut }) => void;
}

type ExtendedGraphDriver = GraphDriver & {
  explainCypher?: (
    cypher: string,
    mode?: 'EXPLAIN' | 'PROFILE',
    options?: { database?: string },
  ) => Promise<GraphExplainPlanResult>;
  createNode?: (
    labels: readonly string[],
    properties?: Record<string, unknown>,
    database?: string,
  ) => Promise<GraphQueryResult>;
  updateNode?: (
    nodeId: string,
    properties: Record<string, unknown>,
    options?: { replaceAll?: boolean; database?: string },
  ) => Promise<GraphQueryResult>;
  deleteNode?: (
    nodeId: string,
    detach?: boolean,
    database?: string,
  ) => Promise<GraphQueryResult>;
  createRelationship?: (
    startNodeId: string,
    endNodeId: string,
    relType: string,
    properties?: Record<string, unknown>,
    database?: string,
  ) => Promise<GraphQueryResult>;
  updateRelationship?: (
    relId: string,
    properties: Record<string, unknown>,
    options?: { replaceAll?: boolean; database?: string },
  ) => Promise<GraphQueryResult>;
  deleteRelationship?: (relId: string, database?: string) => Promise<GraphQueryResult>;
};

const CYPHER_SNIPPETS: Array<{ title: string; cypher: string }> = [
  {
    title: 'Sample Graph',
    cypher: 'MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 50',
  },
  {
    title: 'Label Counts',
    cypher: 'MATCH (n) RETURN labels(n) AS labels, count(*) AS total ORDER BY total DESC LIMIT 25',
  },
  {
    title: 'Rel Type Counts',
    cypher: 'MATCH ()-[r]->() RETURN type(r) AS relType, count(*) AS total ORDER BY total DESC LIMIT 25',
  },
  {
    title: 'Orphan Nodes',
    cypher: 'MATCH (n) WHERE NOT (n)--() RETURN n LIMIT 50',
  },
  {
    title: 'Shortest Path',
    cypher: 'MATCH (a), (b) WHERE elementId(a) <> elementId(b) MATCH p = shortestPath((a)-[*..4]-(b)) RETURN p LIMIT 5',
  },
  {
    title: 'Constraints',
    cypher: 'SHOW CONSTRAINTS',
  },
];

function escapeCypherIdent(name: string): string {
  return '`' + name.replaceAll('`', '``') + '`';
}

function formatGraphValue(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return val.length > 60 ? `${val.slice(0, 57)}...` : val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    const s = JSON.stringify(val);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(val);
  }
}

function buildNodeCardName(node: GraphNode): string {
  const labelPrefix = node.labels.length > 0 ? `:${node.labels.join(':')}` : ':Node';
  const titleProp =
    node.properties.name ??
    node.properties.title ??
    node.properties.username ??
    node.properties.id ??
    node.properties.key;
  if (titleProp !== undefined && titleProp !== null && String(titleProp).trim() !== '') {
    const display = String(titleProp).slice(0, 28);
    return `${display} (${labelPrefix} #${node.id})`;
  }
  return `${labelPrefix} #${node.id}`;
}

function CypherPlanBranch({ node, depth = 0 }: { node: CypherPlanNode; depth?: number }) {
  return (
    <div style={{ paddingLeft: `${depth * 18}px`, marginTop: '4px' }}>
      <div className="ndb-inline-row" style={{ gap: '6px', flexWrap: 'wrap' }}>
        <span className="ndb-tag ndb-mono">{node.operatorType}</span>
        {node.identifiers.length > 0 && (
          <span className="ndb-mono ndb-muted">{`(${node.identifiers.join(', ')})`}</span>
        )}
        {node.estimatedRows !== undefined && (
          <span className="ndb-tag ndb-mono">{`estRows: ${Math.round(node.estimatedRows)}`}</span>
        )}
        {node.rows !== undefined && (
          <span className="ndb-tag ndb-tag-ok ndb-mono">{`rows: ${node.rows}`}</span>
        )}
        {node.dbHits !== undefined && (
          <span className="ndb-tag ndb-tag-warn ndb-mono">{`dbHits: ${node.dbHits}`}</span>
        )}
      </div>
      {node.children.map((child, idx) => (
        <CypherPlanBranch key={`${child.operatorType}-${idx}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function GraphWorkbenchTab({
  tab,
  driver,
  readOnly = false,
  t,
  onUpdateTab,
  onRunCypher,
  onRefreshSchema,
  onExportSvg,
  onCopyText,
  onShortcut,
}: GraphWorkbenchTabProps) {
  const extDriver = driver as ExtendedGraphDriver;
  const [nodeFilter, setNodeFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Cypher History & Snippets
  const [cypherHistory, setCypherHistory] = useState<Array<{ cypher: string; ts: number }>>([]);
  const [customSnippets, setCustomSnippets] = useState<Array<{ title: string; cypher: string }>>([]);
  const [showHistoryBar, setShowHistoryBar] = useState(false);
  const [newSnippetTitle, setNewSnippetTitle] = useState('');

  // EXPLAIN / PROFILE Plan view
  const [planResult, setPlanResult] = useState<GraphExplainPlanResult | null>(null);
  const [showPlanView, setShowPlanView] = useState(false);
  const [planShowRaw, setPlanShowRaw] = useState(false);

  // Visual Node / Relationship CRUD panel
  const [showCrudPanel, setShowCrudPanel] = useState(false);
  const [crudMode, setCrudMode] = useState<'createNode' | 'createRel'>('createNode');
  const [nodeLabelsInput, setNodeLabelsInput] = useState('Person');
  const [nodePropsJson, setNodePropsJson] = useState('{\n  "name": "Alice"\n}');
  const [relStartId, setRelStartId] = useState('');
  const [relEndId, setRelEndId] = useState('');
  const [relTypeInput, setRelTypeInput] = useState('KNOWS');
  const [relPropsJson, setRelPropsJson] = useState('{\n  "since": 2026\n}');

  // Selected Node inline Edit / Delete
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editNodePropsJson, setEditNodePropsJson] = useState('{}');
  const [editNodeReplaceAll, setEditNodeReplaceAll] = useState(false);
  const [confirmDeleteNodeId, setConfirmDeleteNodeId] = useState<string | null>(null);

  const recordAndRunCypher = async (cypherOverride?: string) => {
    const stmt = (cypherOverride ?? tab.cypher).trim();
    if (stmt) {
      setCypherHistory((prev) => [
        { cypher: stmt, ts: Date.now() },
        ...prev.filter((h) => h.cypher !== stmt).slice(0, 29),
      ]);
    }
    setShowPlanView(false);
    await onRunCypher(cypherOverride);
  };

  const handleExplainOrProfile = async (mode: 'EXPLAIN' | 'PROFILE') => {
    if (!extDriver.explainCypher || !tab.cypher.trim()) return;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await extDriver.explainCypher(tab.cypher, mode, {
        database: tab.database || undefined,
      });
      setPlanResult(res);
      setShowPlanView(true);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateNode = async () => {
    if (readOnly || !extDriver.createNode) return;
    setBusy(true);
    setLocalError(null);
    try {
      const labels = nodeLabelsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const props = nodePropsJson.trim() ? (JSON.parse(nodePropsJson) as Record<string, unknown>) : {};
      await extDriver.createNode(labels, props, tab.database || undefined);
      setShowCrudPanel(false);
      await onRefreshSchema();
      await recordAndRunCypher();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRelationship = async () => {
    if (readOnly || !extDriver.createRelationship) return;
    if (!relStartId.trim() || !relEndId.trim() || !relTypeInput.trim()) return;
    setBusy(true);
    setLocalError(null);
    try {
      const props = relPropsJson.trim() ? (JSON.parse(relPropsJson) as Record<string, unknown>) : {};
      await extDriver.createRelationship(
        relStartId.trim(),
        relEndId.trim(),
        relTypeInput.trim(),
        props,
        tab.database || undefined,
      );
      setShowCrudPanel(false);
      await onRefreshSchema();
      await recordAndRunCypher();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveNodeProps = async (node: GraphNode) => {
    if (readOnly || !extDriver.updateNode) return;
    setBusy(true);
    setLocalError(null);
    try {
      const props = JSON.parse(editNodePropsJson) as Record<string, unknown>;
      await extDriver.updateNode(node.id, props, {
        replaceAll: editNodeReplaceAll,
        database: tab.database || undefined,
      });
      setEditingNodeId(null);
      await recordAndRunCypher();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteNode = async (node: GraphNode) => {
    if (readOnly || !extDriver.deleteNode) return;
    setBusy(true);
    setLocalError(null);
    try {
      await extDriver.deleteNode(node.id, true, tab.database || undefined);
      setConfirmDeleteNodeId(null);
      onUpdateTab({ selectedNodeId: null });
      await onRefreshSchema();
      await recordAndRunCypher();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteRel = async (rel: GraphRelationship) => {
    if (readOnly || !extDriver.deleteRelationship) return;
    setBusy(true);
    setLocalError(null);
    try {
      await extDriver.deleteRelationship(rel.id, tab.database || undefined);
      await recordAndRunCypher();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const { graphTables, graphRelations, nodeByCardName } = useMemo(() => {
    const nodes = tab.result?.nodes ?? [];
    const rels = tab.result?.relationships ?? [];
    const q = nodeFilter.trim().toLowerCase();

    const filteredNodes = q
      ? nodes.filter(
          (n) =>
            n.id.toLowerCase().includes(q) ||
            n.labels.some((l) => l.toLowerCase().includes(q)) ||
            JSON.stringify(n.properties).toLowerCase().includes(q),
        )
      : nodes;

    const cardNameById = new Map<string, string>();
    const byCard = new Map<string, GraphNode>();

    const tables: PluginErTable[] = filteredNodes.map((n) => {
      const cardName = buildNodeCardName(n);
      cardNameById.set(n.id, cardName);
      byCard.set(cardName, n);
      const propEntries = Object.entries(n.properties).slice(0, 12);
      const columns = [
        {
          name: 'id',
          type: n.id,
          isPk: true,
          isFk: false,
          nullable: false,
        },
        ...propEntries.map(([k, v]) => ({
          name: k,
          type: formatGraphValue(v),
          isPk: false,
          isFk: false,
          nullable: v === null || v === undefined,
        })),
      ];
      return {
        name: cardName,
        schema: n.labels.join(', ') || 'Node',
        columns,
      };
    });

    const relations: PluginErRelation[] = [];
    for (const r of rels) {
      const fromTable = cardNameById.get(r.startNodeId);
      const toTable = cardNameById.get(r.endNodeId);
      if (!fromTable || !toTable) continue;
      relations.push({
        fromTable,
        fromColumn: 'id',
        toTable,
        toColumn: 'id',
        name: `:${r.type}`,
      });
    }

    return { graphTables: tables, graphRelations: relations, nodeByCardName: byCard };
  }, [tab.result, nodeFilter]);

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!tab.selectedNodeId || !tab.result) return null;
    return tab.result.nodes.find((n) => n.id === tab.selectedNodeId) ?? null;
  }, [tab.selectedNodeId, tab.result]);

  const selectedNodeRels: GraphRelationship[] = useMemo(() => {
    if (!selectedNode || !tab.result) return [];
    return tab.result.relationships.filter(
      (r) => r.startNodeId === selectedNode.id || r.endNodeId === selectedNode.id,
    );
  }, [selectedNode, tab.result]);

  const gridColumns: PluginDataGridColumn[] = useMemo(() => {
    const cols = tab.result?.columns ?? [];
    return cols.map((name) => ({
      name,
      type: 'cypher',
    }));
  }, [tab.result]);

  const expandNodeNeighbors = (node: GraphNode) => {
    const numericId = /^\d+$/.test(node.id);
    const cypher = numericId
      ? `MATCH (n)-[r]-(m) WHERE id(n) = ${node.id} OR elementId(n) = '${node.id.replaceAll("'", "\\'")}' RETURN n, r, m LIMIT 50`
      : `MATCH (n)-[r]-(m) WHERE elementId(n) = '${node.id.replaceAll("'", "\\'")}' RETURN n, r, m LIMIT 50`;
    onUpdateTab({ cypher });
    void recordAndRunCypher(cypher);
  };

  const runTemplate = (cypher: string) => {
    onUpdateTab({ cypher });
    void recordAndRunCypher(cypher);
  };

  const schema = tab.schema;
  const nodeCount = tab.result?.nodes.length ?? 0;
  const relCount = tab.result?.relationships.length ?? 0;
  const displayError = localError || tab.error;

  return (
    <div className="ndb-tab-pane">
      <div className="ndb-toolbar ndb-toolbar-wrap">
        <div className="ndb-toolbar-group">
          <span className="ndb-context-chip ndb-mono">
            {`${tab.database || 'neo4j'} (${driver.transportProtocol.toUpperCase()})`}
          </span>
          {readOnly && (
            <span className="ndb-tag ndb-tag-warn">{t('Read-Only')}</span>
          )}
          <button
            type="button"
            className="ndb-btn ndb-btn-primary ndb-btn-sm"
            disabled={tab.running || busy}
            onClick={() => void recordAndRunCypher()}
          >
            <Icon name={tab.running ? 'loader' : 'play'} />
            {t('Run Cypher')}
          </button>
          {extDriver.explainCypher && (
            <>
              <button
                type="button"
                className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                disabled={tab.running || busy}
                onClick={() => void handleExplainOrProfile('EXPLAIN')}
              >
                {'EXPLAIN'}
              </button>
              <button
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                disabled={tab.running || busy}
                onClick={() => void handleExplainOrProfile('PROFILE')}
              >
                {'PROFILE'}
              </button>
            </>
          )}
          {!readOnly && extDriver.createNode && (
            <button
              type="button"
              className={`ndb-btn ndb-btn-xs ${showCrudPanel ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
              onClick={() => setShowCrudPanel((v) => !v)}
            >
              <Icon name="plus" />
              {'Node / Rel'}
            </button>
          )}
          <button
            type="button"
            className={`ndb-btn ndb-btn-xs ${showHistoryBar ? 'ndb-btn-secondary' : 'ndb-btn-ghost'}`}
            onClick={() => setShowHistoryBar((v) => !v)}
          >
            <Icon name="history" />
            {'Snippets & History'}
          </button>
        </div>

        <div className="ndb-spacer" />

        <div className="ndb-toolbar-group">
          <div className="ndb-segmented">
            <button
              type="button"
              className={`ndb-seg-btn${!showPlanView && tab.viewMode === 'graph' ? ' active is-active' : ''}`}
              onClick={() => {
                setShowPlanView(false);
                onUpdateTab({ viewMode: 'graph' });
              }}
            >
              {t('Graph')}
            </button>
            <button
              type="button"
              className={`ndb-seg-btn${!showPlanView && tab.viewMode === 'table' ? ' active is-active' : ''}`}
              onClick={() => {
                setShowPlanView(false);
                onUpdateTab({ viewMode: 'table' });
              }}
            >
              {t('Table')}
            </button>
            <button
              type="button"
              className={`ndb-seg-btn${!showPlanView && tab.viewMode === 'json' ? ' active is-active' : ''}`}
              onClick={() => {
                setShowPlanView(false);
                onUpdateTab({ viewMode: 'json' });
              }}
            >
              {'JSON'}
            </button>
            {planResult && (
              <button
                type="button"
                className={`ndb-seg-btn${showPlanView ? ' active is-active' : ''}`}
                onClick={() => setShowPlanView(true)}
              >
                {planResult.mode}
              </button>
            )}
          </div>
          <button
            type="button"
            className="ndb-icon-btn"
            title={t('Refresh')}
            disabled={tab.running}
            onClick={() => void onRefreshSchema()}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>

      {/* Cypher History & Snippets Bar */}
      {showHistoryBar && (
        <div className="ndb-inline-panel">
          <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
            <span className="ndb-muted">Snippets:</span>
            {[...CYPHER_SNIPPETS, ...customSnippets].map((s, idx) => (
              <button
                key={`${s.title}-${idx}`}
                type="button"
                className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-mono"
                title={s.cypher}
                onClick={() => runTemplate(s.cypher)}
              >
                {s.title}
              </button>
            ))}
            <div className="ndb-spacer" />
            <input
              type="text"
              className="ndb-mono ndb-input-compact"
              placeholder="Save current as snippet..."
              value={newSnippetTitle}
              onChange={(e) => setNewSnippetTitle(e.currentTarget.value)}
            />
            <button
              type="button"
              className="ndb-btn ndb-btn-secondary ndb-btn-xs"
              disabled={!newSnippetTitle.trim() || !tab.cypher.trim()}
              onClick={() => {
                setCustomSnippets((prev) => [
                  ...prev,
                  { title: newSnippetTitle.trim(), cypher: tab.cypher.trim() },
                ]);
                setNewSnippetTitle('');
              }}
            >
              {'Save Snippet'}
            </button>
          </div>
          {cypherHistory.length > 0 && (
            <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px' }}>
              <span className="ndb-muted">{`Recent (${cypherHistory.length}):`}</span>
              {cypherHistory.slice(0, 8).map((h, i) => (
                <button
                  key={i}
                  type="button"
                  className="ndb-tag ndb-tag-clickable ndb-mono"
                  title={h.cypher}
                  onClick={() => onUpdateTab({ cypher: h.cypher })}
                >
                  {h.cypher.length > 42 ? `${h.cypher.slice(0, 39)}...` : h.cypher}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Visual Node / Relationship Create Panel */}
      {showCrudPanel && !readOnly && (
        <div className="ndb-inline-panel">
          <div className="ndb-inline-row" style={{ marginBottom: '6px', gap: '8px' }}>
            <div className="ndb-segmented">
              <button
                type="button"
                className={crudMode === 'createNode' ? 'is-active' : ''}
                onClick={() => setCrudMode('createNode')}
              >
                {'Create Node'}
              </button>
              <button
                type="button"
                className={crudMode === 'createRel' ? 'is-active' : ''}
                onClick={() => {
                  setCrudMode('createRel');
                  if (selectedNode && !relStartId) setRelStartId(selectedNode.id);
                }}
              >
                {'Create Relationship'}
              </button>
            </div>
            <div className="ndb-spacer" />
            <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setShowCrudPanel(false)}>
              {t('Cancel')}
            </button>
          </div>

          {crudMode === 'createNode' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div className="ndb-inline-row" style={{ gap: '6px' }}>
                <input
                  type="text"
                  className="ndb-mono ndb-flex-1"
                  placeholder="Labels (comma-separated, e.g. Person, Engineer)"
                  value={nodeLabelsInput}
                  onChange={(e) => setNodeLabelsInput(e.currentTarget.value)}
                />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-xs"
                  disabled={busy}
                  onClick={() => void handleCreateNode()}
                >
                  {'CREATE Node'}
                </button>
              </div>
              <PluginCodeEditor
                value={nodePropsJson}
                language="json"
                height={90}
                minimap={false}
                onChange={(d) => setNodePropsJson(d.value)}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div className="ndb-inline-row" style={{ gap: '6px' }}>
                <input
                  type="text"
                  className="ndb-mono ndb-input-compact"
                  placeholder="Start Node ID"
                  value={relStartId}
                  onChange={(e) => setRelStartId(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="ndb-mono ndb-input-compact"
                  placeholder="REL_TYPE"
                  value={relTypeInput}
                  onChange={(e) => setRelTypeInput(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="ndb-mono ndb-input-compact"
                  placeholder="End Node ID"
                  value={relEndId}
                  onChange={(e) => setRelEndId(e.currentTarget.value)}
                />
                <button
                  type="button"
                  className="ndb-btn ndb-btn-primary ndb-btn-xs"
                  disabled={busy || !relStartId.trim() || !relEndId.trim() || !relTypeInput.trim()}
                  onClick={() => void handleCreateRelationship()}
                >
                  {'CREATE Rel'}
                </button>
              </div>
              <PluginCodeEditor
                value={relPropsJson}
                language="json"
                height={80}
                minimap={false}
                onChange={(d) => setRelPropsJson(d.value)}
              />
            </div>
          )}
        </div>
      )}

      {schema && (schema.labels.length > 0 || schema.relationshipTypes.length > 0) && (
        <div className="ndb-graph-chips-bar">
          {schema.labels.slice(0, 14).map((item) => (
            <button
              key={`lbl-${item.label}`}
              type="button"
              className="ndb-graph-chip ndb-graph-chip-label ndb-mono"
              title={`MATCH (n:${escapeCypherIdent(item.label)}) RETURN n LIMIT 25`}
              onClick={() =>
                runTemplate(`MATCH (n:${escapeCypherIdent(item.label)}) OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25`)
              }
            >
              {`:${item.label}`}
              {item.count !== undefined ? ` (${item.count})` : ''}
            </button>
          ))}
          {schema.relationshipTypes.slice(0, 10).map((rel) => (
            <button
              key={`rel-${rel}`}
              type="button"
              className="ndb-graph-chip ndb-graph-chip-rel ndb-mono"
              title={`MATCH (a)-[r:${escapeCypherIdent(rel)}]->(b) RETURN a, r, b LIMIT 25`}
              onClick={() =>
                runTemplate(`MATCH (a)-[r:${escapeCypherIdent(rel)}]->(b) RETURN a, r, b LIMIT 25`)
              }
            >
              {`-[:${rel}]->`}
            </button>
          ))}
        </div>
      )}

      {displayError && (
        <div className="ndb-banner ndb-banner-error ndb-banner-inline" role="alert">
          <Icon name="alert-circle" />
          <span>{displayError}</span>
        </div>
      )}

      <div className="ndb-split-host">
        <PluginSplitPane direction="vertical" initialSize={180} minSize={100} maxSize={420}>
          <div className="ndb-editor-pane">
            <PluginCodeEditor
              value={tab.cypher}
              language="sql"
              lineNumbers="on"
              minimap={false}
              wordWrap="on"
              placeholder="MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 25"
              onChange={(detail) => onUpdateTab({ cypher: detail.value })}
              onExecute={() => void recordAndRunCypher()}
              onShortcut={onShortcut}
            />
          </div>

          <div className="ndb-result-pane">
            {showPlanView && planResult ? (
              <div className="ndb-structure-scroll">
                <div className="ndb-inline-row" style={{ marginBottom: '8px', gap: '8px' }}>
                  <strong>{`${planResult.mode} Execution Plan`}</strong>
                  <span className="ndb-tag ndb-mono">{`${planResult.executionMs} ms`}</span>
                  <span className="ndb-tag ndb-mono">{`${planResult.rowCount} rows`}</span>
                  <div className="ndb-spacer" />
                  <button
                    type="button"
                    className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                    onClick={() => setPlanShowRaw((v) => !v)}
                  >
                    {planShowRaw ? 'Plan Tree' : 'Raw JSON'}
                  </button>
                </div>
                {planShowRaw ? (
                  <pre className="ndb-code-pre ndb-mono">
                    {JSON.stringify(planResult.rawPlan ?? planResult, null, 2)}
                  </pre>
                ) : planResult.plan ? (
                  <CypherPlanBranch node={planResult.plan} />
                ) : (
                  <p className="ndb-muted">No plan tree returned by server.</p>
                )}
              </div>
            ) : tab.viewMode === 'graph' ? (
              <div className="ndb-graph-result-wrap">
                <div className="ndb-subtoolbar">
                  <div className="ndb-compact-search">
                    <Icon name="search" />
                    <input
                      type="text"
                      placeholder={t('Filter nodes by label or property...')}
                      value={nodeFilter}
                      onChange={(e) => setNodeFilter(e.currentTarget.value)}
                    />
                  </div>
                  {selectedNode && (
                    <div className="ndb-er-selection">
                      <span className="ndb-tag ndb-mono">
                        {`:${selectedNode.labels.join(':') || 'Node'} #${selectedNode.id}`}
                      </span>
                      <button
                        type="button"
                        className="ndb-btn ndb-btn-secondary ndb-btn-xs"
                        onClick={() => expandNodeNeighbors(selectedNode)}
                      >
                        {t('Expand Neighbors')}
                      </button>
                      {!readOnly && extDriver.updateNode && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() => {
                            setEditingNodeId(selectedNode.id);
                            setEditNodePropsJson(JSON.stringify(selectedNode.properties, null, 2));
                            setEditNodeReplaceAll(false);
                          }}
                        >
                          {'Edit Props'}
                        </button>
                      )}
                      {!readOnly && extDriver.deleteNode && (
                        confirmDeleteNodeId === selectedNode.id ? (
                          <>
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-danger ndb-btn-xs"
                              disabled={busy}
                              onClick={() => void handleDeleteNode(selectedNode)}
                            >
                              {'Confirm DETACH DELETE'}
                            </button>
                            <button
                              type="button"
                              className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                              onClick={() => setConfirmDeleteNodeId(null)}
                            >
                              {t('Cancel')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                            onClick={() => setConfirmDeleteNodeId(selectedNode.id)}
                          >
                            {t('Delete')}
                          </button>
                        )
                      )}
                      {onCopyText && (
                        <button
                          type="button"
                          className="ndb-btn ndb-btn-ghost ndb-btn-xs"
                          onClick={() => onCopyText(JSON.stringify(selectedNode, null, 2), 'Node JSON')}
                        >
                          {t('Copy JSON')}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="ndb-spacer" />
                  <span className="ndb-muted ndb-mono">
                    {`${nodeCount} nodes · ${relCount} relationships`}
                  </span>
                </div>

                {graphTables.length > 0 ? (
                  <div className="ndb-er-host">
                    <PluginErCanvas
                      tables={graphTables}
                      relations={graphRelations}
                      onTableClick={({ table }) => {
                        const hit = nodeByCardName.get(table);
                        onUpdateTab({ selectedNodeId: hit ? hit.id : null });
                      }}
                      onTableDoubleClick={({ table }) => {
                        const hit = nodeByCardName.get(table);
                        if (hit) expandNodeNeighbors(hit);
                      }}
                      onExportSvg={onExportSvg ? ({ svg }) => onExportSvg(svg) : undefined}
                      onShortcut={onShortcut}
                    />
                  </div>
                ) : (
                  <div className="ndb-empty-center">
                    <p className="ndb-muted">
                      {tab.result
                        ? t('Query returned tabular records without graph nodes. Switch to Table or JSON view.')
                        : t('Run a Cypher query returning nodes and relationships to explore the graph.')}
                    </p>
                  </div>
                )}

                {selectedNode && (
                  <div className="ndb-graph-inspector">
                    <div className="ndb-graph-inspector-head">
                      <strong className="ndb-mono">{buildNodeCardName(selectedNode)}</strong>
                      <span className="ndb-muted ndb-mono">
                        {`${Object.keys(selectedNode.properties).length} props · ${selectedNodeRels.length} edges`}
                      </span>
                    </div>
                    {editingNodeId === selectedNode.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <PluginCodeEditor
                          value={editNodePropsJson}
                          language="json"
                          height={120}
                          minimap={false}
                          onChange={(d) => setEditNodePropsJson(d.value)}
                        />
                        <div className="ndb-inline-row" style={{ gap: '8px' }}>
                          <label className="ndb-checkbox-row">
                            <input
                              type="checkbox"
                              checked={editNodeReplaceAll}
                              onChange={(e) => setEditNodeReplaceAll(e.currentTarget.checked)}
                            />
                            <span>Replace all properties (SET =)</span>
                          </label>
                          <div className="ndb-spacer" />
                          <button type="button" className="ndb-btn ndb-btn-ghost ndb-btn-xs" onClick={() => setEditingNodeId(null)}>
                            {t('Cancel')}
                          </button>
                          <button
                            type="button"
                            className="ndb-btn ndb-btn-primary ndb-btn-xs"
                            disabled={busy}
                            onClick={() => void handleSaveNodeProps(selectedNode)}
                          >
                            {'Save Properties'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <pre className="ndb-code-pre ndb-mono">
                          {JSON.stringify(selectedNode.properties, null, 2)}
                        </pre>
                        {selectedNodeRels.length > 0 && !readOnly && extDriver.deleteRelationship && (
                          <div className="ndb-inline-row" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                            {selectedNodeRels.map((rel) => (
                              <span key={rel.id} className="ndb-tag ndb-mono">
                                {`${rel.startNodeId} -[:${rel.type}]-> ${rel.endNodeId}`}
                                <button
                                  type="button"
                                  className="ndb-btn ndb-btn-ghost ndb-btn-xs ndb-text-danger"
                                  disabled={busy}
                                  onClick={() => void handleDeleteRel(rel)}
                                >
                                  {'x'}
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : tab.viewMode === 'table' ? (
              <div className="ndb-grid-host">
                <PluginDataGrid
                  columns={gridColumns}
                  rows={tab.result?.rows ?? []}
                  loading={tab.running}
                  emptyMessage={t('No Cypher rows returned.')}
                  onShortcut={onShortcut}
                />
              </div>
            ) : (
              <div className="ndb-json-scroll">
                <pre className="ndb-code-pre ndb-mono">
                  {JSON.stringify(
                    tab.result
                      ? {
                          columns: tab.result.columns,
                          rowCount: tab.result.rowCount,
                          nodes: tab.result.nodes,
                          relationships: tab.result.relationships,
                          counters: tab.result.counters,
                          rows: tab.result.rows,
                        }
                      : { status: 'Run a Cypher query to see results.' },
                    null,
                    2,
                  )}
                </pre>
              </div>
            )}
          </div>
        </PluginSplitPane>
      </div>

      <div className="ndb-result-strip ndb-mono">
        <span>{`${tab.result?.rowCount ?? 0} rows`}</span>
        <span>{`${nodeCount} nodes`}</span>
        <span>{`${relCount} rels`}</span>
        {tab.result && <span>{`${tab.result.executionMs} ms`}</span>}
        <span className="ndb-spacer" />
        <span className="ndb-muted">
          {t('Click a label chip to browse · Double-click a node card to expand neighbors')}
        </span>
      </div>
    </div>
  );
}
