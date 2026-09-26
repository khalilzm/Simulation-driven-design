import express from 'express';
import { config } from './config';
import { statusRouter } from './routes/status';
import { chatRouter } from './routes/chat';
import { sessionsRouter } from './routes/sessions';
import { uploadsRouter } from './routes/uploads';
import { designsRouter } from './routes/designs';
import { sunlightRouter } from './routes/sunlight';
import { examplesRouter } from './routes/examples';
import { serveWeb } from './static';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use('/api', statusRouter);
app.use('/api', chatRouter);
app.use('/api', sessionsRouter);
app.use('/api', uploadsRouter);
app.use('/api', designsRouter);
app.use('/api', sunlightRouter);
app.use('/api', examplesRouter);

serveWeb(app);

app.listen(config.port, config.host, () => {
  console.log(`[sdd] listening on http://${config.host}:${config.port}`);
});
