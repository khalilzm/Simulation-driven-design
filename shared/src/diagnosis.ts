// 结构化诊断：从仿真指标 + 空间关系索引推导，区分「数值观察」与「原因假设」。

export type DiagnosisSeverity = 'warn' | 'info';

export interface Diagnosis {
  issueId: string;
  severity: DiagnosisSeverity;
  /** 数值观察（事实）。 */
  observation: string;
  /** 原因假设（待验证，不冒充结论）。 */
  hypothesis: string;
  /** 建议的领域操作。 */
  operation: string;
  /** 如何验证。 */
  verification: string;
  /** 关联的物理空间 ID。 */
  spaceIds: string[];
  /** 候选墙 ID（SpatialGraph 邻接定位，locked=false）。 */
  wallIds?: string[];
  /** 候选门洞 ID（SpatialGraph 通行边，locked=false）。 */
  openingIds?: string[];
}
