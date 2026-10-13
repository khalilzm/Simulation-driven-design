import { Router } from 'express';
import { CAPABILITIES, PROVIDERS } from '@sdd/shared';
import { listScenarioDefinitions } from '../scenarios/registry';

export const statusRouter = Router();

statusRouter.get('/status', (_req, res) => {
  res.json({ providers: PROVIDERS, capabilities: CAPABILITIES, scenarios: listScenarioDefinitions() });
});
