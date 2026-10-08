const STAGES = ['上传草图', '还原草图', '仿真优化', '对比采用'] as const;

export function FlowStepper({ current, residential = false }: { current: number; residential?: boolean }) {
  return (
    <ol className="flow-stepper" aria-label="设计流程">
      {(residential ? ['固定底图','节点图与日照','生成与验证','对比采用'] : STAGES).map((label, index) => (
        <li
          key={label}
          className={index === current ? 'current' : index < current ? 'done' : ''}
          aria-current={index === current ? 'step' : undefined}
        >
          <span className="flow-stepper-dot" />
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}
