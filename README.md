# Syscoin Mining Blocks API

A Node.js Express API that searches for Syscoin (SYS) markers in Bitcoin blocks using the Mempool.space API. Since Syscoin is merge-mined with Bitcoin, miners include "sys" patterns in Bitcoin blocks' OP_RETURN data or coinbase scriptSig.

## How It Works

The API scans Bitcoin blocks for the hexadecimal pattern `737973` (which is "sys" in ASCII) in:
1. **Coinbase scriptSig**: The input script of the coinbase transaction
2. **OP_RETURN outputs**: Data embedded in transactions using OP_RETURN
3. **All transactions**: Searches through all transactions in a block for SYS patterns

## Features

- Real-time WebSocket connection to Mempool.space for live block updates
- Automatic scanning of new blocks as they are mined
- Historical block scanning capability
- Pool detection and statistics
- In-memory storage of found SYS blocks

## Installation

```bash
npm install
```

## Usage

Start the server:
```bash
npm start
```

The server will run on port 3000 by default (configurable via .env file).

## API Endpoints

### 1. Get All Found SYS Blocks
```
GET /api/syscoin/blocks
```
Returns all blocks containing SYS patterns that have been found.

Optional query parameters:
- `rescan=true&limit=50` - Trigger a rescan of recent blocks

Example:
```bash
curl http://localhost:3000/api/syscoin/blocks
```

### 2. Scan Recent Blocks
```
GET /api/syscoin/blocks/scan?limit=10
```
Actively scans the specified number of recent blocks for SYS patterns.

Example:
```bash
curl http://localhost:3000/api/syscoin/blocks/scan?limit=50
```

### 3. Check Specific Block
```
GET /api/syscoin/block/:hash
```
Checks a specific block for SYS patterns.

Example:
```bash
curl http://localhost:3000/api/syscoin/block/00000000000000000001d82f543837f755256bb3f6d403faf7c63d6d334acfec
```

### 4. Get Statistics
```
GET /api/syscoin/stats
```
Returns statistics about found blocks, pool distribution, and WebSocket status.

Example:
```bash
curl http://localhost:3000/api/syscoin/stats
```

### 5. Health Check
```
GET /api/health
```
Returns the API health status and WebSocket connection state.

## Response Format

### Found SYS Block
```json
{
  "blockHeight": 913044,
  "blockHash": "00000000...",
  "timestamp": 1756924226,
  "pool": {
    "name": "Foundry USA",
    "slug": "foundryusa"
  },
  "matchedWhere": "coinbase_scriptSig",
  "matchedTxid": "b9f1531523...",
  "dataHex": "737973...",
  "ascii": "sys..."
}
```

### Statistics Response
```json
{
  "success": true,
  "totalSysBlocks": 25,
  "processedBlocks": 100,
  "poolDistribution": {
    "Foundry USA": 10,
    "AntPool": 8,
    "Unknown": 7
  },
  "websocketStatus": "connected"
}
```

## WebSocket API

### WebSocket Server

The server provides its own WebSocket endpoint that broadcasts ONLY blocks containing SYS patterns to connected clients.

**Endpoint**: `ws://localhost:3000`

### Connecting to the WebSocket

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
    // Subscribe to SYS block updates
    ws.send(JSON.stringify({ action: 'subscribe' }));
    
    // Request current SYS blocks
    ws.send(JSON.stringify({ action: 'get_blocks' }));
});

ws.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('Received:', message);
});
```

### Message Types

#### 1. Welcome Message (sent on connection)
```json
{
  "type": "welcome",
  "message": "Connected to SYS blocks filter - receiving ONLY blocks containing SYS pattern",
  "currentBlocks": [...],
  "totalBlocks": 25,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### 2. Subscribe Confirmation
Send: `{ "action": "subscribe" }`
Receive:
```json
{
  "type": "subscribed",
  "message": "Successfully subscribed to SYS blocks updates",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### 3. Get Current Blocks
Send: `{ "action": "get_blocks" }`
Receive:
```json
{
  "type": "blocks",
  "blocks": [...],
  "totalBlocks": 25,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### 4. New SYS Block (broadcast automatically)
```json
{
  "type": "new_sys_block",
  "block": {
    "blockHeight": 913044,
    "blockHash": "00000000...",
    "timestamp": 1756924226,
    "pool": {
      "name": "SpiderPool",
      "slug": "spiderpool",
      "icon": "https://raw.githubusercontent.com/mempool/mining-pool-logos/master/spiderpool.svg"
    },
    "matchedWhere": "coinbase_scriptSig",
    "matchedTxid": "b9f1531523...",
    "dataHex": "737973...",
    "ascii": "sys..."
  },
  "totalBlocks": 26,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Pool Information

Each block includes enhanced pool information:
- `name`: Display name of the mining pool
- `slug`: Unique identifier for the pool
- `icon`: Direct URL to the pool's logo (SVG format)

Supported pools include: SpiderPool, SECPOOL, Binance Pool, Foundry USA, AntPool, F2Pool, ViaBTC, BTC.com, Luxor, MARA Pool, and more.

### Testing the WebSocket

Use the included test client:
```bash
npm run test-ws
```

Or test with wscat:
```bash
# Install wscat
npm install -g wscat

# Connect to the WebSocket
wscat -c ws://localhost:3000

# Send messages
{"action": "subscribe"}
{"action": "get_blocks"}
```

### How It Works

1. The server connects to Mempool.space WebSocket and receives ALL new Bitcoin blocks
2. Each block is checked for SYS patterns ("sys" in hex: 737973)
3. ONLY blocks containing SYS are broadcast to connected clients
4. Clients receive real-time updates whenever a new SYS block is found

This filtering approach means clients only receive relevant data, reducing bandwidth and processing requirements.

## Mempool.space WebSocket Connection

The server internally maintains a WebSocket connection to Mempool.space to receive real-time block updates. When a new block is mined, it's automatically checked for SYS patterns and broadcast to connected clients if found.

## Environment Variables

Create a `.env` file with:
```
PORT=3000
```

## Notes

- The API uses in-memory storage, so found blocks are lost when the server restarts
- The WebSocket connection automatically reconnects if disconnected
- Initial scan runs on server startup to populate recent SYS blocks
- The API limits transaction scanning to avoid overloading the Mempool.space API