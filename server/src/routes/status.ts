import { Router } from 'express';
import { CAPABILITIES, PROVIDERS } from '@sdd/shared';

export const statusRouter = Router();

statusRouter.get('/status', (_req, res) => {
  res.json({ providers: PROVIDERS, capabilities: CAPABILITIES });
});
