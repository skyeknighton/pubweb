const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/status',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  res.on('data', (chunk) => {
    console.log('Response:', chunk.toString());
  });
});

req.on('error', (e) => {
  console.error('Request failed:', e.message);
});

req.end();