const { Database } = require('./dist/main/db');
const { startPeerServer } = require('./dist/main/peer/server');

async function test() {
  console.log('Initializing database...');
  const db = new Database('./test.db');
  await db.init();
  console.log('Database initialized');

  console.log('Starting peer server...');
  const server = await startPeerServer(db);
  console.log('Peer server started');
}

test().catch(console.error);