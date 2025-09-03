const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const WSS_URL = `ws://localhost:${PORT}`;

console.log('Testing Local WebSocket Server - SYS Block Filter');
console.log('==================================================');
console.log('Connecting to:', WSS_URL);
console.log('This WebSocket will ONLY receive blocks containing "SYS" pattern');
console.log('The server monitors ALL Bitcoin blocks but filters them');
console.log('');

const ws = new WebSocket(WSS_URL);

ws.on('open', () => {
    console.log('Connected to local WebSocket server');
    console.log('');

    // Subscribe to SYS block updates
    console.log('Subscribing to SYS block updates...');
    ws.send(JSON.stringify({
        action: 'subscribe'
    }));

    // Request current blocks after 1 second
    setTimeout(() => {
        console.log('Requesting current SYS blocks...');
        ws.send(JSON.stringify({
            action: 'get_blocks'
        }));
    }, 1000);
});

ws.on('message', (data) => {
    try {
        const message = JSON.parse(data.toString());

        switch(message.type) {
            case 'welcome':
                console.log('Welcome message received');
                console.log(`   Current SYS blocks count: ${message.totalBlocks}`);
                if (message.currentBlocks && message.currentBlocks.length > 0) {
                    console.log(`   Latest block: ${message.currentBlocks[0].blockHash}`);
                }
                break;

            case 'subscribed':
                console.log('Subscription confirmed');
                console.log(`   ${message.message}`);
                break;

            case 'blocks':
                console.log('Blocks list received');
                console.log(`   Total blocks: ${message.totalBlocks}`);
                if (message.blocks && message.blocks.length > 0) {
                    console.log('   Last 3 blocks:');
                    message.blocks.slice(0, 3).forEach(block => {
                        console.log(`     - Height: ${block.blockHeight}, Hash: ${block.blockHash.substring(0, 10)}...`);
                        console.log(`       Pool: ${block.pool?.name || 'Unknown'} (${block.pool?.slug || 'unknown'})`);
                        console.log(`       Icon: ${block.pool?.icon || 'No icon'}`);
                        console.log(`       Pattern: ${block.ascii}`);
                    });
                }
                break;

            case 'new_sys_block':
                console.log('');
                console.log('NEW SYS BLOCK DETECTED!');
                console.log(`   Block Height: ${message.block.blockHeight}`);
                console.log(`   Block Hash: ${message.block.blockHash}`);
                console.log(`   Pool: ${message.block.pool?.name || 'Unknown'} (${message.block.pool?.slug || 'unknown'})`);
                console.log(`   Pool Icon: ${message.block.pool?.icon || 'No icon'}`);
                console.log(`   Pattern found: ${message.block.ascii}`);
                console.log(`   Location: ${message.block.matchedWhere}`);
                console.log(`   Timestamp: ${new Date(message.block.timestamp * 1000).toISOString()}`);
                break;

            default:
                console.log('Other message:', JSON.stringify(message, null, 2));
        }
    } catch (error) {
        console.log('Raw message:', data.toString());
    }
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
    console.log('');
    console.log('Make sure the server is running with: npm start');
});

ws.on('close', (code, reason) => {
    console.log('');
    console.log(`🔌 Connection closed - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    process.exit(0);
});

// Keep connection alive with ping every 25 seconds
const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('🏓 Ping sent');
    }
}, 25000);

// Allow manual exit
console.log('');
console.log('Press Ctrl+C to stop the test');
console.log('Waiting for SYS blocks...');
console.log('');

process.on('SIGINT', () => {
    console.log('\n👋 Closing connection...');
    clearInterval(keepAlive);
    ws.close();
    process.exit(0);
});
