const http = require('http');

const projectId = process.env.FIREBASE_PROJECT_ID || 'YOUR_PROJECT_ID';
const payload = JSON.stringify({ level0: 'services', path: [], max_options: 60 });

const req = http.request(
  {
    hostname: 'localhost',
    port: 5001,
    path: `/${projectId}/us-central1/api/next-options`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      console.log(data.slice(0, 1200));
    });
  }
);

req.on('error', (err) => console.error('Request failed:', err.message));
req.write(payload);
req.end();
