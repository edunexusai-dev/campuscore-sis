import { config } from './config.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { startIdentityProvisioningWorker } from './services/identityProvisioningService.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`CampusCore SIS API listening on ${config.publicApiUrl} (port ${config.port}, ${config.env})`);
  console.log(`  API docs: ${config.publicApiUrl}/api/docs`);
});

// University accounts follow the person registry automatically (see services/identityProvisioningService.js).
const provisioning = config.identitySync.enabled && !config.isTest ? startIdentityProvisioningWorker() : null;

const shutdown = async () => {
  server.close();
  await provisioning?.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
