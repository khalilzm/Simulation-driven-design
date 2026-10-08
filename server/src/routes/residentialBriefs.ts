import { Router } from 'express';
import { loadResidentialBrief, saveResidentialBrief } from '../design/residentialBrief';
export const residentialBriefsRouter = Router();
residentialBriefsRouter.get('/residential-briefs/:sessionId/:revisionId', (req,res) => {
  try { res.json(loadResidentialBrief(req.params.sessionId,req.params.revisionId).document); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
residentialBriefsRouter.put('/residential-briefs/:sessionId/:revisionId', (req,res) => {
  try { res.json(saveResidentialBrief(req.params.sessionId,req.params.revisionId,req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
