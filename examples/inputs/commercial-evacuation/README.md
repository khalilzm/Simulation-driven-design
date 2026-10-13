# 商业疏散校验底图（示例）

`commercial-evacuation.dxf` 是一份非矩形商业楼层底图示例，单位为毫米（`$INSUNITS=4`）。它只包含生成商铺资源所需的固定条件，不包含 `A-SPACE` 或任何预先划分的商铺空间。

图层：

- `FIXED_OUTLINE`：不规则楼层边界。
- `FIXED_LOAD_BEARING`：固定外围结构片段。
- `FIXED_PARTITION`：服务核心等固定隔断。
- `FIXED_ENTRANCE`：门洞和疏散出口位置。
- `FIXED_STAIR`：疏散楼梯与楼梯核心。
- `FIXED_OBSTACLE`：柱、扶梯核心等固定障碍。
- `FIXED_FIREWALL`：防火分隔墙。
- `ANNOTATION`：说明文字，仅供显示。

商铺单元、公共走道、中庭和其他 `A-SPACE` 类空间由后续布局生成器生成。该文件是商业场景的几何输入示例；当前住宅 DXF 导入器只识别住宅固定底图的标准层，若要直接上传并运行商业疏散，需要先扩展导入器的商业图层映射。
