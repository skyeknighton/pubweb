const { Database } = require('./dist/main/db');
const { startPeerServer } = require('./dist/main/peer/server');
const fs = require('fs');
const path = require('path');

async function startPeer() {
  console.log('Initializing database...');
  const dbPath = process.env.PEER_DB_PATH || './pubweb.db';
  const dbDir = path.dirname(dbPath);
  if (dbDir && dbDir !== '.') {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(dbPath);
  await db.init();
  console.log('Database initialized');

  console.log('Starting peer server...');
  const server = await startPeerServer(db);
  console.log('Peer server started and running...');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}, shutting down peer...`);

    try {
      await server.stop();
      db.close();
      console.log('Peer shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('Peer shutdown failed:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

startPeer().catch(err => {
  console.error('Failed to start peer:', err);
  process.exit(1);
});