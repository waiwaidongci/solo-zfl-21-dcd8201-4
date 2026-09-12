# 机械钟表擒纵调校 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录与告警。
落盘采用“临时文件 + rename”原子写入，写操作串行化，服务重启后数据不丢。

## 启动

```bash
PORT=3021 node server.js
```

也可用 `DB_FILE=/path/to/db.json` 指定数据文件（测试用）。

## 测试

```bash
node --test        # 17 个用例：正常 / 边界 / 连续越限 / 重复提交 / 非法输入 / 告警不可改 / 重启持久化
```

## 双阈值验收

每只钟表可配置：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `targetDailyRateSeconds` | 目标日差，验收区间为其正负值（闭区间） | 30 |
| `amplitudeFloor` | 摆幅下限（度，闭区间） | 220 |
| `amplitudeCeiling` | 摆幅上限（度，闭区间） | 320 |

复测同时检查日差与摆幅，任一越限即 `qualified=false`，并记录越限方向：
`RATE_HIGH`（偏快）、`RATE_LOW`（偏慢）、`AMPLITUDE_HIGH`、`AMPLITUDE_LOW`。
测量值恰好等于阈值算合格。

## 告警规则

- 相邻两次复测在**同一方向**连续越限 → 自动生成一条 `pending` 告警（日差、摆幅可分别生成）。
- 同一方向已存在待处理告警时，后续越限不会重复生成。
- 告警处理后，需要处理时点之后**再次出现两次新的连续同方向越限**才会重新告警。
- 告警记录只可查询、不可修改或删除；只能通过 `POST /alerts/:id/handle` 追加一条处理记录，
  告警随即从待处理列表消失，重复处理返回 409。

## 复测幂等（防重复提交）

`POST /clocks/:id/retests` 以下两种重复提交都不会新增复测或告警，返回 `200` 与原记录（`duplicate:true`）：

1. 携带相同幂等键：请求体 `idempotencyKey` 或 `Idempotency-Key` 请求头；
2. 无幂等键但内容完全一致（同钟表、同日差、同摆幅、同 `testedAt`、同调校与备注）。

幂等键按钟表维度判定；并发双发同一键只落一条。

## 接口

- `GET /health`
- `GET /clocks`（可选 `?qualified=true|false`）
- `POST /clocks`（可带三个阈值字段）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含 adjustments / retests / alerts）
- `PUT /clocks/:id/thresholds` — 修改目标日差与摆幅上下限
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /clocks/:id/alerts?status=pending|handled|all` — 单钟告警
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /alerts?clockId=&status=pending|handled|all` — 待处理列表（默认 pending）
- `GET /alerts/:id`
- `POST /alerts/:id/handle`

## 闭环示例

```bash
# 建钟：日差 ±10s，摆幅 250°–310°
curl -X POST http://127.0.0.1:3021/clocks -H 'Content-Type: application/json' \
  -d '{"code":"CLK-01","escapementType":"杠杆式","balanceFrequency":"28800vph",
       "targetDailyRateSeconds":10,"amplitudeFloor":250,"amplitudeCeiling":310}'

# 连续两次偏快，第二次返回新告警
curl -X POST http://127.0.0.1:3021/clocks/<id>/retests -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":14,"amplitude":280,"testedAt":"2026-08-02T08:00:00Z"}'
curl -X POST http://127.0.0.1:3021/clocks/<id>/retests -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":15,"amplitude":280,"testedAt":"2026-08-03T08:00:00Z","idempotencyKey":"RT-0803"}'

# 待处理列表 / 单钟告警
curl 'http://127.0.0.1:3021/alerts?status=pending'
curl 'http://127.0.0.1:3021/clocks/<id>/alerts'

# 处理告警（告警正文不可改，仅追加处理记录）
curl -X POST http://127.0.0.1:3021/alerts/<alertId>/handle -H 'Content-Type: application/json' \
  -d '{"handledBy":"张师傅","note":"已重调游丝快慢针"}'
```
