# 日照 Python 引擎

Node 通过 `server/src/sunlight/run.ts` 调用本目录 `sdd_run.py`（勿命名为 `run.py`，会与 lbt-recipes 的 Luigi 入口冲突）。

## 与 Grasshopper 对齐

| 模式 | 环境变量 | 对应 GH 组件 | 引擎 ID |
|------|-----------|--------------|---------|
| **LB** | `SDD_SUNLIGHT_USE_RADIANCE=0` | **LB Direct Sun Hours** 同源（Sunpath + 直射遮挡） | `ladybug-lb-direct-sun-hours@3` |
| **Radiance** | `SDD_SUNLIGHT_USE_RADIANCE=1` | **HB Direct Sun Hours**（lbt-recipes） | `lbt-direct-sun-hours@2` |

Python 独立运行默认使用 LB；Node 未显式设置环境变量时，会在本地 venv 和 Radiance 均存在时选择 Radiance，否则使用 LB。

两种模式均使用：

- Honeybee `SensorGrid.from_face3d`；水平采样面统一朝向 `+Z`，空间边界为顺时针或逆时针均可。历史模型中因测点朝下得到的零值需重新计算。
- Ladybug **Ecotect** 图例参数写入 `result.legend`；`grids[].faceColors` 供 GH 对照，浏览器平面按 `hours` + 同一图例插值着色（`GMeshBasicMaterial`）

Radiance 模式额外需要：

1. [Radiance](https://github.com/LBNL-ETA/Radiance)（`rtrace`、`oconv` 在 `PATH`）
2. `pip install lbt-recipes`（建议 **Python 3.10+** 独立 venv；系统 3.9 可能装不上新版 queenbee）

本仓库推荐布局（与 GH 一致，Node 会自动探测）：

- `server/python/sunlight/.venv` — Python 3.10+，`pip install -r requirements.txt lbt-recipes`
- `server/python/sunlight/vendor/radiance/` — [Radiance OSX arm64 zip](https://github.com/LBNL-ETA/Radiance/releases) 解压后的 `radiance/bin`

`server/.env`（可选，显式开启 Radiance 模式）：

```bash
SDD_SUNLIGHT_USE_RADIANCE=1
# 以下可省略：config 会默认使用 .venv 与 vendor/radiance/radiance/bin
# SDD_SUNLIGHT_PYTHON=python/sunlight/.venv/bin/python3
# SDD_SUNLIGHT_RADIANCE_BIN=python/sunlight/vendor/radiance/radiance/bin
```

关闭 GH 模式、退回 LB Direct Sun Hours：`SDD_SUNLIGHT_USE_RADIANCE=0`

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# GH 完全一致（可选）
pip install lbt-recipes
```

自检：`python3 sdd_run.py --check`

## 输入

- `--model`：`model.json`
- `--config`：`sunlight.json`（见 `shared/src/sunlight.ts`）
- `--output`：写入 `result.json`

## 时间、射线与统计口径

- `location.timezone` 为有效 IANA 时区。LB 将当地日期/时间转为 UTC 后计算太阳位置，支持日期跨界、闰日、非整点时区和夏令时；夏令时切换时不存在或重复的起止时间会明确报错。
- LB 每个区间在起点采样，以该区间的实际长度累计日照，末尾不足一步时不多计。射线由测点朝太阳发出（`sun_vector_reversed`）；夜间输出零小时。
- Radiance Wea 使用分析日期的实际 UTC 偏移，并按配置的细分步长生成数据。仍要求整点起止时间和能整除 60 分钟的步长；跨夏令时切换的时段会拒绝，需拆分或使用 LB。Wea 保留 Ladybug 的采样约定：小时数据取半点，细分数据取各步起点，因此两引擎粗步长结果可能不同。
- `meanHours`、`targetMetRatio` 按每个测点对应的网格面面积加权；`metrics.targetAreaRatio` 为全部目标网格的达标面积除以其代表面积，不再平均房间比例。重叠目标对同一面积只计一次，采用最高 `minHours`。
- `spaces` 保留物理空间结果；`allocations` 按 `allocationId` 汇总。`targets[].spaceIds` 可以引用逻辑功能 ID，其目标覆盖所有分片，包括与功能同名的首个分片。目标缺失或没有测点时，达标检查失败、总体比例为 `null`。
- `sampledArea` 是网格代表面积（平方米），不代表网格覆盖了所有边界碎片；空间拆分改变采样位置时仍可能产生离散误差。比较候选方案需固定采样规则，必要时细化网格。
- 引擎版本已更新并参与输入哈希；历史结果保留，但修正前的结果需要重新计算。

## 回归验证

在仓库根目录运行：

```sh
server/python/sunlight/.venv/bin/python3 -B -m unittest discover -s server/python/sunlight/tests -v
npm test
```

`npm test` 自动运行 Python 回归；缺少 Ladybug/Honeybee 环境时会显式标记跳过。回归覆盖矩形/凹形边界的双向绕序与测点朝向、无遮挡、顶板、无窗封闭空间、夜间、时区/DST/闰日、末步时长、面积加权、逻辑功能拆分、重叠/缺失目标和 Radiance Wea 时间序列。默认跳过真实 Radiance recipe。

已安装 Radiance 和 lbt-recipes 时，在仓库根目录运行以下集成测试。它沿用服务端的 Python 与 Radiance 路径配置，在临时目录验证两种边界绕向下无遮挡均为 1 小时、完整顶板遮挡均为 0 小时：

```sh
SDD_TEST_RADIANCE=1 node --import tsx --test server/test/sunlightEngine.test.ts
```

本机另已实跑 Radiance：上海 2025-06-21 12:00–13:00、15 分钟步长，无遮挡测点为 1 小时、顶板遮挡为 0 小时。当前安装的 `lbt-recipes` 在结果写出后的耗时统计阶段会报 `can't subtract offset-naive and offset-aware datetimes`；上述结果文件完整且数值断言通过，但这不表示依赖库的收尾异常已修复。
