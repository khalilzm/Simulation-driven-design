# 空间方案生成

上传草图后默认进入“草图还原”；工具栏可切换“文字生成”与“方案修改”。三个任务显式选择处理管线，草图还原不受旧 inputs/outline.json 影响。

## 草图还原流程

1. 上传：Sharp 验证 PNG/JPEG/WebP 内容，保留原图，按 EXIF 转正并限制长边 3000 像素。返回 SketchSource，包含不可变 ID、原文件名、SHA-256、标准图片路径、实际宽高。同名重传创建新版本，active-sketch.json 保存当前选择。
2. 识别：Agent 接收标准 PNG 原生附件，写 designs/<rev>/sketch.json。Cursor 使用 SDK images；Claude 使用 stream-json 的 image 内容块。首次识别只开放写入，避免无关文件搜索；修正再开放读取已知产物。文件写好后只回复一句完成信息。
3. 编译：compileSketch 把墙线连接成平面图，从闭合面推导区域。物理墙保留源 ID 与方向，交点只在拓扑推导时拆分。重复墙线合并并重映射反向洞口；部分重叠需修正。不按房间或外轮廓补墙。
4. 返回：几何有效就直接返回平面；不再调用模型对照原图，也不因图像差异循环修正。缺少尺寸、层高或识别存疑时返回待确认草案，正常只需一次模型调用。
5. 修正：格式错误、确定性几何错误或调用失败才自动重试，总计最多三轮模型调用；取消任务或模型明确不支持图片时立即停止。已解析的数据按对象 ID 打补丁，省略对象保持不变；用户也可以提交定点修正说明。

旧版未登记的上传图片在首次使用时转存为图片版本。生成的预览不会被当作输入草图。

## 识别协议

契约：shared/src/sketch.ts；严格解析：server/src/sketch/parse.ts。

- 坐标：标准 PNG 像素，原点左上、X 右、Y 下。编译时按尺寸依据换算成米并翻转 Y。
- walls：有向中线折线、thicknessPx 像素厚度或 null；有明确米制标注时直接填 thicknessM，程序优先采用。宿主中线跨过门窗洞口连续。
- openings：door/window/passage/unknown、宿主墙 ID、中心弧长比例、像素宽度、米制高度/窗台高度、铰链、开启侧。未知项保留。
- labels：原始功能文字、归一化功能类型、区域内锚点。例如原文“主卧”、类型“卧室”。
- dividers：有图像依据的开放功能分界，只分区不生成墙。
- dimensions：真实标注或用户给出的实长及对应像素端点。比例偏差超过 5% 须核对。
- uncertainties：对象疑问及图中位置。

端点吸附容差为图片长边的 0.1%，限制在 0.5～3 像素；每次修改记录在 adjustments。大断点不补齐，未闭合线段标为待确认。没有尺寸时仅按比例预览，层高、墙厚、洞口高度的默认值逐项列为待确认假设。

最多支持 512 条线段、4096 个拓扑交点。现有楼层模型要求单个连续外轮廓，多栋/多层草图需拆分。曲墙可用有依据的折线近似；不自动校正透视。

## 状态和用户修正

- accepted：几何有效、已校准且没有待确认项；或用户明确核对并采用结果。此状态表示结构与尺寸校验通过，不代表经过第二次模型图像复核。
- needs_review：可查看的草案，保留尺寸假设、疑问与遗漏，不能直接继承或运行日照。
- rejected：几何或执行失败，诊断和可生成的叠加图仍保留。

完成后直接展示平面，不自动弹出对照面板。用户可点「识别结果」查看本地程序生成的叠加图、问题定位、端点调整记录，提交修正说明或选择直线墙输入实长。辅助叠加图只在最终结果上生成一次，不发送给模型；生成失败不阻止查看平面。确认创建新版本，不覆盖旧报告；未生成开口、几何错误、无比例等不能通过确认绕过。

## API 与产物

- POST /api/chat、/api/generate：mode=sketch|generate|edit，sketchId，parentRevisionId。草图使用独立原生会话；修正父版本须绑定同一图片。
- GET /api/sketches/<session>/<rev>：识别、问题、映射、调整记录及预览模型。
- GET /api/sketches/<session>/<rev>/overlay：PNG 对照图。
- POST /api/sketches/<session>/<rev>/confirm：{ extractionHash, confirm:true, wallId?, lengthM? }。
- sketchReview 流事件指向还原报告；design.valid 只在 accepted 时为 true。

版本目录保留 sketch.json、sketch-raw.json（首次有效解析）、sketch-patch.json（如有）、sketch-report.json、sketch-timing.json、叠加图、model.json（可构建时）与 validation.json。新版本不再生成 sketch-review.json；旧报告仍可读取。人工确认来源记录在 report.confirmation。

## 耗时记录

SketchSource.preparationMs 记录图片解码、转正、缩放、编码和保存的耗时，不含浏览器上传及网络时间。每次草图任务的 sketch-timing.json 按阶段更新，最终也写入 sketch-report.json 的 timings：

- recognize / patch：一次模型适配器调用的全部耗时，包括启动、推理和清理；记录轮次与成功/失败。
- parse / compile / overlay / persist：格式解析、几何编译校验、最终辅助叠加图和产物写盘。
- Cursor 调用进一步记录 authMs、initializeMs、attachmentsMs、sendMs、runMs、disposeMs。firstContentMs 是从发送开始到第一条内容事件，afterLastToolMs 是最后一个工具完成后的等待，两者属于已有阶段内的观测点，不能重复相加。
- durationMs 从草图处理入口计到最终产物保存，排除最后计时文件自身的刷新和 HTTP 响应发送；历史日志分析见 sketch-performance-2026-09-30.md。

## 文字生成和方案修改

文字新方案由 Agent 写 intent.json，现有意图布局器生成几何；方案修改由 Agent 写 layout.json，走原有布局编译和严格校验。

## 验证

运行 npm run check、npm test、npm run build。草图测试覆盖上传版本、旧轮廓隔离、原生图片消息、墙线推导、门窗宿主及方向、开放分界、容差、缺失对象、尺度、定点补丁、人工确认、单次模型调用返回草案、几何错误重试上限及成功/失败耗时记录。模型准确率仍需用实际草图与人工标注评估。

可选真实模型冒烟：`node --import tsx server/scripts/sketch-smoke.ts cursor`（或 claude）。使用合成两房草图，消耗模型额度，默认两分钟超时；识别输出和诊断保存在 workspaces/smoke-sketch-*。协议测试和模拟 Agent 测试不等同于此项测试通过。
