const express = require('express');
const axios = require('axios');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Store connected WebSocket clients
const wsClients = new Set();

const MEMPOOL_API_BASE = 'https://mempool.space/api';
const WS_URL = 'wss://mempool.space/api/v1/ws';
const POOL_LOGO_BASE = 'https://raw.githubusercontent.com/mempool/mining-pool-logos/master';

// Store for SYS blocks
const sysBlocks = [];
const processedBlocks = new Set();

// Helper functions for hex/ascii conversion
function hexToAscii(hex) {
  try {
    const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
    let output = '';
    for (let i = 0; i < clean.length; i += 2) {
      const byte = parseInt(clean.substring(i, i + 2), 16);
      if (Number.isNaN(byte)) continue;
      output += (byte >= 0x20 && byte <= 0x7e) ? String.fromCharCode(byte) : '.';
    }
    return output;
  } catch (e) {
    return '';
  }
}

// Extract OP_RETURN data from script
function extractOpReturnFromHexScript(scriptHex) {
  if (!scriptHex) return null;
  const h = scriptHex.toLowerCase().replace(/[^0-9a-f]/g, '');
  let i = 0;
  let out = '';

  const readByte = () => {
    const b = parseInt(h.substr(i, 2), 16);
    i += 2;
    return b;
  };

  const readLE = (bytes) => {
    let v = 0;
    for (let j = 0; j < bytes; j++) {
      v |= parseInt(h.substr(i + j * 2, 2), 16) << (8 * j);
    }
    i += bytes * 2;
    return v;
  };

  while (i < h.length) {
    const op = readByte();
    if (op === 0x6a) { // OP_RETURN
      while (i < h.length) {
        const b = parseInt(h.substr(i, 2), 16);
        if (Number.isNaN(b)) break;

        if (b >= 1 && b <= 75) { // Direct push
          i += 2;
          out += h.substr(i, b * 2);
          i += b * 2;
          continue;
        }
        if (b === 0x4c) { // PUSHDATA1
          i += 2;
          const len = readByte();
          out += h.substr(i, len * 2);
          i += len * 2;
          continue;
        }
        if (b === 0x4d) { // PUSHDATA2
          i += 2;
          const len = readLE(2);
          out += h.substr(i, len * 2);
          i += len * 2;
          continue;
        }
        if (b === 0x4e) { // PUSHDATA4
          i += 2;
          const len = readLE(4);
          out += h.substr(i, len * 2);
          i += len * 2;
          continue;
        }
        break;
      }
      return out || null;
    }
  }
  return null;
}

// Check if hex contains pattern
function hexContainsSys(hexString) {
  if (!hexString) return false;
  const hex = hexString.toLowerCase();
  const sysHex = '737973'; // 'sys' in hex
  return hex.includes(sysHex);
}

// Extract SYS pattern from transaction
function extractSysFromTx(tx) {
  if (!tx || !Array.isArray(tx.vout)) return null;

  for (const vout of tx.vout) {
    if (vout && (vout.scriptpubkey_type === 'op_return' ||
        (vout.scriptpubkey_asm && vout.scriptpubkey_asm.indexOf('OP_RETURN') === 0))) {
      const dataHex = extractOpReturnFromHexScript(vout.scriptpubkey);
      if (dataHex && hexContainsSys(dataHex)) {
        return {
          where: 'OP_RETURN',
          dataHex,
          ascii: hexToAscii(dataHex)
        };
      }
    }
  }
  return null;
}

// Get block details with transactions
async function getBlockWithTxs(blockHash) {
  try {
    const response = await axios.get(`${MEMPOOL_API_BASE}/block/${blockHash}`);
    return response.data;
  } catch (error) {
    console.error('Error fetching block:', error.message);
    throw error;
  }
}

// Get coinbase transaction
async function getCoinbaseTx(blockHash) {
  try {
    const response = await axios.get(`${MEMPOOL_API_BASE}/block/${blockHash}/txs`);
    return response.data && response.data[0];
  } catch (error) {
    console.error('Error fetching coinbase tx:', error.message);
    return null;
  }
}

// Pool detection patterns
const POOL_PATTERNS = [
  { re: /(secpool|sec *pool)/i, name: "SECPOOL", slug: "secpool" },
  { re: /(spider ?pool|spiderpool)/i, name: "SpiderPool", slug: "spiderpool" },
  { re: /(binance( *pool)?|bnbpool)/i, name: "Binance Pool", slug: "binancepool" },
  { re: /(foundry|foundryusa)/i, name: "Foundry USA", slug: "foundryusa" },
  { re: /(antpool)/i, name: "AntPool", slug: "antpool" },
  { re: /(f2pool)/i, name: "F2Pool", slug: "f2pool" },
  { re: /(viabtc)/i, name: "ViaBTC", slug: "viabtc" },
  { re: /(btc[.]com|btccom)/i, name: "BTC.com", slug: "btccom" },
  { re: /(luxor)/i, name: "Luxor", slug: "luxor" },
  { re: /(mara|marapool)/i, name: "MARA Pool", slug: "marapool" },
  { re: /(sbicrypto|sbi.*crypto)/i, name: "SBI Crypto", slug: "sbicrypto" }
];

// Detect pool from coinbase scriptSig
function detectPoolFromScriptSig(scriptSigHex) {
  const ascii = hexToAscii(scriptSigHex);
  for (const pattern of POOL_PATTERNS) {
    if (pattern.re.test(ascii)) {
      return {
        name: pattern.name,
        slug: pattern.slug,
        icon: `${POOL_LOGO_BASE}/${pattern.slug}.svg`
      };
    }
  }
  return null;
}

// Get pool info with icon
function getPoolInfo(pool) {
  if (!pool) return { name: 'Unknown', slug: 'unknown', icon: `${POOL_LOGO_BASE}/default.svg` };
  
  // If pool already has icon, return as is
  if (pool.icon) return pool;
  
  // Add icon URL based on slug
  const slug = pool.slug || 'unknown';
  return {
    ...pool,
    icon: `${POOL_LOGO_BASE}/${slug}.svg`
  };
}

// Check block for SYS patterns
async function checkBlockForSys(blockHash) {
  try {
    const block = await getBlockWithTxs(blockHash);
    const coinbase = await getCoinbaseTx(blockHash);

    // Detect pool from block extras or scriptSig
    let poolInfo = block.extras?.pool || {};
    
    // If no pool detected from extras, try detecting from scriptSig
    if ((!poolInfo.name || !poolInfo.slug) && coinbase && coinbase.vin && coinbase.vin[0] && coinbase.vin[0].scriptsig) {
      const detectedPool = detectPoolFromScriptSig(coinbase.vin[0].scriptsig);
      if (detectedPool) {
        poolInfo = detectedPool;
      }
    }
    
    // Ensure pool has icon URL
    poolInfo = getPoolInfo(poolInfo);
    
    // Check coinbase scriptSig for 'sys'
    if (coinbase && coinbase.vin && coinbase.vin[0] && coinbase.vin[0].scriptsig) {
      const scriptSig = coinbase.vin[0].scriptsig;
      if (hexContainsSys(scriptSig)) {
        return {
          blockHeight: block.height,
          blockHash: block.id,
          timestamp: block.timestamp,
          pool: poolInfo,
          matchedWhere: 'coinbase_scriptSig',
          matchedTxid: coinbase.txid,
          dataHex: scriptSig,
          ascii: hexToAscii(scriptSig)
        };
      }
    }

    // Check coinbase OP_RETURN
    if (coinbase) {
      const sysMatch = extractSysFromTx(coinbase);
      if (sysMatch) {
        return {
          blockHeight: block.height,
          blockHash: block.id,
          timestamp: block.timestamp,
          pool: poolInfo,
          matchedWhere: 'coinbase_' + sysMatch.where,
          matchedTxid: coinbase.txid,
          dataHex: sysMatch.dataHex,
          ascii: sysMatch.ascii
        };
      }
    }

    // Check other transactions (paginated)
    let page = 1; // Start at page 1 since page 0 is coinbase
    while (page < 10) { // Limit pages to avoid overload
      try {
        const startIndex = page * 25;
        const txsResponse = await axios.get(`${MEMPOOL_API_BASE}/block/${blockHash}/txs?start_index=${startIndex}`);
        const txs = txsResponse.data;

        if (!txs || !txs.length) break;

        for (const tx of txs) {
          const sysMatch = extractSysFromTx(tx);
          if (sysMatch) {
            return {
              blockHeight: block.height,
              blockHash: block.id,
              timestamp: block.timestamp,
              pool: poolInfo,
              matchedWhere: sysMatch.where,
              matchedTxid: tx.txid,
              dataHex: sysMatch.dataHex,
              ascii: sysMatch.ascii
            };
          }
        }
        page++;
      } catch (e) {
        break;
      }
    }

    return null;
  } catch (error) {
    console.error('Error checking block for SYS:', error.message);
    return null;
  }
}

// Scan recent blocks
async function scanRecentBlocks(limit = 50) {
  try {
    const response = await axios.get(`${MEMPOOL_API_BASE}/blocks`);
    const blocks = response.data.slice(0, limit);

    const results = [];
    for (const blockInfo of blocks) {
      if (processedBlocks.has(blockInfo.id)) continue;

      processedBlocks.add(blockInfo.id);
      const sysMatch = await checkBlockForSys(blockInfo.id);

      if (sysMatch) {
        sysBlocks.unshift(sysMatch);
        if (sysBlocks.length > 100) sysBlocks.pop(); // Keep last 100
        results.push(sysMatch);

        // Broadcast new SYS block to all connected WebSocket clients
        broadcastToClients({
          type: 'new_sys_block',
          block: sysMatch,
          totalBlocks: sysBlocks.length,
          timestamp: new Date().toISOString()
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Error scanning blocks:', error.message);
    return [];
  }
}

// WebSocket server event handlers
wss.on('connection', (wsClient, req) => {
  console.log('New WebSocket client connected from:', req.socket.remoteAddress);
  wsClients.add(wsClient);

  // Send welcome message with current SYS blocks
  wsClient.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to SYS blocks filter - receiving ONLY blocks containing SYS pattern',
    description: 'This WebSocket filters Bitcoin blocks from mempool.space and only sends you blocks containing "SYS"',
    currentBlocks: sysBlocks,
    totalBlocks: sysBlocks.length,
    timestamp: new Date().toISOString()
  }));

  // Handle messages from client
  wsClient.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received from client:', data);

      // Handle different message types
      if (data.action === 'subscribe') {
        wsClient.send(JSON.stringify({
          type: 'subscribed',
          message: 'Successfully subscribed to SYS blocks updates',
          timestamp: new Date().toISOString()
        }));
      } else if (data.action === 'get_blocks') {
        wsClient.send(JSON.stringify({
          type: 'blocks',
          blocks: sysBlocks,
          totalBlocks: sysBlocks.length,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.error('Error parsing client message:', error);
      wsClient.send(JSON.stringify({
        type: 'error',
        message: 'Invalid JSON message',
        timestamp: new Date().toISOString()
      }));
    }
  });

  // Handle pong (keepalive response)
  wsClient.on('pong', () => {
    console.log('Pong received from client');
  });

  // Handle client disconnect
  wsClient.on('close', () => {
    console.log('WebSocket client disconnected');
    wsClients.delete(wsClient);
  });

  // Handle errors
  wsClient.on('error', (error) => {
    console.error('WebSocket client error:', error);
    wsClients.delete(wsClient);
  });
});

// Broadcast function to send messages to all connected clients
function broadcastToClients(message) {
  const data = JSON.stringify(message);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// WebSocket connection for real-time blocks from mempool.space
let ws = null;
let reconnectTimeout = null;

function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('WebSocket connected to mempool.space');
      // Subscribe to new blocks
      ws.send(JSON.stringify({ action: 'want', data: ['blocks'] }));

      // Keepalive ping every 25 seconds
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        } else {
          clearInterval(pingInterval);
        }
      }, 25000);
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const blockHash = msg.block?.hash || msg.block?.id || msg.hash || msg.id;

        if (blockHash && !processedBlocks.has(blockHash)) {
          processedBlocks.add(blockHash);
          console.log(`[Mempool] New block received: ${blockHash}`);

          // Check if this block contains SYS
          const sysMatch = await checkBlockForSys(blockHash);
          
          if (sysMatch) {
            // Found SYS in this block!
            sysBlocks.unshift(sysMatch);
            if (sysBlocks.length > 100) sysBlocks.pop();
            
            console.log(`✅ [SYS FOUND] Block ${blockHash} contains SYS pattern!`);
            console.log(`   Pool: ${sysMatch.pool?.name || 'Unknown'} (${sysMatch.pool?.slug || 'unknown'})`);
            console.log(`   Pattern: ${sysMatch.ascii}`);
            console.log(`   Icon: ${sysMatch.pool?.icon || 'default'}`);
            console.log(`   Broadcasting to ${wsClients.size} connected clients...`);

            // Broadcast ONLY SYS blocks to all connected WebSocket clients
            broadcastToClients({
              type: 'new_sys_block',
              block: sysMatch,
              totalBlocks: sysBlocks.length,
              timestamp: new Date().toISOString()
            });
          } else {
            console.log(`   [No SYS] Block ${blockHash} checked - no SYS pattern found`);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      console.log('WebSocket disconnected');
      // Reconnect after 3 seconds
      reconnectTimeout = setTimeout(connectWebSocket, 3000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      ws.close();
    });

  } catch (error) {
    console.error('Failed to connect WebSocket:', error.message);
    reconnectTimeout = setTimeout(connectWebSocket, 5000);
  }
}

// API Routes

app.get('/api/syscoin/blocks', async (req, res) => {
  try {
    const { rescan, limit } = req.query;

    if (rescan === 'true') {
      const newMatches = await scanRecentBlocks(parseInt(limit) || 50);
      return res.json({
        success: true,
        message: 'Rescan completed',
        newMatches: newMatches.length,
        blocks: sysBlocks,
        totalBlocks: sysBlocks.length
      });
    }

    res.json({
      success: true,
      blocks: sysBlocks,
      totalBlocks: sysBlocks.length,
      processedBlocksCount: processedBlocks.size
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Syscoin blocks',
      message: error.message
    });
  }
});

app.get('/api/syscoin/blocks/scan', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const results = await scanRecentBlocks(limit);

    res.json({
      success: true,
      scanned: limit,
      found: results.length,
      blocks: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Scan failed',
      message: error.message
    });
  }
});

app.get('/api/syscoin/block/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const result = await checkBlockForSys(hash);

    if (result) {
      res.json({
        success: true,
        found: true,
        block: result
      });
    } else {
      res.json({
        success: true,
        found: false,
        message: 'No SYS pattern found in block'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to check block',
      message: error.message
    });
  }
});

app.get('/api/syscoin/stats', (req, res) => {
  const poolCounts = {};
  sysBlocks.forEach(block => {
    const poolName = block.pool?.name || 'Unknown';
    poolCounts[poolName] = (poolCounts[poolName] || 0) + 1;
  });

  res.json({
    success: true,
    totalSysBlocks: sysBlocks.length,
    processedBlocks: processedBlocks.size,
    poolDistribution: poolCounts,
    websocketStatus: ws ? ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected' : 'not initialized'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Syscoin Mining Blocks API',
    mempoolWebsocket: ws ? ws.readyState === WebSocket.OPEN : false,
    websocketServer: {
      active: true,
      connectedClients: wsClients.size
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server with WebSocket support running on port ${PORT}`);
  console.log(`\nHTTP endpoints:`);
  console.log(`  GET  http://localhost:${PORT}/api/syscoin/blocks - Get all found SYS blocks`);
  console.log(`  GET  http://localhost:${PORT}/api/syscoin/blocks/scan?limit=10 - Scan recent blocks for SYS`);
  console.log(`  GET  http://localhost:${PORT}/api/syscoin/block/:hash - Check specific block for SYS`);
  console.log(`  GET  http://localhost:${PORT}/api/syscoin/stats - Get statistics`);
  console.log(`  GET  http://localhost:${PORT}/api/health - Health check`);
  console.log(`\nWebSocket endpoint:`);
  console.log(`  WS   ws://localhost:${PORT} - Connect to receive real-time SYS block updates`);

  // Start WebSocket connection to mempool.space
  connectWebSocket();

  // Initial scan
  console.log('\nStarting initial scan for SYS blocks...');
  scanRecentBlocks(20).then(results => {
    console.log(`Initial scan complete. Found ${results.length} SYS blocks.`);
  });
});
