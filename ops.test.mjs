import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { makePortal } from './portal.mjs';
import { Collector } from './lib/collector.mjs';
import { Ledger } from './lib/ledger.mjs';
import { EvidenceStore } from './lib/evidence.mjs';
import { planMakeup } from './lib/crew.mjs';
import { sheetTrace, handoffList } from './lib/handoff.mjs';

const change = (base, stage) =>
  fetch(`${base}/control?stage=${stage}`, { method: 'POST' }).then((res) => {
    assert.equal(res.status, 200);
  });

async function withServer(t, options = {}) {
  const app = await start(options);
  t.after(() => new Promise((resolve, reject) => app.server.close((e) => (e ? reject(e) : resolve()))));
  return app.url;
}

async function withStateDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'duty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('整轮回放：共享额度选读、待核、施工覆盖、裁定与续领', async (t) => {
  const base = await withServer(t);
  const stateFile = await withStateDir(t);
  const collector = new Collector(base, { stateFile });
  await collector.load();

  // 第 1 轮：额度 3，读 legacy-f7(1) + north-f8(2)。
  let result = await collector.collect();
  assert.deepEqual(result.reads.map((read) => read.id), ['legacy-f7', 'north-f8']);
  assert.equal(collector.store.readLog.reduce((sum, read) => sum + read.cost, 0), 3);

  // 第 2 轮：已取得的块不重读；east-f7(2) + west-f8(1)，S3 齐格签发凭据。
  await change(base, 2);
  result = await collector.collect();
  assert.deepEqual(result.reads.map((read) => read.id), ['east-f7', 'west-f8']);
  let evaluation = collector.evaluate();
  assert.equal(evaluation.sheets.get('S3').ready, true);
  assert.equal(evaluation.sheets.get('S2').ready, false);
  assert.equal(evaluation.sheets.get('S2').cells['S2/A'], 'ok'); // S2/A 未施工，旧证据沿用
  assert.equal(evaluation.sheets.get('S2').cells['S2/B'], 'pending'); // F7/42 误差带跨换架
  const cert = collector.certificates.get('S3');
  assert.equal(cert.time, '11:23');
  assert.deepEqual(
    cert.used.map((used) => used.block).sort(),
    ['north-f8', 'west-f8'],
  );

  // 第 3 轮：relay-f7 覆盖 short-f7 全部序号且多一条，坏包块不花冤枉钱。
  await change(base, 3);
  result = await collector.collect();
  assert.deepEqual(result.reads.map((read) => read.id), ['relay-f7']);
  assert.equal(collector.store.blockRows.has('short-f7'), false);
  evaluation = collector.evaluate();
  assert.equal(evaluation.sheets.get('S2').ready, true); // F7/45、46 补上 S2/B
  assert.equal(collector.certificates.get('S2').time, '11:26');

  // 第 4 轮：clock-7b 收窄 F7/44 误差带转正；G8 完工时刻作废 shared/23 与 S2/B 的旧读数。
  await change(base, 4);
  result = await collector.collect();
  assert.deepEqual(result.reads.map((read) => read.id), ['return-f8']); // alt-f7 序号已在手，不读
  evaluation = collector.evaluate();
  assert.equal(evaluation.sheets.get('S2').cells['S2/A'], 'ok');
  assert.equal(evaluation.sheets.get('S2').cells['shared/23'], 'missing');
  assert.equal(evaluation.sheets.get('S3').ready, false);
  const overturned = evaluation.readings;
  const seq93 = [...overturned.values()].find((ev) => ev.row.seq === 93);
  assert.deepEqual(seq93.reasons, ['during-work']); // 施工期间取得，不能交还
  // 交接后开工：裁判的 O7 与本地凭据都被限用到受影响格。
  const alerts = evaluation.alerts.filter((alert) => alert.type === 'work-after-handoff');
  assert.deepEqual(alerts.map((alert) => alert.handoff), ['O7']);
  assert.deepEqual(alerts[0].cells, ['shared/23']);
  const handoffs = handoffList(collector.ledger, [...collector.certificates.values()], evaluation);
  const localAlerts = handoffs.filter((handoff) => handoff.origin === 'local' && handoff.alerts.length > 0);
  assert.deepEqual(
    localAlerts.map((handoff) => handoff.id).sort(),
    ['LOCAL-S2', 'LOCAL-S3'],
  );
  assert.deepEqual(
    localAlerts.find((handoff) => handoff.id === 'LOCAL-S2').alerts[0].cells.sort(),
    ['S2/B', 'shared/23'],
  );
  // 本地凭据快照不被后来证据改写。
  assert.equal(collector.certificates.get('S3').time, '11:23');

  // 第 5 轮：裁定只点名 F7/45；later-f7 留校时待核；续领视图三分。
  await change(base, 5);
  result = await collector.collect();
  assert.deepEqual(result.reads.map((read) => read.id), ['later-f7']);
  evaluation = collector.evaluate();
  assert.equal(evaluation.groups.get('F7/45').status, 'single'); // 未读 alt-f7，无冲突可裁
  const continuation = collector.continuation();
  assert.equal(continuation.claimable.length, 0); // 能取的都取了，其余已过期
  const pendingSeqs = continuation.pendingReview.map((item) => item.seq).sort();
  assert.deepEqual(pendingSeqs, [42, 46, 47]);

  // 补测安排：两格挡住两条赛道，但所有出勤窗都在 G8 完工前，追不回。
  const makeup = planMakeup(collector.ledger, evaluation, collector.store, 5, collector.now());
  const shared = makeup.tasks.find((task) => task.cell === 'shared/23');
  assert.deepEqual(shared.sheets.sort(), ['S2', 'S3']); // 同一格只占一项现场工作
  assert.equal(shared.schedulable, false);
  assert.equal(makeup.savedSheets.length, 0);
  assert.deepEqual(makeup.lostSheets.map((lost) => lost.sheet).sort(), ['S2', 'S3']);
  const j7 = makeup.jobs.find((job) => job.job === 'J7');
  assert.equal(j7.status, 'released');

  // 双向追溯。
  const trace92 = collector.store.readingTrace('F8', 92, collector.ledger, [
    ...collector.certificates.values(),
  ]);
  assert.deepEqual(trace92.handoffs.sort(), ['LOCAL-S2', 'LOCAL-S3', 'O7']);
  const sheetTraceS2 = sheetTrace('S2', evaluation, collector.ledger);
  assert.equal(sheetTraceS2.cells['shared/23'].status, 'missing');
  assert.match(sheetTraceS2.cells['shared/23'].why, /施工/);

  // 交班接续：新进程读同一状态目录，同一轮不重采。
  const relief = new Collector(base, { stateFile });
  await relief.load();
  const again = await relief.collect();
  assert.equal(again.skipped, true);
  assert.equal(relief.store.groups.has('F7/47'), true);
  assert.equal(relief.certificates.get('S3').time, '11:23');
});

test('坏包扣费可见、摘要不符不入库、额度允许时重试可取回', async (t) => {
  const base = await withServer(t);
  const collector = new Collector(base);
  await change(base, 3);
  await collector.ledger.refresh();
  const catalog = await (await fetch(`${base}/gateway/catalog`)).json();
  const damaged = catalog.blocks.find((block) => block.id === 'short-f7');

  const first = await collector.fetchBlock(3, damaged);
  assert.equal(first.damaged, true);
  assert.equal(first.charged, true); // 坏包也算一次
  assert.equal(collector.store.groups.has('F7/44'), false); // 未校验有效不入库

  // 本轮剩余额度不够再读一次：429 不扣费，进度留档可续领。
  const blocked = await collector.fetchBlock(3, damaged);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.charged, false);
  const log = collector.store.readLog.filter((read) => read.block === 'short-f7');
  assert.equal(log.length, 1);
  assert.equal(log[0].shaOk, false);
  assert.equal(log[0].cost, 2);

  // 额度足够的网关上重试：校验通过才入库。
  const good = JSON.stringify([{ frame: 'F7', seq: 1, cal: 'L1', probe: 'X1', temp: -4.5, time: '10:00' }]);
  const digest = createHash('sha256').update(good).digest('hex');
  let calls = 0;
  const stub = new Collector('http://stub', {
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? good.slice(0, -20) : good, { status: 200 });
    },
  });
  const meta = { id: 'b1', cost: 1, sha256: digest };
  assert.equal((await stub.fetchBlock(1, meta)).damaged, true);
  assert.equal(stub.store.groups.has('F7/1'), false);
  assert.equal((await stub.fetchBlock(1, meta)).damaged, false);
  assert.equal(stub.store.groups.has('F7/1'), true);
});

test('同架同序号冲突：两份留档不交接，裁定只影响点名架和序号', async () => {
  const ledger = new Ledger('http://unused');
  ledger.records.get('probe').push(
    { record: 'c1', availableFrom: 1, kind: 'clock', payload: { frame: 'F7', deviceRange: ['10:00', '12:00'], shiftMinutes: [0, 0] } },
    { record: 'c2', availableFrom: 1, kind: 'clock', payload: { frame: 'F8', deviceRange: ['10:00', '12:00'], shiftMinutes: [0, 0] } },
  );
  ledger.records.get('ice').push(
    { record: 'l1', availableFrom: 1, kind: 'layout', payload: { cal: 'L1', frame: 'F7', points: { X1: 'S2/B' }, valid: ['10:00', '12:00'] } },
    { record: 'l2', availableFrom: 1, kind: 'layout', payload: { cal: 'L2', frame: 'F8', points: { X1: 'S2/A' }, valid: ['10:00', '12:00'] } },
  );
  ledger.records.get('referee').push(
    { record: 'r1', availableFrom: 1, kind: 'rule', payload: { sheet: 'S2', required: ['S2/A', 'S2/B'], tempRange: [-5, -4], freeze: '12:00' } },
    { record: 'h1', availableFrom: 1, kind: 'handoff', payload: { id: 'O9', sheet: 'S2', region: ['S2/B'], time: '11:30', used: [{ frame: 'F7', seq: 45, block: 'blk-b' }] } },
  );
  const store = new EvidenceStore();
  store.addBlockRows('blk-a', [{ frame: 'F7', seq: 45, cal: 'L1', probe: 'X1', temp: -4.5, time: '11:00' }], 1);
  store.addBlockRows('blk-b', [{ frame: 'F7', seq: 45, cal: 'L1', probe: 'X1', temp: -3.5, time: '11:00' }], 1);
  store.addBlockRows('blk-c', [{ frame: 'F8', seq: 9, cal: 'L2', probe: 'X1', temp: -4.4, time: '11:00' }], 1);

  let evaluation = store.evaluate(ledger);
  assert.equal(evaluation.groups.get('F7/45').status, 'conflict');
  assert.equal(evaluation.sheets.get('S2').cells['S2/B'], 'conflict'); // 不能用任一份提前交接
  assert.equal(evaluation.sheets.get('S2').ready, false);
  const trace = store.readingTrace('F7', 45, ledger);
  assert.equal(trace.contents.length, 2); // 两份都能回查
  assert.deepEqual(trace.handoffs, ['O9']);

  // 裁定点名 F7/45：采用 blk-a；F8/9 不受影响。
  ledger.records.get('probe').push({
    record: 'res', availableFrom: 2, kind: 'resolution',
    payload: { frame: 'F7', seq: 45, acceptedBlock: 'blk-a' },
  });
  evaluation = store.evaluate(ledger);
  assert.equal(evaluation.groups.get('F7/45').status, 'resolved');
  assert.equal(evaluation.sheets.get('S2').cells['S2/B'], 'ok');
  assert.equal(evaluation.sheets.get('S2').cells['S2/A'], 'ok');
  assert.equal(evaluation.sheets.get('S2').ready, true);
  // 裁定推翻了 O9 当时采用的 blk-b。
  const overturn = evaluation.alerts.find((alert) => alert.type === 'reading-overturned');
  assert.equal(overturn.handoff, 'O9');
  assert.equal(overturn.acceptedBlock, 'blk-a');
});

test('补测排班：最早截止优先、共享格占一项、容量与取消建议', async () => {
  const ledger = new Ledger('http://unused');
  ledger.records.get('ice').push(
    { record: 'w1', availableFrom: 1, kind: 'crewWindow', payload: { window: 'W1', crew: 'north', windowTime: ['10:00', '10:25'], cells: ['A', 'B', 'C'], capacity: 2 } },
    { record: 'w2', availableFrom: 1, kind: 'crewWindow', payload: { window: 'W2', crew: 'south', windowTime: ['10:00', '10:35'], cells: ['A', 'B'], capacity: 1 } },
    { record: 'j1', availableFrom: 1, kind: 'job', payload: { job: 'J1', window: 'W2', cells: ['A'], status: 'accepted', time: '10:01' } },
  );
  ledger.records.get('referee').push(
    { record: 'sa', availableFrom: 1, kind: 'rule', payload: { sheet: 'SA', required: ['A', 'B'], tempRange: [-5, -4], freeze: '10:30' } },
    { record: 'sb', availableFrom: 1, kind: 'rule', payload: { sheet: 'SB', required: ['B', 'C'], tempRange: [-5, -4], freeze: '10:20' } },
  );
  const store = new EvidenceStore();
  const sheets = new Map();
  for (const rule of ledger.rules()) {
    sheets.set(rule.sheet, {
      sheet: rule.sheet, freeze: rule.freeze, tempRange: rule.tempRange,
      ready: false, cells: {}, missing: [...rule.required], pending: [], ambiguous: [],
      outOfStandard: [], evidence: {},
    });
  }
  const evaluation = { sheets, cells: new Map() };
  const plan = planMakeup(ledger, evaluation, store, 1, 10 * 60);

  // SB 截止 10:20，没有窗能在截止前收工 → 追不回，且不为它花窗。
  assert.deepEqual(plan.lostSheets.map((lost) => lost.sheet), ['SB']);
  // SA 的 A、B 都进 W1（容量 2）；共享格 B 只占一项。
  assert.deepEqual(plan.savedSheets, ['SA']);
  const assigned = new Map(plan.assignments.map((entry) => [entry.cell, entry.window]));
  assert.equal(assigned.get('A'), 'W1');
  assert.equal(assigned.get('B'), 'W1');
  assert.equal(plan.assignments.length, 2);
  // J1 占着 W2，未释放不能另派；A 格无电子证据，不建议取消。
  const j1 = plan.jobs.find((job) => job.job === 'J1');
  assert.equal(j1.cancelRecommended, false);
});

test('门户路由：总览、逐格、待核、续领、凭据', async (t) => {
  const base = await withServer(t, { portal: makePortal() });
  // 冷启动直接进第 2 轮：3 点额度只够保住 S3，F7 即将到期的块只能放弃。
  await change(base, 2);
  const overview = await (await fetch(`${base}/ops/overview`)).json();
  assert.equal(overview.stage, 2);
  assert.equal(overview.sheets.find((sheet) => sheet.sheet === 'S3').ready, true);
  assert.equal(overview.sheets.find((sheet) => sheet.sheet === 'S2').ready, false);
  const sheet2 = await (await fetch(`${base}/ops/sheet?name=S2`)).json();
  assert.equal(sheet2.view.cells['S2/A'].status, 'missing'); // 本轮额度没轮到 F7

  // 第 3 轮 relay-f7 补上 44–46，S2 齐格。
  await change(base, 3);
  const sheet3 = await (await fetch(`${base}/ops/sheet?name=S2`)).json();
  assert.equal(sheet3.view.ready, true);

  // 第 4 轮 G8 作废旧读数：待核清单可见额度占用与原因，凭据附限用提醒。
  await change(base, 4);
  const pending = await (await fetch(`${base}/ops/pending`)).json();
  const item46 = pending.items.find((item) => item.frame === 'F7' && item.seq === 46);
  assert.ok(item46);
  assert.ok(item46.creditsSpent > 0); // 占用额度可见
  assert.match(item46.reasons.join(), /完工时刻/);
  const reading = await (await fetch(`${base}/ops/reading?frame=F8&seq=92`)).json();
  assert.deepEqual(reading.handoffs.sort(), ['LOCAL-S2', 'LOCAL-S3', 'O7']);
  const handoffs = await (await fetch(`${base}/ops/handoffs`)).json();
  const local = handoffs.handoffs.filter((handoff) => handoff.origin === 'local');
  assert.ok(local.every((handoff) => handoff.alerts.length > 0)); // G8 限用提醒
  const continuation = await (await fetch(`${base}/ops/continuation`)).json();
  assert.ok(continuation.pendingReview.some((item) => item.seq === 46));
  const missing = await fetch(`${base}/ops/sheet?name=SX`);
  assert.equal(missing.status, 404);
});
