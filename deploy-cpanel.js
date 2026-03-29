#!/usr/bin/env node

/**
 * cPanel Deployment Script for PubWeb
 * Usage: node deploy-cpanel.js <api-token> [hostname]
 */

const https = require('https');
const http = require('http');
const path = require('path');

const apiToken = process.argv[2];
const hostname = process.argv[3] || 'server146.web-hosting.com';
const username = 'pubwvxel';

if (!apiToken) {
  console.error('❌ Error: API token required');
  console.error('Usage: node deploy-cpanel.js <api-token> [hostname]');
  process.exit(1);
}

console.log(`🚀 Deploying PubWeb to cPanel (${hostname})\n`);

/**
 * Make a cPanel UAPI call
 */
function cpanelRequest(method, moduleName, functionName, params = {}) {
  return new Promise((resolve, reject) => {
    const queryString = new URLSearchParams(params).toString();
    const url = `${method === 'GET' ? 
      `https://${hostname}:2087/execute/${moduleName}/${functionName}?${queryString}` :
      `https://${hostname}:2087/execute/${moduleName}/${functionName}`}`;

    const options = {
      hostname,
      port: 2087,
      path: `/execute/${moduleName}/${functionName}${method === 'GET' ? `?${queryString}` : ''}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      rejectUnauthorized: false, // Self-signed certs on cPanel
    };

    if (method === 'POST' && Object.keys(params).length > 0) {
      const postData = new URLSearchParams(params).toString();
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors && json.errors.length > 0) {
            reject(new Error(`cPanel API Error: ${json.errors[0]}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Invalid cPanel response: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (method === 'POST' && Object.keys(params).length > 0) {
      req.write(new URLSearchParams(params).toString());
    }
    req.end();
  });
}

/**
 * Get account home directory
 */
async function getAccountInfo() {
  console.log('📋 Getting account info...');
  try {
    const result = await cpanelRequest('GET', 'Account', 'get_user_info');
    const homeDir = result.data.home_dir;
    console.log(`✅ Home directory: ${homeDir}\n`);
    return homeDir;
  } catch (err) {
    console.error('❌ Failed to get account info:', err.message);
    throw err;
  }
}

/**
 * Create a directory via cPanel
 */
async function createDirectory(dir) {
  console.log(`📁 Creating directory: ${dir}`);
  try {
    const result = await cpanelRequest('POST', 'Fileman', 'mkdir', { dir });
    console.log(`✅ Directory created\n`);
    return result;
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log(`⚠️  Directory already exists\n`);
    } else {
      console.error('❌ Failed to create directory:', err.message);
      throw err;
    }
  }
}

/**
 * Create a cron job to deploy PubWeb
 */
async function createDeploymentCron(homeDir) {
  console.log('⏱️  Creating deployment cron job...');
  
  const deployScript = `#!/bin/bash
cd ${homeDir}
rm -rf pubweb
git clone https://github.com/skyeknighton/pubweb.git
cd pubweb
npm install
npm run build
cp .env.example .env

# Update .env with server IP
# You'll need to manually edit this in cPanel file manager
cat > .env << 'ENVEOF'
TRACKER_URL=http://162.213.255.41:4000
PEER_PORT=3000
TRACKER_PORT=4000
NODE_ENV=production
ENVEOF

npm install -g pm2
pm2 start dist/main/tracker/index.js --name "tracker"
pm2 start start-peer.js --name "peer"
pm2 startup
pm2 save
`;

  try {
    // Create a script file via cPanel File Manager
    // For now, we'll provide instructions to do this manually
    console.log('✅ Deployment script ready\n');
    console.log('📝 Next steps (do these manually in cPanel):');
    console.log('1. Go to File Manager in cPanel');
    console.log('2. Create pubweb.sh with this content:');
    console.log('---');
    console.log(deployScript);
    console.log('---');
    console.log('3. Go to Cron Jobs');
    console.log('4. Add new cron: /bin/bash $HOME/pubweb.sh');
    console.log('5. Run once now');
    console.log('\n');
  } catch (err) {
    console.error('❌ Failed to create cron:', err.message);
    throw err;
  }
}

/**
 * Main deployment flow
 */
async function deploy() {
  try {
    const homeDir = await getAccountInfo();
    await createDirectory(`${homeDir}/pubweb`);
    await createDeploymentCron(homeDir);
    
    console.log('🎉 Deployment setup complete!');
    console.log('\n📌 Manual Next Steps:');
    console.log('1. Go to cPanel File Manager');
    console.log('2. Navigate to your home directory');
    console.log('3. Create pubweb.sh with the deployment script above');
    console.log('4. Go to Cron Jobs and add the script');
    console.log('5. Run it, then verify: curl http://162.213.255.41:4000/\n');
  } catch (err) {
    console.error('💥 Deployment failed:', err.message);
    process.exit(1);
  }
}

deploy();
