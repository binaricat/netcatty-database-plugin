/**
 * Evidence.dev-inspired BI Report Exporters (Markdown + JSON).
 */

import { formatCellCategory } from './autoChart';
import type { BiAnalysisCard } from './types';

function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function exportBiReportMarkdown(opts: {
  connectionName: string;
  database: string;
  cards: BiAnalysisCard[];
  locale?: string;
}): string {
  const isZh = (opts.locale ?? 'en').toLowerCase().startsWith('zh');
  const now = new Date().toISOString();
  const lines: string[] = [
    `# ${isZh ? 'BI 分析报告' : 'BI Analytics Report'} — ${opts.connectionName}`,
    '',
    `- **${isZh ? '数据库' : 'Database'}**: \`${opts.database || 'default'}\``,
    `- **${isZh ? '生成时间' : 'Generated'}**: ${now}`,
    `- **${isZh ? '分析卡片数' : 'Charts'}**: ${opts.cards.length}`,
    '',
  ];

  for (const [idx, card] of opts.cards.entries()) {
    lines.push(`---`, '', `## ${idx + 1}. ${card.title}`, '');
    if (card.description) {
      lines.push(card.description, '');
    }

    if (card.kpis.length > 0) {
      lines.push(`### ${isZh ? '关键指标' : 'Key Metrics'}`, '');
      lines.push(`| ${isZh ? '指标' : 'Metric'} | ${isZh ? '数值' : 'Value'} | ${isZh ? '说明' : 'Context'} |`);
      lines.push('| --- | ---: | --- |');
      for (const kpi of card.kpis) {
        lines.push(`| ${escapeMdCell(kpi.label)} | ${escapeMdCell(kpi.formattedValue)} | ${escapeMdCell(kpi.subtext ?? '')} |`);
      }
      lines.push('');
    }

    if (card.insights.length > 0) {
      lines.push(`### ${isZh ? '核心洞察' : 'Executive Insights'}`, '');
      for (const bullet of card.insights) {
        lines.push(`- ${bullet}`);
      }
      lines.push('');
    }

    lines.push(`### SQL (${card.chartConfig.type})`, '', '```sql', card.sql.trim(), '```', '');

    if (card.result && card.result.columns.length > 0 && card.result.rows.length > 0) {
      const previewRows = card.result.rows.slice(0, 20);
      lines.push(
        `### ${isZh ? '数据预览' : 'Data Preview'} (${previewRows.length}/${card.result.rowCount})`,
        '',
      );
      lines.push(`| ${card.result.columns.map((c) => escapeMdCell(c.name)).join(' | ')} |`);
      lines.push(`| ${card.result.columns.map(() => '---').join(' | ')} |`);
      for (const row of previewRows) {
        lines.push(`| ${card.result.columns.map((_, i) => escapeMdCell(formatCellCategory(row[i]))).join(' | ')} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function exportBiDashboardJson(opts: {
  connectionName: string;
  database: string;
  cards: BiAnalysisCard[];
}): string {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    connectionName: opts.connectionName,
    database: opts.database,
    cards: opts.cards.map(({ result, loading, error, repaired, ...persisted }) => ({
      ...persisted,
      rowCount: result?.rowCount ?? 0,
      columns: result?.columns.map((c) => c.name) ?? [],
    })),
  };
  return JSON.stringify(payload, null, 2);
}
