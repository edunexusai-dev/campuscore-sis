import { config } from './config.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`CampusCore SIS API listening on ${config.publicApiUrl} (port ${config.port}, ${config.env})`);
  console.log(`  API docs: ${config.publicApiUrl}/api/docs`);
});

const shutdown = async () => {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
