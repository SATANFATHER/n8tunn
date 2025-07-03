#!/usr/bin/env node

const WebSocket = require('ws');
const net = require('net');
const url = require('url'); // Needed for parsing server URL for logging

const argv = require('process').argv.slice(2);

let config = {
    serverUrl: null,
    localServiceHost: '127.0.0.1',
    localServicePort: null,
    forwardPort: null, // Extracted from serverUrl for logging/display
};

let ws = null;
let localTcpSocket = null;
let reconnectionTimeout = null;
let reconnectionAttempts = 0;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 60000; // 60 seconds

function parseArgs() {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--server')) {
            args.serverUrl = arg.includes('=') ? arg.split('=')[1] : argv[++i];
        } else if (arg.startsWith('--local-service') || arg.startsWith('--target')) { // Allow --target as per original prompt
            const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
            if (value.includes(':')) {
                const [host, port] = value.split(':');
                args.localServiceHost = host;
                args.localServicePort = parseInt(port, 10);
            } else {
                // Assume it's a port, use default host
                args.localServicePort = parseInt(value, 10);
                args.localServiceHost = '127.0.0.1';
            }
        }
    }

    if (!args.serverUrl) {
        console.error('[ERROR] Missing required argument: --server <ws[s]://host:port?forwardPort=xxxx>');
        process.exit(1);
    }
    if (!args.localServicePort || isNaN(args.localServicePort)) {
        console.error('[ERROR] Missing or invalid required argument: --local-service <host:port> or --target <host:port>');
        process.exit(1);
    }

    // Extract forwardPort from serverUrl for convenience
    try {
        const parsedUrl = new url.URL(args.serverUrl);
        args.forwardPort = parsedUrl.searchParams.get('forwardPort');
        if (!args.forwardPort || isNaN(parseInt(args.forwardPort, 10))) {
             console.error('[ERROR] Server URL must include a valid ?forwardPort=<number> query parameter.');
             process.exit(1);
        }
        args.forwardPort = parseInt(args.forwardPort, 10);
    } catch (e) {
        console.error(`[ERROR] Invalid server URL format: ${args.serverUrl}. Error: ${e.message}`);
        process.exit(1);
    }


    return args;
}

config = parseArgs();

console.log(`Starting utunnel-client:`);
console.log(`  Connecting to Server: ${config.serverUrl}`);
console.log(`  Forwarding server's public port ${config.forwardPort} to Local Service: ${config.localServiceHost}:${config.localServicePort}`);


function connectToServer() {
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[INFO] WebSocket already open or connecting.');
        return;
    }

    console.log(`[INFO] Attempting to connect to server: ${config.serverUrl}`);
    ws = new WebSocket(config.serverUrl, { rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' });

    ws.on('open', () => {
        console.log(`[INFO] Connected to server. Tunnel active for public port ${config.forwardPort} -> local ${config.localServiceHost}:${config.localServicePort}`);
        reconnectionAttempts = 0; // Reset on successful connection
        if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    });

    ws.on('message', (data) => {
        let messageString = Buffer.isBuffer(data) ? data.toString() : data;
        try {
            const parsedMessage = JSON.parse(messageString);
            if (parsedMessage.type === 'control') {
                handleControlMessage(parsedMessage);
                return;
            }
            if (parsedMessage.type === 'info' || parsedMessage.type === 'error') { // Server info/error messages
                console.log(`[SERVER ${parsedMessage.type.toUpperCase()}] ${parsedMessage.message}`);
                if (parsedMessage.type === 'error' && parsedMessage.message && parsedMessage.message.includes("Port already in use by another application")) {
                    // Specific error from server indicating forwardPort is taken by non-utunnel app
                    console.error(`[FATAL] Server cannot listen on forwardPort ${config.forwardPort}. It might be in use by another process on the server. Stopping client.`);
                    ws.close(1000, "Cannot secure forwardPort"); // Close WS
                    process.exit(1); // Stop client
                }
                return;
            }
            // If not control, info, or error, it's data to be piped or an unknown JSON
        } catch (e) {
            // Not JSON, assume it's binary data for the tunnel
        }

        // If it's data for the tunnel
        if (!localTcpSocket || localTcpSocket.destroyed) {
            // If we are already trying to connect localTcpSocket, buffer the data
            if (global.isConnectingLocalService) {
                if (!global.preConnectDataBuffer) global.preConnectDataBuffer = [];
                global.preConnectDataBuffer.push(data);
                return;
            }

            console.log(`[INFO] Data received from server. Initiating connection to local service ${config.localServiceHost}:${config.localServicePort}`);
            global.isConnectingLocalService = true;
            global.preConnectDataBuffer = [data]; // Initialize buffer with current data

            localTcpSocket = new net.Socket();

            localTcpSocket.on('connect', () => {
                console.log(`[INFO] Connected to local service: ${config.localServiceHost}:${config.localServicePort}. Forwarding data.`);
                global.isConnectingLocalService = false;
                while (global.preConnectDataBuffer && global.preConnectDataBuffer.length > 0) {
                    localTcpSocket.write(global.preConnectDataBuffer.shift());
                }
                global.preConnectDataBuffer = null; // Clear buffer

                // Setup bidirectional pipe now that local is connected
                localTcpSocket.on('data', (localData) => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(localData);
                    }
                });
                // The ws.on('message') handler will now directly write to this connected localTcpSocket
            });

            localTcpSocket.on('close', () => {
                console.log('[INFO] Local service connection closed.');
                global.isConnectingLocalService = false; // Reset flag
                if (localTcpSocket && !localTcpSocket.destroyed) localTcpSocket.destroy(); // ensure full cleanup
                localTcpSocket = null;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'control', action: 'clientCloseTunnel' }));
                }
            });

            localTcpSocket.on('error', (err) => {
                console.error(`[ERROR] Local service connection error: ${err.message}`);
                global.isConnectingLocalService = false; // Reset flag
                global.preConnectDataBuffer = null; // Clear buffer on error too
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'control', action: 'clientErrorTunnel', message: err.message }));
                }
                if (localTcpSocket && !localTcpSocket.destroyed) localTcpSocket.destroy();
                localTcpSocket = null;
            });

            localTcpSocket.connect(config.localServicePort, config.localServiceHost);

        } else { // localTcpSocket exists and is connected
             if (global.isConnectingLocalService) { // Should not happen if logic is correct, but as safeguard
                if (!global.preConnectDataBuffer) global.preConnectDataBuffer = [];
                global.preConnectDataBuffer.push(data);
             } else {
                localTcpSocket.write(data);
             }
        }
    });

    ws.on('close', (code, reason) => {
        const reasonMsg = reason ? reason.toString() : 'No reason given';
        console.log(`[INFO] Disconnected from server. Code: ${code}, Reason: ${reasonMsg}.`);
        if (localTcpSocket && !localTcpSocket.destroyed) {
            console.log('[INFO] Closing local service connection due to server disconnection.');
            localTcpSocket.destroy();
            localTcpSocket = null;
        }
        if (code === 1011 && reasonMsg.includes("TCP Server error on forwardPort")) { // Specific internal server error
             console.error(`[FATAL] Server error related to forwardPort ${config.forwardPort}. Stopping client.`);
             process.exit(1);
        }
        if (code === 1000 && reasonMsg === "Cannot secure forwardPort") { // Already handled, but good to be explicit
            return; // Don't retry if server explicitly said port is bad
        }
        if (code !== 1000) { // Don't retry on normal closure by client or server shutdown.
            scheduleReconnection();
        }
    });

    ws.on('error', (err) => {
        console.error(`[ERROR] WebSocket connection error: ${err.message}`);
        // 'close' event will usually follow, triggering reconnection logic there.
        // However, if 'close' doesn't fire (e.g. some DNS resolution errors), schedule here too.
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
             if (localTcpSocket && !localTcpSocket.destroyed) {
                localTcpSocket.destroy();
                localTcpSocket = null;
            }
            scheduleReconnection();
        }
    });
}

function handleControlMessage(message) {
    console.log(`[CONTROL] Received from server: ${JSON.stringify(message)}`);
    switch (message.action) {
        case 'newConnection':
            // This message from server confirms it's ready for a new tunnel.
            // The client will create localTcpSocket upon receiving the *first data packet*.
            // Or, we can pre-emptively create it here if desired.
            // For now, let the first data packet trigger it.
            console.log('[INFO] Server signaled it is ready for a new tunneled connection.');
            break;
        case 'remoteClose':
            console.log('[INFO] Server indicated remote end of tunnel closed.');
            if (localTcpSocket && !localTcpSocket.destroyed) {
                localTcpSocket.end(); // Graceful close if possible
            }
            break;
        case 'remoteError':
            console.error(`[INFO] Server indicated remote end of tunnel error: ${message.message}`);
            if (localTcpSocket && !localTcpSocket.destroyed) {
                localTcpSocket.destroy(); // Force close
            }
            break;
        default:
            console.log(`[WARN] Unknown control message action: ${message.action}`);
    }
}

function scheduleReconnection() {
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout); // Clear any existing scheduled reconnection

    reconnectionAttempts++;
    let delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectionAttempts -1), MAX_RECONNECT_DELAY);
    // Add some jitter to prevent thundering herd
    delay = delay * (0.8 + Math.random() * 0.4);
    delay = Math.floor(delay);


    console.log(`[INFO] Will attempt to reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectionAttempts}).`);
    reconnectionTimeout = setTimeout(() => {
        if (localTcpSocket && !localTcpSocket.destroyed) { // Ensure local socket is down before retrying WS
            localTcpSocket.destroy();
            localTcpSocket = null;
        }
        connectToServer();
    }, delay);
}

// Initial connection attempt
connectToServer();

process.on('SIGINT', () => {
    console.log("\n[INFO] SIGINT received, shutting down client.");
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    if (ws) {
        ws.removeAllListeners('close'); // Prevent reconnection logic during shutdown
        ws.close(1000, "Client shutting down");
    }
    if (localTcpSocket && !localTcpSocket.destroyed) {
        localTcpSocket.destroy();
    }
    process.exit(0);
});
