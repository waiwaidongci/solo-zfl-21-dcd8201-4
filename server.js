const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const DEFAULT_TARGET_DAILY_RATE = 30;
const DEFAULT_AMPLITUDE_FLOOR = 220;
const DEFAULT_AMPLITUDE_CEILING = 320;

// 日差取绝对值比较目标值，因此方向只可能是偏快 / 偏慢；
// 摆幅则分为低于下限 / 高于上限。
const VIOLATION = {
  RATE_HIGH: "RATE_HIGH",
  RATE_LOW: "RATE_LOW",
  AMPLITUDE_HIGH: "AMPLITUDE_HIGH",
  AMPLITUDE_LOW: "AMPLITUDE_LOW"
};

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      amplitudeFloor: 220,
      amplitudeCeiling: 320,
      note: "怀表机芯，走时偏快",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      idempotencyKey: null,
      testedAt: "2026-06-16T00:00:00.000Z",
      createdAt: "2026-06-16T00:00:00.000Z",
      seq: 1,
      dailyRateSeconds: 31,
      amplitude: 248,
      violations: [VIOLATION.RATE_HIGH],
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  alerts: [],
  alertHandlings: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "PUT /clocks/:id/thresholds",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /clocks/:id/alerts",
  "GET /adjustments?clockId=",
  "GET /retests?clockId=&qualified=",
  "GET /alerts?clockId=&status=pending|handled|all",
  "GET /alerts/:id",
  "POST /alerts/:id/handle"
];

// ---- 纯业务函数，便于测试直接复用 ----

// 布尔值和 NaN 都不是合法数值输入
function finiteNumber(value) {
  if (typeof value === "boolean" || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 仅接受非空（去空白后）字符串；null、数字、布尔、对象、数组一律拒绝
function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validateThresholds(input) {
  const target = finiteNumber(input.targetDailyRateSeconds);
  const floor = finiteNumber(input.amplitudeFloor);
  const ceiling = finiteNumber(input.amplitudeCeiling);
  if (target === null || floor === null || ceiling === null) {
    return { error: "targetDailyRateSeconds、amplitudeFloor、amplitudeCeiling 必须都是数字" };
  }
  if (target < 0) return { error: "目标日差不能为负数" };
  if (floor <= 0 || ceiling <= 0) return { error: "摆幅上下限必须大于 0" };
  if (floor > ceiling) return { error: "摆幅下限不能大于上限" };
  if (ceiling > 360) return { error: "摆幅上限不能超过 360 度" };
  return { value: { targetDailyRateSeconds: target, amplitudeFloor: floor, amplitudeCeiling: ceiling } };
}

// 返回本次复测的越限方向列表（可能日差、摆幅同时越限）
function classifyRetest(clock, dailyRateSeconds, amplitude) {
  const violations = [];
  if (dailyRateSeconds > clock.targetDailyRateSeconds) violations.push(VIOLATION.RATE_HIGH);
  if (dailyRateSeconds < -clock.targetDailyRateSeconds) violations.push(VIOLATION.RATE_LOW);
  if (amplitude < clock.amplitudeFloor) violations.push(VIOLATION.AMPLITUDE_LOW);
  if (amplitude > clock.amplitudeCeiling) violations.push(VIOLATION.AMPLITUDE_HIGH);
  return violations;
}

function violationText(direction, measured, clock) {
  switch (direction) {
    case VIOLATION.RATE_HIGH:
      return `日差 +${measured.dailyRateSeconds}s/日，超过目标 ±${clock.targetDailyRateSeconds}s/日（偏快）`;
    case VIOLATION.RATE_LOW:
      return `日差 ${measured.dailyRateSeconds}s/日，超过目标 ±${clock.targetDailyRateSeconds}s/日（偏慢）`;
    case VIOLATION.AMPLITUDE_LOW:
      return `摆幅 ${measured.amplitude}°，低于下限 ${clock.amplitudeFloor}°`;
    case VIOLATION.AMPLITUDE_HIGH:
      return `摆幅 ${measured.amplitude}°，高于上限 ${clock.amplitudeCeiling}°`;
    default:
      return direction;
  }
}

// ---- 存储层：读改写加互斥锁，落盘用临时文件 + rename 原子替换 ----

function createStore(dbFile) {
  let chain = Promise.resolve();

  async function ensureDb() {
    await mkdir(path.dirname(dbFile), { recursive: true });
    let raw;
    try {
      raw = await readFile(dbFile, "utf8");
    } catch {
      await writeFile(dbFile, JSON.stringify(initialData, null, 2));
      raw = JSON.stringify(initialData);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = JSON.parse(JSON.stringify(initialData));
    }
    // 兼容旧库：补齐集合与钟表双阈值字段
    data.adjustments ||= [];
    data.retests ||= [];
    data.alerts ||= [];
    data.alertHandlings ||= [];
    let migrated = false;
    // 旧库复测补单调序号；新复测序号 = 库内最大序号 + 1
    for (const [index, retest] of data.retests.entries()) {
      if (typeof retest.seq !== "number") {
        retest.seq = index + 1;
        migrated = true;
      }
    }
    for (const clock of data.clocks || []) {
      if (clock.amplitudeFloor === undefined) {
        clock.amplitudeFloor = DEFAULT_AMPLITUDE_FLOOR;
        migrated = true;
      }
      if (clock.amplitudeCeiling === undefined) {
        clock.amplitudeCeiling = DEFAULT_AMPLITUDE_CEILING;
        migrated = true;
      }
    }
    if (migrated) await persist(data);
    return data;
  }

  async function persist(data) {
    const tmp = `${dbFile}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, dbFile);
  }

  // 所有写操作串行化，避免并发请求互相覆盖
  function mutate(fn) {
    const run = chain.then(async () => {
      const data = await ensureDb();
      const result = await fn(data);
      await persist(data);
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  async function read() {
    return ensureDb();
  }

  return { read, mutate };
}

function createApp(dbFile) {
  const store = createStore(dbFile);

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  }

  async function parseBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw.trim()) {
      throw fail(400, "请求体不能为空，必须提交 JSON 对象");
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw fail(400, "请求体必须是合法 JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw fail(400, "请求体必须是 JSON 对象，不接受 null、数组或标量值");
    }
    return body;
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function required(body, fields) {
    const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
    if (missing.length) {
      const error = new Error(`缺少字段：${missing.join(", ")}`);
      error.status = 400;
      throw error;
    }
  }

  function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function findClock(data, clockId) {
    const clock = data.clocks.find((item) => item.id === clockId);
    if (!clock) throw fail(404, "钟表不存在");
    return clock;
  }

  function clockRetestsOrdered(data, clockId) {
    return data.retests
      .filter((item) => item.clockId === clockId)
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const t = new Date(a.item.testedAt) - new Date(b.item.testedAt);
        return t !== 0 ? t : a.index - b.index;
      })
      .map((entry) => entry.item);
  }

  function latestRetest(data, clockId) {
    const list = clockRetestsOrdered(data, clockId);
    return list[list.length - 1] || null;
  }

  function latestAdjustment(data, clockId) {
    return data.adjustments
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }

  function isAlertPending(data, alertId) {
    return !data.alertHandlings.some((item) => item.alertId === alertId);
  }

  // 该方向是否应抑制新告警：
  // 1) 已有待处理告警 → 抑制；
  // 2) 最近一条告警已处理，但上一条复测仍发生在它触发之前 → 处理后尚未攒够两次新越限，抑制。
  function shouldSuppressAlert(data, clockId, direction, previousRetest) {
    const latestAlert = data.alerts
      .filter((alert) => alert.clockId === clockId && alert.direction === direction)
      .sort((a, b) => b.retestSeq - a.retestSeq)[0];
    if (!latestAlert) return false;
    if (isAlertPending(data, latestAlert.id)) return true;
    return !previousRetest || previousRetest.seq <= latestAlert.retestSeq;
  }

  function alertWithStatus(data, alert) {
    const handling = data.alertHandlings.find((item) => item.alertId === alert.id) || null;
    return { ...alert, status: handling ? "handled" : "pending", handling };
  }

  function clockSummary(data, clock) {
    const retest = latestRetest(data, clock.id);
    const adjustment = latestAdjustment(data, clock.id);
    const pendingAlertCount = data.alerts.filter(
      (alert) => alert.clockId === clock.id && isAlertPending(data, alert.id)
    ).length;
    return {
      ...clock,
      latestAdjustment: adjustment,
      latestRetest: retest,
      qualified: retest ? retest.qualified : false,
      pendingAlertCount
    };
  }

  // 在写入事务内：落一条复测，并按“连续两次同一方向越限”生成待处理告警
  function submitRetest(data, clock, payload) {
    const ordered = clockRetestsOrdered(data, clock.id);
    const previous = ordered[ordered.length - 1] || null;

    // 1) 幂等键重复：直接返回原记录，不再判告警
    if (payload.idempotencyKey) {
      const sameKey = data.retests.find(
        (item) => item.idempotencyKey === payload.idempotencyKey && item.clockId === clock.id
      );
      if (sameKey) return { retest: sameKey, duplicate: true, alerts: [] };
    }

    // 2) 内容完全一致的重复提交（同一钟表、同一测量值、同一次复测时间）也不重复受理
    const sameContent = data.retests.find(
      (item) =>
        item.clockId === clock.id &&
        item.dailyRateSeconds === payload.dailyRateSeconds &&
        item.amplitude === payload.amplitude &&
        (item.adjustmentId || null) === (payload.adjustmentId || null) &&
        (item.note || "") === (payload.note || "") &&
        item.testedAt === payload.testedAt
    );
    if (sameContent) return { retest: sameContent, duplicate: true, alerts: [] };

    const violations = classifyRetest(clock, payload.dailyRateSeconds, payload.amplitude);
    const seq = data.retests.reduce((max, item) => Math.max(max, item.seq || 0), 0) + 1;
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: payload.adjustmentId,
      idempotencyKey: null,
      testedAt: payload.testedAt,
      createdAt: new Date().toISOString(),
      seq,
      dailyRateSeconds: payload.dailyRateSeconds,
      amplitude: payload.amplitude,
      violations,
      qualified: violations.length === 0,
      note: payload.note || ""
    };
    if (payload.idempotencyKey) retest.idempotencyKey = payload.idempotencyKey;
    data.retests.push(retest);

    // 与上一条复测同一方向连续越限，且该方向告警无需抑制 → 生成告警
    const createdAlerts = [];
    const previousDirections = new Set(previous?.violations || []);
    for (const direction of violations) {
      if (!previousDirections.has(direction)) continue;
      if (shouldSuppressAlert(data, clock.id, direction, previous)) continue;
      const alert = {
        id: makeId("alert"),
        clockId: clock.id,
        direction,
        retestId: retest.id,
        retestSeq: retest.seq,
        previousRetestId: previous.id,
        detail: violationText(direction, retest, clock),
        thresholds: {
          targetDailyRateSeconds: clock.targetDailyRateSeconds,
          amplitudeFloor: clock.amplitudeFloor,
          amplitudeCeiling: clock.amplitudeCeiling
        },
        measured: { dailyRateSeconds: retest.dailyRateSeconds, amplitude: retest.amplitude },
        createdAt: new Date().toISOString()
      };
      data.alerts.push(alert);
      createdAlerts.push(alert);
    }

    return { retest, duplicate: false, alerts: createdAlerts };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "local"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
    }

    if (req.method === "GET" && pathname === "/clocks") {
      const db = await store.read();
      const qualified = url.searchParams.get("qualified");
      let list = db.clocks.map((clock) => clockSummary(db, clock));
      if (qualified !== null) list = list.filter((clock) => clock.qualified === (qualified === "true"));
      return send(res, 200, { data: list });
    }

    if (req.method === "POST" && pathname === "/clocks") {
      const body = await parseBody(req);
      required(body, ["code", "escapementType", "balanceFrequency"]);
      const thresholds = validateThresholds({
        targetDailyRateSeconds: body.targetDailyRateSeconds ?? DEFAULT_TARGET_DAILY_RATE,
        amplitudeFloor: body.amplitudeFloor ?? DEFAULT_AMPLITUDE_FLOOR,
        amplitudeCeiling: body.amplitudeCeiling ?? DEFAULT_AMPLITUDE_CEILING
      });
      if (thresholds.error) throw fail(400, thresholds.error);
      const result = await store.mutate((db) => {
        const clock = {
          id: makeId("clock"),
          code: body.code,
          escapementType: body.escapementType,
          balanceFrequency: body.balanceFrequency,
          ...thresholds.value,
          note: body.note || "",
          createdAt: new Date().toISOString()
        };
        db.clocks.push(clock);
        return clockSummary(db, clock);
      });
      return send(res, 201, { data: result });
    }

    if (req.method === "GET" && pathname === "/clocks/not-qualified") {
      const db = await store.read();
      const list = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
      return send(res, 200, { data: list });
    }

    const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const db = await store.read();
      const clock = findClock(db, historyMatch[1]);
      const clockId = clock.id;
      const adjustments = db.adjustments.filter((item) => item.clockId === clockId);
      const retests = clockRetestsOrdered(db, clockId);
      const alerts = db.alerts.filter((item) => item.clockId === clockId).map((alert) => alertWithStatus(db, alert));
      return send(res, 200, {
        data: { clock, adjustments, retests, alerts, latestRetest: retests[retests.length - 1] || null }
      });
    }

    const thresholdsMatch = pathname.match(/^\/clocks\/([^/]+)\/thresholds$/);
    if (thresholdsMatch && req.method === "PUT") {
      const body = await parseBody(req);
      required(body, ["targetDailyRateSeconds", "amplitudeFloor", "amplitudeCeiling"]);
      const thresholds = validateThresholds(body);
      if (thresholds.error) throw fail(400, thresholds.error);
      const result = await store.mutate((db) => {
        const clock = findClock(db, thresholdsMatch[1]);
        Object.assign(clock, thresholds.value);
        return clockSummary(db, clock);
      });
      return send(res, 200, { data: result });
    }

    const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
    if (adjustmentMatch && req.method === "POST") {
      const clockId = adjustmentMatch[1];
      const body = await parseBody(req);
      // 全部字段校验在写事务之外完成，任何非法输入都不会落库
      required(body, ["currentDailyRateSeconds", "direction", "amount"]);
      const currentDailyRateSeconds = finiteNumber(body.currentDailyRateSeconds);
      if (currentDailyRateSeconds === null) throw fail(400, "currentDailyRateSeconds 必须是数字");
      const direction = nonEmptyString(body.direction);
      if (direction === null) throw fail(400, "direction 必须是非空字符串");
      const amount = nonEmptyString(body.amount);
      if (amount === null) throw fail(400, "amount 必须是非空字符串");
      if (body.note !== undefined && typeof body.note !== "string") throw fail(400, "note 必须是字符串");
      const result = await store.mutate((db) => {
        findClock(db, clockId);
        const adjustment = {
          id: makeId("adjustment"),
          clockId,
          currentDailyRateSeconds,
          direction,
          amount,
          note: typeof body.note === "string" ? body.note.trim() : "",
          createdAt: new Date().toISOString()
        };
        db.adjustments.push(adjustment);
        return adjustment;
      });
      return send(res, 201, { data: result });
    }

    const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
    if (retestMatch && req.method === "POST") {
      const clockId = retestMatch[1];
      const body = await parseBody(req);
      required(body, ["dailyRateSeconds", "amplitude"]);
      const dailyRateSeconds = finiteNumber(body.dailyRateSeconds);
      const amplitude = finiteNumber(body.amplitude);
      if (dailyRateSeconds === null) throw fail(400, "dailyRateSeconds 必须是数字");
      if (amplitude === null) throw fail(400, "amplitude 必须是数字");
      if (amplitude <= 0 || amplitude > 360) throw fail(400, "摆幅必须在 0 到 360 度之间");
      let testedAt;
      if (body.testedAt !== undefined && body.testedAt !== "") {
        const parsed = new Date(body.testedAt);
        if (Number.isNaN(parsed.getTime())) throw fail(400, "testedAt 必须是合法时间");
        testedAt = parsed.toISOString();
      } else {
        testedAt = new Date().toISOString();
      }
      const idempotencyKey =
        body.idempotencyKey || req.headers["idempotency-key"] || null;

      const result = await store.mutate((db) => {
        const clock = findClock(db, clockId);
        const adjustmentId =
          body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
        if (body.adjustmentId && !db.adjustments.some((item) => item.id === body.adjustmentId)) {
          throw fail(400, "adjustmentId 不存在");
        }
        return submitRetest(db, clock, {
          dailyRateSeconds,
          amplitude,
          testedAt,
          adjustmentId,
          note: body.note || "",
          idempotencyKey
        });
      });
      const status = result.duplicate ? 200 : 201;
      return send(res, status, {
        data: result.retest,
        duplicate: result.duplicate,
        alerts: result.alerts.map((alert) => ({ id: alert.id, direction: alert.direction, clockId: alert.clockId }))
      });
    }

    const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
    if (latestMatch && req.method === "GET") {
      const db = await store.read();
      findClock(db, latestMatch[1]);
      return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
    }

    const clockAlertsMatch = pathname.match(/^\/clocks\/([^/]+)\/alerts$/);
    if (clockAlertsMatch && req.method === "GET") {
      const db = await store.read();
      const clock = findClock(db, clockAlertsMatch[1]);
      const status = url.searchParams.get("status") || "all";
      let list = db.alerts.filter((item) => item.clockId === clock.id).map((alert) => alertWithStatus(db, alert));
      if (status !== "all") list = list.filter((alert) => alert.status === status);
      return send(res, 200, { data: list });
    }

    if (req.method === "GET" && pathname === "/adjustments") {
      const db = await store.read();
      const clockId = url.searchParams.get("clockId");
      return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
    }

    if (req.method === "GET" && pathname === "/retests") {
      const db = await store.read();
      const clockId = url.searchParams.get("clockId");
      const qualified = url.searchParams.get("qualified");
      const data = db.retests.filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchQualified = qualified === null || item.qualified === (qualified === "true");
        return matchClock && matchQualified;
      });
      return send(res, 200, { data });
    }

    if (req.method === "GET" && pathname === "/alerts") {
      const db = await store.read();
      const clockId = url.searchParams.get("clockId");
      const status = url.searchParams.get("status") || "pending";
      let list = db.alerts
        .filter((alert) => !clockId || alert.clockId === clockId)
        .map((alert) => alertWithStatus(db, alert));
      if (status !== "all") list = list.filter((alert) => alert.status === status);
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return send(res, 200, { data: list });
    }

    const alertMatch = pathname.match(/^\/alerts\/([^/]+)$/);
    if (alertMatch && req.method === "GET") {
      const db = await store.read();
      const alert = db.alerts.find((item) => item.id === alertMatch[1]);
      if (!alert) throw fail(404, "告警不存在");
      return send(res, 200, { data: alertWithStatus(db, alert) });
    }

    // 告警没有修改 / 删除接口；只能追加一条处理记录使其离开待处理列表
    const handleMatch = pathname.match(/^\/alerts\/([^/]+)\/handle$/);
    if (handleMatch && req.method === "POST") {
      const alertId = handleMatch[1];
      const body = await parseBody(req);
      const result = await store.mutate((db) => {
        const alert = db.alerts.find((item) => item.id === alertId);
        if (!alert) throw fail(404, "告警不存在");
        if (!isAlertPending(db, alertId)) throw fail(409, "该告警已处理，告警记录不可重复处理或修改");
        const handling = {
          id: makeId("handling"),
          alertId,
          clockId: alert.clockId,
          handledBy: body.handledBy || "anonymous",
          note: body.note || "",
          handledAt: new Date().toISOString()
        };
        db.alertHandlings.push(handling);
        return { alert: alertWithStatus(db, alert), handling };
      });
      return send(res, 201, { data: result });
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) =>
      send(res, error.status || 500, { error: error.message || "服务器错误" })
    );
  });

  return server;
}

module.exports = {
  createApp,
  validateThresholds,
  classifyRetest,
  VIOLATION,
  finiteNumber
};

if (require.main === module) {
  const server = createApp(DB_FILE);
  server.listen(PORT, () => {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
  });
}
