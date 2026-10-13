import { Router } from 'express';
import { loadCanvas, saveCanvas } from '../workbench/store';

export const canvasRouter = Router();
canvasRouter.get('/canvas/:sessionId', (req, res) => {
  try { res.json(loadCanvas(req.params.sessionId)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
canvasRouter.put('/canvas/:sessionId', (req, res) => {
  try { const saved = saveCanvas(req.params.sessionId, req.body?.snapshot); res.json({ updatedAt: saved.updatedAt }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
