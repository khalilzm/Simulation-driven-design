import { Router } from 'express';
import { handleSpaceTurn } from './spaceTurn';

export const chatRouter = Router();

chatRouter.post('/chat', (req, res) => handleSpaceTurn(req, res));
