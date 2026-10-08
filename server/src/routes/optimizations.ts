import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { OPTIMIZATION_POLICY, type OptimizationEvaluation } from '@sdd/shared';
import { workspacesDir } from '../config';
import { parseAutomaticOptimizationRequest, prepareAutomaticOptimization } from '../optimization/automatic';
import { loadOptimizationComparison, loadOptimizationBaselineView } from '../optimization/comparison';
import { analyzeWorkbench, latestWorkbenchAnalysis, parseWorkbenchAnalysisRequest, prepareWorkbenchOptimization, readOptimizationSetup } from '../optimization/workbench';
import { interpretOptimizationTask } from '../optimization/intake';
import { adoptOptimization, parseOptimizationRequest, prepareOptimization, runOptimization } from '../optimization/run';
import { loadCandidateModel, loadOptimization, validSessionId, validRevisionId } from '../optimization/store';

export const optimizationsRouter = Router();
const busySessions = new Set<string>();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function handleOptimization(req: Request, res: Response): Promise<void> {
  return handleStart(req, res, false);
}

export async function handleAutomaticOptimization(req: Request, res: Response): Promise<void> {
  return handleStart(req, res, true);
}

async function handleStart(req: Request, res: Response, automatic: boolean, workbench = false): Promise<void> {
  let prepared: ReturnType<typeof prepareOptimization> & { baseline?: OptimizationEvaluation };
  try {
    const request = workbench ? parseWorkbenchAnalysisRequest(req.body) : automatic ? parseAutomaticOptimizationRequest(req.body) : parseOptimizationRequest(req.body);
    if (busySessions.has(request.sessionId)) { res.status(409).json({ error: '当前会话已有优化任务' }); return; }
    prepared = workbench ? prepareWorkbenchOptimization(req.body) : automatic ? prepareAutomaticOptimization(request) : prepareOptimization(parseOptimizationRequest(req.body));
  } catch (error) { res.status(400).json({ error: message(error) }); return; }
  const { run, model } = prepared;
  busySessions.add(run.sessionId);
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(new Error('任务已取消或连接断开')); };
  const timeout = setTimeout(() => abort.abort(new Error('已达到本轮五分钟预算')), OPTIMIZATION_POLICY.timeoutMs);
  req.on('aborted', cancel); res.on('close', cancel);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  try {
    await runOptimization(run, model, (event) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    }, abort.signal, { baseline: prepared.baseline });
  } catch (error) {
    // Persistence errors must also terminate the stream, not escape Express 4's async handler.
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify({ type: 'error', message: message(error) })}\n`);
  } finally {
    clearTimeout(timeout); req.off('aborted', cancel); res.off('close', cancel);
    busySessions.delete(run.sessionId);
    res.end();
  }
}

optimizationsRouter.post('/optimizations', handleOptimization);
optimizationsRouter.post('/optimizations/automatic', handleAutomaticOptimization);
optimizationsRouter.post('/optimizations/workbench', (req, res) => handleStart(req, res, false, true));
optimizationsRouter.get('/optimization-setup/:sessionId/:revisionId', (req, res) => {
  try { res.json(readOptimizationSetup(req.params.sessionId, req.params.revisionId)); }
  catch (error) { res.status(400).json({ error: message(error) }); }
});
optimizationsRouter.get('/optimization-analysis/:sessionId/:revisionId', (req, res) => {
  try { res.json({ analysis: latestWorkbenchAnalysis(req.params.sessionId, req.params.revisionId) }); }
  catch (error) { res.status(400).json({ error: message(error) }); }
});

async function handleWorkbenchAction(req: Request, res: Response, intake: boolean) {
  let sessionId: string;
  try { sessionId = parseAutomaticOptimizationRequest(req.body).sessionId; }
  catch (error) { res.status(400).json({ error: message(error) }); return; }
  if (busySessions.has(sessionId)) { res.status(409).json({ error: '当前项目已有任务执行中' }); return; }
  busySessions.add(sessionId);
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(new Error('任务已停止')); };
  res.on('close', cancel);
  const timeout = setTimeout(() => abort.abort(new Error('任务达到时间上限')), OPTIMIZATION_POLICY.timeoutMs);
  try {
    const result = intake ? await interpretOptimizationTask(req.body, abort.signal)
      : await analyzeWorkbench(parseWorkbenchAnalysisRequest(req.body), abort.signal);
    if (!res.destroyed) res.json(result);
  } catch (error) { if (!res.destroyed) res.status(400).json({ error: message(error) }); }
  finally { clearTimeout(timeout); res.off('close', cancel); busySessions.delete(sessionId); }
}
optimizationsRouter.post('/optimization-analysis', (req, res) => handleWorkbenchAction(req, res, false));
optimizationsRouter.post('/optimization-task', (req, res) => handleWorkbenchAction(req, res, true));
optimizationsRouter.get('/optimizations/:sessionId/latest', (req, res) => {
  const { sessionId } = req.params, revisionId = req.query.revisionId;
  if (!validSessionId(sessionId) || !validRevisionId(revisionId)) { res.status(400).json({ error: '无效方案' }); return; }
  const dir = path.join(workspacesDir, sessionId, 'optimizations');
  const runs = fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((id) => {
    try { const run = loadOptimization(sessionId, id); return run.baseRevisionId === revisionId || run.adopted?.revisionId === revisionId ? [run] : []; }
    catch { return []; }
  }) : [];
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ run: runs[0] ?? null });
});
optimizationsRouter.get('/optimizations/:sessionId/:runId/candidates/:candidateId', (req, res) => {
  try {
    const run = loadOptimization(req.params.sessionId, req.params.runId);
    res.json(loadCandidateModel(run, req.params.candidateId));
  } catch (error) { res.status(404).json({ error: message(error) }); }
});
optimizationsRouter.get('/optimizations/:sessionId/:runId/baseline', (req, res) => {
  try { res.json(loadOptimizationBaselineView(req.params.sessionId, req.params.runId)); }
  catch (error) { res.status(409).json({ error: message(error) }); }
});
optimizationsRouter.get('/optimizations/:sessionId/:runId/candidates/:candidateId/comparison', (req, res) => {
  try {
    res.json(loadOptimizationComparison(req.params.sessionId, req.params.runId, req.params.candidateId));
  } catch (error) { res.status(409).json({ error: message(error) }); }
});
optimizationsRouter.post('/optimizations/:sessionId/:runId/adopt', (req, res) => {
  try {
    const { candidateId, expectedBaseRevisionId } = req.body ?? {};
    if (typeof candidateId !== 'string' || !validRevisionId(expectedBaseRevisionId)) throw new Error('缺少候选或基线版本');
    res.json({ revisionId: adoptOptimization(req.params.sessionId, req.params.runId, candidateId, expectedBaseRevisionId) });
  } catch (error) { res.status(409).json({ error: message(error) }); }
});
