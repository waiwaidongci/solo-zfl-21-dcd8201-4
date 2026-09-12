"use strict";

// 可执行测试：node --test
//   正常 / 边界 / 连续越限告警 / 重复提交幂等 / 非法输入 / 告警不可改 / 重启持久化

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { createApp, classifyRetest, validateThresholds, VIOLATION } = require("./server");

let dbCounter = 0;
function tempDbFile() {
  dbCounter += 1;
  return path.join(os.tmpdir(), `clock-test-${process.pid}-${dbCounter}.json`);
}

async function startServer(dbFile = tempDbFile()) {
  const server = createApp(dbFile);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dbFile,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function api(base, method, pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// 直接发送原始字符串，用于构造零字节空体、null 等非法请求体
async function postRaw(base, pathname, raw) {
  const res = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createClock(base, overrides = {}) {
  const res = await api(base, "POST", "/clocks", {
    code: `CLK-T-${dbCounter}-${Math.random().toString(36).slice(2, 6)}`,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20,
    amplitudeFloor: 240,
    amplitudeCeiling: 320,
    ...overrides
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function retest(base, clockId, payload, headers) {
  return api(base, "POST", `/clocks/${clockId}/retests`, payload, headers);
}

test("健康检查返回路由清单", async () => {
  const srv = await startServer();
  try {
    const res = await api(srv.base, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.routes.some((route) => route.startsWith("GET /alerts")));
  } finally {
    await srv.close();
  }
});

test("正常流程：合格复测不产生告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    const res = await retest(srv.base, clock.id, { dailyRateSeconds: 10, amplitude: 280 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.qualified, true);
    assert.deepEqual(res.body.data.violations, []);
    assert.deepEqual(res.body.alerts, []);
    assert.equal(res.body.duplicate, false);

    const alerts = await api(srv.base, "GET", "/alerts");
    assert.deepEqual(alerts.body.data, []);

    const summary = await api(srv.base, "GET", `/clocks/${clock.id}/history`);
    assert.equal(summary.body.data.clock.targetDailyRateSeconds, 20);
    assert.equal(summary.body.data.clock.amplitudeFloor, 240);
    assert.equal(summary.body.data.clock.amplitudeCeiling, 320);
  } finally {
    await srv.close();
  }
});

test("边界：日差与摆幅恰好等于阈值视为合格（闭区间）", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base); // ±20 s/日，240°–320°
    for (const [dailyRateSeconds, amplitude] of [
      [20, 240],   // 日差上限、摆幅下限
      [-20, 320],  // 日差下限、摆幅上限
      [0, 280]
    ]) {
      const res = await retest(srv.base, clock.id, { dailyRateSeconds, amplitude, testedAt: "2026-07-01T08:00:00Z" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.qualified, true, `日差${dailyRateSeconds} 摆幅${amplitude} 应合格`);
    }
    // 越界一点点即不合格
    const over = await retest(srv.base, clock.id, { dailyRateSeconds: 20.01, amplitude: 320.01, testedAt: "2026-07-02T08:00:00Z" });
    assert.equal(over.body.data.qualified, false);
    assert.deepEqual(over.body.data.violations.sort(), [VIOLATION.AMPLITUDE_HIGH, VIOLATION.RATE_HIGH].sort());
  } finally {
    await srv.close();
  }
});

test("连续两次同一方向越限才生成待处理告警，仅一次不告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    const first = await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    assert.deepEqual(first.body.data.violations, [VIOLATION.RATE_HIGH]);
    assert.deepEqual(first.body.alerts, []);

    const second = await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    assert.equal(second.body.alerts.length, 1);
    assert.equal(second.body.alerts[0].direction, VIOLATION.RATE_HIGH);

    const pending = await api(srv.base, "GET", "/alerts?status=pending");
    assert.equal(pending.body.data.length, 1);
    const alert = pending.body.data[0];
    assert.equal(alert.status, "pending");
    assert.equal(alert.clockId, clock.id);
    assert.equal(alert.measured.dailyRateSeconds, 26);
    assert.equal(alert.thresholds.targetDailyRateSeconds, 20);
    assert.match(alert.detail, /偏快/);
  } finally {
    await srv.close();
  }
});

test("待处理告警存在期间，继续同方向越限不会重复生成告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    const third = await retest(srv.base, clock.id, { dailyRateSeconds: 27, amplitude: 280, testedAt: "2026-07-03T08:00:00Z" });
    assert.deepEqual(third.body.alerts, []);

    const pending = await api(srv.base, "GET", `/clocks/${clock.id}/alerts?status=pending`);
    assert.equal(pending.body.data.length, 1);
  } finally {
    await srv.close();
  }
});

test("方向切换不满足“同一方向连续两次”，不生成告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    // 先偏快，再偏慢
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    const slow = await retest(srv.base, clock.id, { dailyRateSeconds: -25, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    assert.deepEqual(slow.body.data.violations, [VIOLATION.RATE_LOW]);
    assert.deepEqual(slow.body.alerts, []);

    // 中间夹一次合格，连续性中断
    await retest(srv.base, clock.id, { dailyRateSeconds: 5, amplitude: 280, testedAt: "2026-07-03T08:00:00Z" });
    const again = await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-04T08:00:00Z" });
    assert.deepEqual(again.body.alerts, []);
  } finally {
    await srv.close();
  }
});

test("日差与摆幅同时越限：连续两次后每个方向各一条告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 30, amplitude: 200, testedAt: "2026-07-01T08:00:00Z" });
    const second = await retest(srv.base, clock.id, { dailyRateSeconds: 31, amplitude: 199, testedAt: "2026-07-02T08:00:00Z" });
    const directions = second.body.alerts.map((alert) => alert.direction).sort();
    assert.deepEqual(directions, [VIOLATION.AMPLITUDE_LOW, VIOLATION.RATE_HIGH]);

    const all = await api(srv.base, "GET", `/clocks/${clock.id}/alerts`);
    assert.equal(all.body.data.length, 2);
  } finally {
    await srv.close();
  }
});

test("幂等键重复提交返回同一复测且不产生重复告警（含并发）", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    const payload = { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z", idempotencyKey: "ticket-001" };
    const first = await retest(srv.base, clock.id, payload);
    assert.equal(first.status, 201);

    const second = await retest(srv.base, clock.id, { ...payload, dailyRateSeconds: 99, note: "篡改数值也应被拒绝" });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(second.body.data.dailyRateSeconds, 25);

    // 也支持 Idempotency-Key 请求头
    const headerWay = await retest(
      srv.base,
      clock.id,
      { dailyRateSeconds: 12, amplitude: 280, testedAt: "2026-07-03T08:00:00Z" },
      { "Idempotency-Key": "ticket-002" }
    );
    const headerRetry = await retest(
      srv.base,
      clock.id,
      { dailyRateSeconds: 13, amplitude: 280, testedAt: "2026-07-03T08:00:00Z" },
      { "Idempotency-Key": "ticket-002" }
    );
    assert.equal(headerRetry.body.duplicate, true);
    assert.equal(headerRetry.body.data.id, headerWay.body.data.id);

    // 并发双发同一幂等键：只允许落一条
    const racePayload = { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-04T08:00:00Z", idempotencyKey: "race-key" };
    const [a, b] = await Promise.all([retest(srv.base, clock.id, racePayload), retest(srv.base, clock.id, racePayload)]);
    assert.equal(a.body.data.id, b.body.data.id);
    assert.equal([a.status, b.status].filter((code) => code === 201).length, 1);

    const list = await api(srv.base, "GET", `/clocks/${clock.id}/history`);
    const keys = list.body.data.retests.map((item) => item.id);
    assert.equal(new Set(keys).size, keys.length, "复测记录无重复");
  } finally {
    await srv.close();
  }
});

test("无幂等键时，同一次复测的重复内容提交同样不重复受理", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    const payload = { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z", note: "表单双击提交" };
    const first = await retest(srv.base, clock.id, payload);
    const second = await retest(srv.base, clock.id, payload);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.data.id, first.body.data.id);
  } finally {
    await srv.close();
  }
});

test("告警触发后重复提交第二条复测，不会再补一条告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    const secondPayload = { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z", idempotencyKey: "trigger" };
    const second = await retest(srv.base, clock.id, secondPayload);
    assert.equal(second.body.alerts.length, 1);
    // 网络重试
    const retry = await retest(srv.base, clock.id, secondPayload);
    assert.equal(retry.body.duplicate, true);
    assert.deepEqual(retry.body.alerts, []);

    const pending = await api(srv.base, "GET", `/clocks/${clock.id}/alerts?status=pending`);
    assert.equal(pending.body.data.length, 1);
  } finally {
    await srv.close();
  }
});

test("非法输入返回 400 且不写库", async () => {
  const srv = await startServer();
  try {
    const badClocks = [
      { body: { code: "C1", escapementType: "x", balanceFrequency: "18000vph", amplitudeFloor: 300, amplitudeCeiling: 200 }, msg: /下限不能大于上限/ },
      { body: { code: "C2", escapementType: "x", balanceFrequency: "18000vph", targetDailyRateSeconds: -1 }, msg: /不能为负/ },
      { body: { code: "C3", escapementType: "x", balanceFrequency: "18000vph", amplitudeFloor: "abc" }, msg: /必须都是数字/ },
      { body: { code: "C4", escapementType: "x", balanceFrequency: "18000vph", amplitudeCeiling: 400 }, msg: /不能超过 360/ }
    ];
    for (const { body, msg } of badClocks) {
      const res = await api(srv.base, "POST", "/clocks", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, msg);
    }

    const clock = await createClock(srv.base);
    const missing = await retest(srv.base, clock.id, { dailyRateSeconds: 10 });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /amplitude/);

    const notNumber = await retest(srv.base, clock.id, { dailyRateSeconds: "快", amplitude: 280 });
    assert.equal(notNumber.status, 400);
    const boolAsNumber = await retest(srv.base, clock.id, { dailyRateSeconds: true, amplitude: 280 });
    assert.equal(boolAsNumber.status, 400);
    const ampOutOfRange = await retest(srv.base, clock.id, { dailyRateSeconds: 0, amplitude: 999 });
    assert.equal(ampOutOfRange.status, 400);
    const badTime = await retest(srv.base, clock.id, { dailyRateSeconds: 0, amplitude: 280, testedAt: "not-a-date" });
    assert.equal(badTime.status, 400);
    const badAdjustment = await retest(srv.base, clock.id, { dailyRateSeconds: 0, amplitude: 280, adjustmentId: "nope" });
    assert.equal(badAdjustment.status, 400);

    // 非法 JSON
    const raw = await fetch(`${srv.base}/clocks/${clock.id}/retests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ broken json"
    });
    assert.equal(raw.status, 400);

    // 不存在的钟表
    const missingClock = await retest(srv.base, "ghost", { dailyRateSeconds: 0, amplitude: 280 });
    assert.equal(missingClock.status, 404);

    // PUT 阈值非法
    const badPut = await api(srv.base, "PUT", `/clocks/${clock.id}/thresholds`, { targetDailyRateSeconds: 10, amplitudeFloor: 300, amplitudeCeiling: 200 });
    assert.equal(badPut.status, 400);

    // 所有失败请求都没有落复测
    const history = await api(srv.base, "GET", `/clocks/${clock.id}/history`);
    assert.equal(history.body.data.retests.length, 0);
  } finally {
    await srv.close();
  }
});

test("三个写接口拒绝空请求体与 JSON null，且不新增任何记录", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    // 造一条已处理告警，用于取处理接口路径
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-08-01T08:00:00Z" });
    await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-08-02T08:00:00Z" });
    const alertId = (await api(srv.base, "GET", "/alerts")).body.data[0].id;

    const before = await api(srv.base, "GET", "/clocks");
    const beforeClocks = before.body.data.length;
    const beforeHistory = await api(srv.base, "GET", `/clocks/${clock.id}/history`);
    const beforeRetests = beforeHistory.body.data.retests.length;
    const beforeAlerts = (await api(srv.base, "GET", "/alerts?status=all")).body.data.length;

    // 1) POST /clocks：零字节空体 / null / 非对象
    for (const raw of ["", "   ", "null", "[]", "42", "\"x\""]) {
      const res = await postRaw(srv.base, "/clocks", raw);
      assert.equal(res.status, 400, `POST /clocks 体=${JSON.stringify(raw)} 应 400`);
      assert.match(res.body.error, /请求体|JSON 对象/);
    }
    // {} 属于缺少必填字段，同样 400 且不落库
    const emptyObj = await api(srv.base, "POST", "/clocks", {});
    assert.equal(emptyObj.status, 400);

    // 2) POST /clocks/:id/retests：零字节空体 / null
    for (const raw of ["", "null"]) {
      const res = await postRaw(srv.base, `/clocks/${clock.id}/retests`, raw);
      assert.equal(res.status, 400, `retests 体=${JSON.stringify(raw)} 应 400`);
      assert.match(res.body.error, /请求体/);
    }
    // 不存在的钟表 + null 也必须 400（不能 404/500 之外的行为）
    const nullOnGhost = await postRaw(srv.base, "/clocks/ghost/retests", "null");
    assert.equal(nullOnGhost.status, 400);

    // 3) POST /alerts/:id/handle：零字节空体 / null
    for (const raw of ["", "null"]) {
      const res = await postRaw(srv.base, `/alerts/${alertId}/handle`, raw);
      assert.equal(res.status, 400, `handle 体=${JSON.stringify(raw)} 应 400`);
      assert.match(res.body.error, /请求体/);
    }

    // 确认没有新增钟表、复测、告警，告警仍处于 pending
    const after = await api(srv.base, "GET", "/clocks");
    assert.equal(after.body.data.length, beforeClocks);
    const afterHistory = await api(srv.base, "GET", `/clocks/${clock.id}/history`);
    assert.equal(afterHistory.body.data.retests.length, beforeRetests);
    assert.equal((await api(srv.base, "GET", "/alerts?status=all")).body.data.length, beforeAlerts);
    const stillPending = await api(srv.base, "GET", `/alerts/${alertId}`);
    assert.equal(stillPending.body.data.status, "pending");
    assert.equal(stillPending.body.data.handling, null);

    // 成功路径：同一告警可正常处理（说明 400 只针对非法请求体，没有误伤正常流程）
    const ok = await api(srv.base, "POST", `/alerts/${alertId}/handle`, { handledBy: "王师傅" });
    assert.equal(ok.status, 201);
    const handled = await api(srv.base, "GET", `/alerts/${alertId}`);
    assert.equal(handled.body.data.status, "handled");
  } finally {
    await srv.close();
  }
});

test("空体拦截不误伤成功路径：建钟与复测正常 201", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base, { targetDailyRateSeconds: 12 });
    const ok = await retest(srv.base, clock.id, { dailyRateSeconds: 8, amplitude: 275, testedAt: "2026-08-09T08:00:00Z" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.qualified, true);

    // 合法 JSON 对象（含空对象走告警处理）不应被 parseBody 拦
    await retest(srv.base, clock.id, { dailyRateSeconds: 30, amplitude: 280, testedAt: "2026-08-10T08:00:00Z" });
    const b = await retest(srv.base, clock.id, { dailyRateSeconds: 31, amplitude: 280, testedAt: "2026-08-11T08:00:00Z" });
    assert.equal(b.body.alerts.length, 1);
    const alertId = b.body.alerts[0].id;
    const handleEmptyObj = await api(srv.base, "POST", `/alerts/${alertId}/handle`, {});
    assert.equal(handleEmptyObj.status, 201);
  } finally {
    await srv.close();
  }
});

test("调校接口：三字段为 null、空值、非法类型均拒绝且不写调校记录", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    const count = () =>
      api(srv.base, "GET", `/adjustments?clockId=${clock.id}`).then((res) => res.body.data.length);
    const before = await count();

    const base = { currentDailyRateSeconds: 68, direction: "慢针方向", amount: "向慢侧微调0.4格" };
    const invalidBodies = [
      // direction：缺失 / null / 空白串 / 数字 / 布尔 / 数组 / 对象
      { patch: { direction: undefined }, field: /direction|缺少字段/ },
      { patch: { direction: null }, field: /direction/ },
      { patch: { direction: "" }, field: /direction/ },
      { patch: { direction: "   " }, field: /direction/ },
      { patch: { direction: 123 }, field: /direction/ },
      { patch: { direction: true }, field: /direction/ },
      { patch: { direction: ["慢针方向"] }, field: /direction/ },
      { patch: { direction: { x: 1 } }, field: /direction/ },
      // amount：缺失 / null / 空白串 / 数字 / 布尔
      { patch: { amount: undefined }, field: /amount|缺少字段/ },
      { patch: { amount: null }, field: /amount/ },
      { patch: { amount: "" }, field: /amount/ },
      { patch: { amount: "\t\n" }, field: /amount/ },
      { patch: { amount: 42 }, field: /amount/ },
      { patch: { amount: false }, field: /amount/ },
      // currentDailyRateSeconds（走时误差）：缺失 / null / 空串 / 非数字文本 / 布尔 / 对象
      { patch: { currentDailyRateSeconds: undefined }, field: /currentDailyRateSeconds|缺少字段/ },
      { patch: { currentDailyRateSeconds: null }, field: /currentDailyRateSeconds/ },
      { patch: { currentDailyRateSeconds: "" }, field: /currentDailyRateSeconds|缺少字段/ },
      { patch: { currentDailyRateSeconds: "很快" }, field: /currentDailyRateSeconds/ },
      { patch: { currentDailyRateSeconds: true }, field: /currentDailyRateSeconds/ },
      { patch: { currentDailyRateSeconds: {} }, field: /currentDailyRateSeconds/ },
      // note 给了就必须是字符串
      { patch: { note: 123 }, field: /note/ }
    ];

    for (const { patch, field } of invalidBodies) {
      const body = { ...base, ...patch };
      const res = await api(srv.base, "POST", `/clocks/${clock.id}/adjustments`, body);
      assert.equal(res.status, 400, `非法调校 ${JSON.stringify(patch)} 应 400，实际：${JSON.stringify(res.body)}`);
      assert.match(res.body.error, field);
      assert.equal(await count(), before, `非法调校 ${JSON.stringify(patch)} 不得写入记录`);
    }

    // 空体 / null 同样 400 且不落库
    for (const raw of ["", "null"]) {
      const res = await postRaw(srv.base, `/clocks/${clock.id}/adjustments`, raw);
      assert.equal(res.status, 400);
      assert.equal(await count(), before);
    }

    // 不存在的钟表：合法请求体也 404，不产生游离调校记录
    const globalBefore = (await api(srv.base, "GET", "/adjustments")).body.data.length;
    const ghost = await api(srv.base, "POST", "/clocks/ghost/adjustments", base);
    assert.equal(ghost.status, 404);
    assert.equal((await api(srv.base, "GET", "/adjustments")).body.data.length, globalBefore);

    // 成功路径：数字字符串可转数值；字符串字段自动去首尾空白
    const ok = await api(srv.base, "POST", `/clocks/${clock.id}/adjustments`, {
      currentDailyRateSeconds: "68.5",
      direction: "  慢针方向  ",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "  初次调校，先保守处理 "
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.currentDailyRateSeconds, 68.5);
    assert.equal(ok.body.data.direction, "慢针方向");
    assert.equal(ok.body.data.amount, "游丝快慢针向慢侧微调0.4格");
    assert.equal(ok.body.data.note, "初次调校，先保守处理");
    assert.equal(ok.body.data.clockId, clock.id);
    assert.equal(await count(), before + 1);

    // 负走时误差（偏慢）也是合法数字
    const negative = await api(srv.base, "POST", `/clocks/${clock.id}/adjustments`, {
      currentDailyRateSeconds: -12,
      direction: "快针方向",
      amount: "向快侧回调0.2格"
    });
    assert.equal(negative.status, 201);
    assert.equal(negative.body.data.currentDailyRateSeconds, -12);
    assert.equal(await count(), before + 2);
  } finally {
    await srv.close();
  }
});

test("PUT 阈值后按新阈值验收", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base, { amplitudeFloor: 240 });
    const put = await api(srv.base, "PUT", `/clocks/${clock.id}/thresholds`, {
      targetDailyRateSeconds: 5,
      amplitudeFloor: 260,
      amplitudeCeiling: 300
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.data.amplitudeFloor, 260);

    const res = await retest(srv.base, clock.id, { dailyRateSeconds: 10, amplitude: 250, testedAt: "2026-07-01T08:00:00Z" });
    assert.equal(res.body.data.qualified, false);
    assert.deepEqual(res.body.data.violations.sort(), [VIOLATION.AMPLITUDE_LOW, VIOLATION.RATE_HIGH].sort());
  } finally {
    await srv.close();
  }
});

test("告警记录不可修改/删除，只能追加处理记录；重复处理返回 409", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    const alertId = (await api(srv.base, "GET", "/alerts")).body.data[0].id;

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await api(srv.base, method, `/alerts/${alertId}`, { detail: "hacked" });
      assert.equal(res.status, 404, `${method} 告警不应存在修改入口`);
    }

    const before = await api(srv.base, "GET", `/alerts/${alertId}`);
    const handled = await api(srv.base, "POST", `/alerts/${alertId}/handle`, { handledBy: "张师傅", note: "已清洗摆轴并重调游丝" });
    assert.equal(handled.status, 201);

    const after = await api(srv.base, "GET", `/alerts/${alertId}`);
    assert.equal(after.body.data.status, "handled");
    // 告警本体字段保持不变
    assert.equal(after.body.data.detail, before.body.data.detail);
    assert.deepEqual(after.body.data.measured, before.body.data.measured);
    assert.deepEqual(after.body.data.thresholds, before.body.data.thresholds);
    assert.equal(after.body.data.handling.handledBy, "张师傅");

    const duplicateHandle = await api(srv.base, "POST", `/alerts/${alertId}/handle`, {});
    assert.equal(duplicateHandle.status, 409);

    const pending = await api(srv.base, "GET", "/alerts?status=pending");
    assert.equal(pending.body.data.length, 0);
    const handledList = await api(srv.base, "GET", "/alerts?status=handled");
    assert.equal(handledList.body.data.length, 1);

    const notFound = await api(srv.base, "POST", "/alerts/ghost/handle", {});
    assert.equal(notFound.status, 404);
  } finally {
    await srv.close();
  }
});

test("处理后再次连续两次同方向越限，允许生成新告警", async () => {
  const srv = await startServer();
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    const alertId = (await api(srv.base, "GET", "/alerts")).body.data[0].id;
    await api(srv.base, "POST", `/alerts/${alertId}/handle`, { note: "处理一轮" });

    await retest(srv.base, clock.id, { dailyRateSeconds: 27, amplitude: 280, testedAt: "2026-07-05T08:00:00Z" });
    const next = await retest(srv.base, clock.id, { dailyRateSeconds: 28, amplitude: 280, testedAt: "2026-07-06T08:00:00Z" });
    assert.equal(next.body.alerts.length, 1);
    const pending = await api(srv.base, "GET", "/alerts?status=pending");
    assert.equal(pending.body.data.length, 1);
  } finally {
    await srv.close();
  }
});

test("服务重启后钟表、复测、告警（含处理状态）均不丢失", async () => {
  const dbFile = tempDbFile();
  let srv = await startServer(dbFile);
  let alertId;
  try {
    const clock = await createClock(srv.base);
    await retest(srv.base, clock.id, { dailyRateSeconds: 25, amplitude: 280, testedAt: "2026-07-01T08:00:00Z" });
    await retest(srv.base, clock.id, { dailyRateSeconds: 26, amplitude: 280, testedAt: "2026-07-02T08:00:00Z" });
    alertId = (await api(srv.base, "GET", "/alerts")).body.data[0].id;
    assert.ok(fs.existsSync(dbFile));
  } finally {
    await srv.close();
  }

  // 重启：用同一个 db 文件新建服务实例
  srv = await startServer(dbFile);
  try {
    const pending = await api(srv.base, "GET", `/alerts/${alertId}`);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.data.status, "pending");

    await api(srv.base, "POST", `/alerts/${alertId}/handle`, { handledBy: "重启后处理" });
  } finally {
    await srv.close();
  }

  // 再重启一次，处理状态仍在
  srv = await startServer(dbFile);
  try {
    const handled = await api(srv.base, "GET", `/alerts/${alertId}`);
    assert.equal(handled.body.data.status, "handled");
    assert.equal(handled.body.data.handling.handledBy, "重启后处理");
    const pendingCount = (await api(srv.base, "GET", "/alerts?status=pending")).body.data.length;
    assert.equal(pendingCount, 0);
  } finally {
    await srv.close();
    fs.rmSync(dbFile, { force: true });
  }
});

test("旧版 db.json 缺双阈值与告警集合时自动迁移", async () => {
  const dbFile = tempDbFile();
  fs.writeFileSync(
    dbFile,
    JSON.stringify({
      clocks: [
        {
          id: "clock_old",
          code: "OLD-1",
          escapementType: "圆柱式",
          balanceFrequency: "21600vph",
          targetDailyRateSeconds: 15,
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      adjustments: [],
      retests: []
    })
  );
  const srv = await startServer(dbFile);
  try {
    const res = await api(srv.base, "GET", "/clocks/clock_old/history");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clock.amplitudeFloor, 220);
    assert.equal(res.body.data.clock.amplitudeCeiling, 320);
    const alerts = await api(srv.base, "GET", "/alerts");
    assert.deepEqual(alerts.body.data, []);
  } finally {
    await srv.close();
    fs.rmSync(dbFile, { force: true });
  }
});

// 纯函数快速核对
test("classifyRetest / validateThresholds 纯函数边界", () => {
  const clock = { targetDailyRateSeconds: 20, amplitudeFloor: 240, amplitudeCeiling: 320 };
  assert.deepEqual(classifyRetest(clock, 20, 240), []);
  assert.deepEqual(classifyRetest(clock, -20.1, 320.1), [VIOLATION.RATE_LOW, VIOLATION.AMPLITUDE_HIGH]);
  assert.ok(validateThresholds({ targetDailyRateSeconds: 1, amplitudeFloor: 2, amplitudeCeiling: 3 }).value);
  assert.ok(validateThresholds({ targetDailyRateSeconds: 1, amplitudeFloor: 3, amplitudeCeiling: 2 }).error);
});
