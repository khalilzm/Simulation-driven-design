import express from 'express';
import { config, workspacesDir } from './config';
import { interruptActiveGenerations, recoverInterruptedGenerations } from './generation/lifecycle';
import { statusRouter } from './routes/status';
import { chatRouter } from './routes/chat';
import { sessionsRouter } from './routes/sessions';
import { uploadsRouter } from './routes/uploads';
import { designsRouter } from './routes/designs';
import { sunlightRouter } from './routes/sunlight';
import { pedestrianRouter } from './routes/pedestrian';
import { examplesRouter } from './routes/examples';
import { sketchesRouter } from './routes/sketches';
import { optimizationsRouter } from './routes/optimizations';
import { serveWeb } from './static';
import { residentialBriefsRouter } from './routes/residentialBriefs';
import { canvasRouter } from './routes/canvas';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use('/api', statusRouter);
app.use('/api', chatRouter);
app.use('/api', sessionsRouter);
app.use('/api', canvasRouter);
app.use('/api', uploadsRouter);
app.use('/api', residentialBriefsRouter);
app.use('/api', designsRouter);
app.use('/api', sunlightRouter);
app.use('/api', pedestrianRouter);
app.use('/api', examplesRouter);
app.use('/api', sketchesRouter);
app.use('/api', optimizationsRouter);

serveWeb(app);

const server = app.listen(config.port, config.host, () => {
  const recovered = recoverInterruptedGenerations(workspacesDir);
  if (recovered) console.log(`[sdd] marked ${recovered} interrupted generation(s)`);
  console.log(`[sdd] listening on http://${config.host}:${config.port}`);
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `[sdd] ${config.port} 已被占用；请保留一个开发服务实例` : error);
  process.exit(1);
});
let stopping = false;
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  interruptActiveGenerations();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
