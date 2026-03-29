const role = (process.env.APP_ROLE || 'tracker').toLowerCase();

if (role === 'peer') {
  require('./start-peer.js');
} else {
  require('./dist/main/tracker/index.js');
}
