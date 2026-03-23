const http = require('http');

const data = JSON.stringify({
  html: '<h1>Hello PubWeb!</h1><p>This is our first test page on the decentralized web.</p>',
  title: 'First Test Page',
  tags: ['test', 'demo', 'pubweb']
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/publish',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  res.on('data', (chunk) => {
    const result = JSON.parse(chunk.toString());
    console.log('Published page with hash:', result.hash);
    console.log('Page URL: http://localhost:3000/page/' + result.hash);
  });
});

req.on('error', (e) => {
  console.error('Request failed:', e.message);
});

req.write(data);
req.end();