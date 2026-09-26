import { Router } from 'express';
import { loadSession } from '../sessions/store';

export const sessionsRouter = Router();

sessionsRouter.get('/sessions/:id', (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({
    sessionId: s.sessionId,
    provider: s.provider,
    nativeSessionId: s.nativeSessionId ?? null,
    messages: s.messages,
  });
});
