// 赛务台/值班员门户：挂在来源服务上（index.json 里 "portal": true 时 npm start 自动加载）。
// 所有路由只读 JSON；首次访问某轮时自动按共享额度策略完成该轮采集。

import { Collector } from './lib/collector.mjs';
import { planMakeup } from './lib/crew.mjs';
import { sheetView, sheetTrace, handoffList, allAlerts, reasonText } from './lib/handoff.mjs';

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function makePortal() {
  let collector = null;

  const ensure = async (request) => {
    if (!collector) {
      collector = new Collector(`http://${request.headers.host}`);
      await collector.load();
    }
    await collector.collect(); // 同一轮重复调用是空操作
    return collector;
  };

  const routes = {
    '/ops/overview': async () => {
      const evaluation = collector.evaluate();
      const catalog = collector.store.catalogs.get(collector.stage);
      return {
        stage: collector.stage,
        round: catalog ? { open: catalog.open, close: catalog.close, remaining: catalog.remaining } : null,
        sheets: [...evaluation.sheets.values()].map((sheet) => ({
          sheet: sheet.sheet,
          freeze: sheet.freeze,
          ready: sheet.ready,
          cells: sheet.cells,
        })),
        certificates: [...collector.certificates.values()],
        alerts: allAlerts(collector.ledger, [...collector.certificates.values()], evaluation),
        spent: collector.store.readLog,
      };
    },
    '/ops/sheet': async (url) => {
      const name = url.searchParams.get('name');
      const evaluation = collector.evaluate();
      const view = sheetView(name, evaluation);
      if (!view) return { http: 404, body: { error: '未知赛道' } };
      return { view, trace: sheetTrace(name, evaluation, collector.ledger) };
    },
    '/ops/reading': async (url) => {
      const frame = url.searchParams.get('frame');
      const seq = Number(url.searchParams.get('seq'));
      return collector.store.readingTrace(
        frame,
        seq,
        collector.ledger,
        [...collector.certificates.values()],
      );
    },
    '/ops/makeup': async () => {
      const evaluation = collector.evaluate();
      return planMakeup(
        collector.ledger,
        evaluation,
        collector.store,
        collector.stage,
        collector.now(),
      );
    },
    '/ops/pending': async () => {
      const evaluation = collector.evaluate();
      const spentByBlock = new Map();
      for (const read of collector.store.readLog) {
        spentByBlock.set(read.block, (spentByBlock.get(read.block) ?? 0) + read.cost);
      }
      const items = [];
      for (const group of evaluation.groups.values()) {
        for (const content of group.contents) {
          const ev = content.ev;
          if (ev.usable && group.status !== 'conflict') continue;
          const blocks = content.sources.map((source) => source.block);
          items.push({
            frame: group.frame,
            seq: group.seq,
            temp: content.row.temp,
            cell: ev.cell,
            blocks,
            creditsSpent: blocks.reduce((sum, block) => sum + (spentByBlock.get(block) ?? 0), 0),
            reasons:
              group.status === 'conflict'
                ? ['同架同序号内容冲突，等来源裁定']
                : ev.reasons.map(reasonText),
          });
        }
      }
      return { items };
    },
    '/ops/continuation': async () => collector.continuation(),
    '/ops/handoffs': async () => {
      const evaluation = collector.evaluate();
      return {
        handoffs: handoffList(
          collector.ledger,
          [...collector.certificates.values()],
          evaluation,
        ),
      };
    },
  };

  return async (request, response, url) => {
    if (!url.pathname.startsWith('/ops/')) return false;
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '门户只支持读取' });
      return true;
    }
    const route = routes[url.pathname];
    if (!route) {
      sendJson(response, 404, { error: '未知门户路由' });
      return true;
    }
    await ensure(request);
    const result = await route(url);
    if (result && result.http) sendJson(response, result.http, result.body);
    else sendJson(response, 200, result);
    return true;
  };
}
