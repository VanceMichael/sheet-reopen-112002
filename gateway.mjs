import { createHash } from 'node:crypto';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function gateway(feed, sendJson) {
  const spent = new Map();
  const attempts = new Map();
  return (request, response, url, stage) => {
    if (request.method !== 'GET') return false;
    const slot = feed.rounds.find((round) => round.stage === stage);
    const remaining = slot.credits - (spent.get(stage) ?? 0);
    if (url.pathname === '/gateway/catalog') {
      const blocks = slot.blocks.map((id) => {
        const { frame, first, last, cost, expires, rows } = feed.blocks[id];
        return { id, frame, first, last, cost, expires, sha256: sha256(JSON.stringify(rows)) };
      });
      sendJson(response, 200, { round: stage, open: slot.open, close: slot.close, remaining, blocks });
      return true;
    }

    const match = /^\/gateway\/blocks\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!match) return false;
    const id = match[1];
    const block = feed.blocks[id];
    if (!block || !slot.blocks.includes(id)) {
      const expired = block && stage > block.expires;
      sendJson(response, expired ? 410 : 404, { reason: expired ? '缓冲已过写' : '本轮没有此缓冲段' });
      return true;
    }
    if (block.cost > remaining) {
      sendJson(response, 429, { round: stage, remaining });
      return true;
    }

    spent.set(stage, (spent.get(stage) ?? 0) + block.cost);
    const key = `${stage}/${id}`;
    const count = attempts.get(key) ?? 0;
    attempts.set(key, count + 1);
    const body = block.damagedIn === stage && count === 0 ? JSON.stringify(block.rows.slice(0, -1)) : JSON.stringify(block.rows);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(body);
    return true;
  };
}
