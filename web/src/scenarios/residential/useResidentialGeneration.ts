import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { briefTurnPlan, createResidentialBrief, generationPrerequisites, sameResidentialBriefSemantics, parseResidentialBrief,
  type ResidentialBriefDocument,
  type CanvasModule, type ProviderId, type SpaceModel } from '@sdd/shared';
import { interpretResidentialBrief, loadResidentialBrief, saveResidentialBrief } from '../../api';
import type { ChatMessage } from '../../types';
import { createRequestScope } from '../../workbench/requestScope';
import type { PreparedScenarioGeneration } from '../../workbench/scenarioGeneration';
import { interpretResidentialTurn, prepareResidentialGeneration, type ResidentialBriefDraft } from './generation';

interface Options {
  sessionId?: string; provider: ProviderId; base?: SpaceModel; draft?: ResidentialBriefDraft;
  ensureSessionId: () => string;
  onBriefChange: (brief: ResidentialBriefDraft['brief'], version: number, dirty: boolean, layout?: { graphLayoutVersion: number; layoutDirty: boolean }) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setBoards: Dispatch<SetStateAction<Set<CanvasModule>>>;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  scroll: () => void;
  abortRef: MutableRefObject<AbortController | undefined>;
}
type Preparation = { kind: 'handled' } | { kind: 'ready'; generation: PreparedScenarioGeneration };

/** Residential intent, requirement persistence and admission stay behind the scene boundary. */
export function useResidentialGeneration(options: Options) {
  const scope = useRef(createRequestScope()).current;
  const { sessionId, provider, base, draft } = options;
  const context = (sid?: string) => JSON.stringify([sid, provider, base?.model.revisionId]);
  const activeContext = useRef(context(sessionId));
  activeContext.current = context(sessionId);
  scope.setContext(activeContext.current);
  const previous = useRef({ base, draft });
  if (previous.current.base !== base || previous.current.draft?.version !== draft?.version
    || previous.current.draft?.dirty !== draft?.dirty
    || (!!previous.current.draft !== !!draft)
    || (previous.current.draft && draft && !sameResidentialBriefSemantics(previous.current.draft.brief, draft.brief))) scope.invalidateAll();
  previous.current = { base, draft };
  useEffect(() => () => scope.invalidateAll(), [scope]);

  const reply = (message: string, content: string) => {
    options.setMessages(current => [...current,
      { id: crypto.randomUUID(), role: 'user', content: message },
      { id: crypto.randomUUID(), role: 'assistant', content }]);
    options.setNotice(content); options.scroll();
  };

  const prepareMessage = async (message: string): Promise<Preparation> => {
    const currentBrief = draft?.brief ?? createResidentialBrief(base?.model.revisionId ?? 'rev-1');
    const asksForPlan = /生成(方案|户型|平面|候选)|开始生成|出方案/.test(message);
    const plan = asksForPlan ? { modules: [] } : briefTurnPlan(message, currentBrief.rooms.length);
    if (plan.reply) { reply(message, plan.reply); return { kind: 'handled' }; }
    const missing = generationPrerequisites(base, draft?.brief, draft?.version, draft?.dirty);
    if (!plan.modules.length && (!sessionId || missing.length)) {
      reply(message, `生成方案前，请先完成：${missing.join('、') || '创建工作区'}。完成并保存后，可继续对话生成方案。`);
      return { kind: 'handled' };
    }
    const sid = plan.modules.length ? options.ensureSessionId() : sessionId!;
    activeContext.current = context(sid);
    scope.setContext(activeContext.current);
    const token = scope.begin('prepare');
    const controller = new AbortController(); options.abortRef.current = controller;
    const assertActive = () => {
      controller.signal.throwIfAborted();
      if (!scope.isCurrent(token)) throw new Error('工作区输入已变化');
    };
    options.setBusy(true);
    let assistantId: string | undefined;
    try {
      const load = (revisionId: string) => loadResidentialBrief(sid, revisionId, controller.signal);
      if (!plan.modules.length) {
        const generation = await prepareResidentialGeneration(sid, base, draft, load, assertActive);
        assertActive();
        return { kind: 'ready', generation };
      }
      assistantId = crypto.randomUUID();
      options.setMessages(current => [...current,
        { id: crypto.randomUUID(), role: 'user', content: message },
        { id: assistantId!, role: 'assistant', content: 'Agent 正在整理需求…', status: 'thinking' }]);
      options.scroll();
      let previousDocument: ResidentialBriefDocument = { brief: currentBrief, baseModelHash: '', version: draft?.version ?? 0,
        graphLayoutVersion: draft?.graphLayoutVersion ?? 0, updatedAt: '' };
      if (!base) {
        const raw = localStorage.getItem(`sdd.residentialBriefDraft:${sid}`);
        previousDocument = raw ? JSON.parse(raw) : { brief: createResidentialBrief(currentBrief.baseRevisionId), baseModelHash: '', version: 0, updatedAt: '' };
        previousDocument.brief = parseResidentialBrief(previousDocument.brief);
      }
      const result = await interpretResidentialTurn(plan.modules, currentBrief, draft?.version ?? 0, base, {
        load,
        save: (document, brief) => saveResidentialBrief(sid, document, brief, controller.signal),
        interpret: (module, brief) => interpretResidentialBrief(provider, sid, module, message, brief, controller.signal),
        saveLocal: document => localStorage.setItem(`sdd.residentialBriefDraft:${sid}`, JSON.stringify(document)),
        assertActive,
      }, previousDocument);
      assertActive();
      if (result.document) options.onBriefChange(result.document.brief, result.document.version, false, { graphLayoutVersion: result.document.graphLayoutVersion ?? 0, layoutDirty: false });
      options.setBoards(current => new Set([...current, ...result.boards]));
      const artifacts = result.boards.map(module => ({ module }));
      options.setMessages(current => current.map(item => item.id === assistantId
        ? { ...item, content: result.reply, status: 'done', artifact: artifacts[0], artifacts } : item));
      options.setNotice(result.reply);
    } catch (error) {
      if (scope.isCurrent(token)) {
        const content = controller.signal.aborted ? '任务已停止' : error instanceof Error ? error.message : String(error);
        if (assistantId) options.setMessages(current => current.map(item => item.id === assistantId ? { ...item, content, status: 'failed' } : item));
        options.setNotice(content);
      } else if (assistantId && activeContext.current === token.context) {
        // Settle this message only; obsolete preparation cannot publish artifacts or a new notice.
        options.setMessages(current => current.map(item => item.id === assistantId
          ? { ...item, content: '工作区输入已变化，请重新提交需求', status: 'failed' } : item));
      }
    } finally {
      if (options.abortRef.current === controller) { options.abortRef.current = undefined; options.setBusy(false); }
    }
    return { kind: 'handled' };
  };
  return { prepareMessage };
}
