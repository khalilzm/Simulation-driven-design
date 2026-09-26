# 日照 Python 引擎

Node 通过 `server/src/sunlight/run.ts` 调用本目录 `sdd_run.py`（勿命名为 `run.py`，会与 lbt-recipes 的 Luigi 入口冲突）。

## 与 Grasshopper 对齐

| 模式 | 环境变量 | 对应 GH 组件 | 引擎 ID |
|------|-----------|--------------|---------|
| **默认** | （无） | **LB Direct Sun Hours** 同源（Sunpath + 直射遮挡） | `ladybug-lb-direct-sun-hours@2` |
| **Radiance** | `SDD_SUNLIGHT_USE_RADIANCE=1` | **HB Direct Sun Hours**（lbt-recipes） | `lbt-direct-sun-hours@1` |

两种模式均使用：

- Honeybee `SensorGrid.from_face3d`
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
