const { Database } = require('./dist/main/db');
const { startPeerServer } = require('./dist/main/peer/server');

async function startPeer() {
  console.log('Initializing database...');
  const db = new Database('./pubweb.db');
  await db.init();
  console.log('Database initialized');

  console.log('Starting peer server...');
  const server = await startPeerServer(db);
  console.log('Peer server started and running...');
}

startPeer().catch(err => {
  console.error('Failed to start peer:', err);
  process.exit(1);
});