#!/usr/bin/env node

const WebSocket = require('ws');
const net = require('net');
const readline = require('readline');

const SERVER_WS_PORT = 58985; // Should match server
const TUNNEL_PREFIX = {
    T1: "1:",
    T2: "2:",
};
const LOCAL_TARGETS = {
    T1: { host: '127.0.0.1', port: 29865 },
    T2: { host: '127.0.0.1', port: 29856 },
};

let ws = null;
let localSockets = { // To store local TCP sockets for T1 and T2
    T1: null,
    T2: null,
};
let connectionStates = { // To manage connection state for local sockets
    T1: { isConnecting: false, buffer: [] },
    T2: { isConnecting: false, buffer: [] },
};

let reconnectionTimeout = null;
let reconnectionAttempts = 0;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;
let serverIpAddress = null; // To store user-provided IP

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function promptForIP(callback) {
    rl.question('Enter the Server IP Address to connect to: ', (ipAddress) => {
         if (!ipAddress || ipAddress.trim() === '') {
            console.error('[ERROR] Server IP Address cannot be empty.');
            promptForIP(callback);
        } else {
            // Basic IP validation (not exhaustive)
             if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ipAddress) && ipAddress.toLowerCase() !== 'localhost') {
                console.warn(`[WARN] The entered IP "${ipAddress}" might not be a standard IPv4 address. Proceeding, but ensure it's correct.`);
            }
            callback(ipAddress.trim());
        }
    });
}


function connectToServer() {
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[INFO] WebSocket already open or connecting.');
        return;
    }

    const serverUrl = `ws://${serverIpAddress}:${SERVER_WS_PORT}`;
    console.log(`[INFO] Attempting to connect to server: ${serverUrl}`);
    // Allow self-signed certs if NODE_TLS_REJECT_UNAUTHORIZED=0 is set (for future wss://)
    ws = new WebSocket(serverUrl, { rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' });

    ws.on('open', () => {
        console.log("Connected to server. Tunnels established.");
        reconnectionAttempts = 0;
        if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    });

    ws.on('message', (data) => {
        // Data is expected to be a Buffer: Buffer.from(TUNNEL_PREFIX) + actual_data_Buffer
        if (!(data instanceof Buffer)) {
            // Handle non-buffer data, likely JSON control messages if server sends them as strings
            try {
                const messageString = data.toString();
                const parsed = JSON.parse(messageString);
                if (parsed.type === 'control' && parsed.tunnelId) {
                    handleControlMessage(parsed.tunnelId, parsed);
                } else if (parsed.type === 'error' && parsed.message) {
                    console.error(`[SERVER ERROR] ${parsed.message}`);
                } else {
                    console.log(`[WARN] Received unhandled JSON message from server: ${messageString.substring(0,100)}`);
                }
            } catch (e) {
                console.log(`[WARN] Received unexpected non-buffer, non-JSON message: ${data.toString().substring(0,100)}...`);
            }
            return;
        }

        let tunnelId = null;
        let actualDataBuffer = null;
        const prefixT1Buffer = Buffer.from(TUNNEL_PREFIX.T1);
        const prefixT2Buffer = Buffer.from(TUNNEL_PREFIX.T2);

        if (data.length >= prefixT1Buffer.length && data.subarray(0, prefixT1Buffer.length).equals(prefixT1Buffer)) {
            tunnelId = 'T1';
            actualDataBuffer = data.subarray(prefixT1Buffer.length);
        } else if (data.length >= prefixT2Buffer.length && data.subarray(0, prefixT2Buffer.length).equals(prefixT2Buffer)) {
            tunnelId = 'T2';
            actualDataBuffer = data.subarray(prefixT2Buffer.length);
        } else {
            console.log(`[WARN] Received message with unknown binary prefix.`);
            return;
        }

        handleTunnelData(tunnelId, actualDataBuffer);
    });

    ws.on('close', (code, reason) => {
        const reasonMsg = reason ? reason.toString() : 'No reason given';
        console.log(`[INFO] Disconnected from server. Code: ${code}, Reason: ${reasonMsg}.`);
        Object.keys(localSockets).forEach(tid => {
            if (localSockets[tid] && !localSockets[tid].destroyed) {
                localSockets[tid].destroy();
            }
            localSockets[tid] = null;
            connectionStates[tid].isConnecting = false;
            connectionStates[tid].buffer = [];
        });
        if (code !== 1000) { // Don't retry on normal closure
            scheduleReconnection();
        }
    });

    ws.on('error', (err) => {
        console.error(`[ERROR] WebSocket connection error: ${err.message}`);
        // 'close' event will usually follow.
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
             Object.keys(localSockets).forEach(tid => {
                if (localSockets[tid] && !localSockets[tid].destroyed) localSockets[tid].destroy();
                localSockets[tid] = null;
                connectionStates[tid].isConnecting = false;
                connectionStates[tid].buffer = [];
            });
            scheduleReconnection(); // Ensure reconnection is scheduled if close doesn't fire
        }
    });
}

function handleControlMessage(tunnelId, message) {
    console.log(`[CONTROL][${tunnelId}] Received from server: ${JSON.stringify(message)}`);
    switch (message.action) {
        case 'newConnection':
            // Server is ready for data on this tunnel. Client connects local socket on first data packet.
            console.log(`[INFO][${tunnelId}] Server signaled new external connection for tunnel ${tunnelId}.`);
            break;
        case 'remoteClose':
            console.log(`[INFO][${tunnelId}] Server indicated remote end of tunnel ${tunnelId} closed.`);
            if (localSockets[tunnelId] && !localSockets[tunnelId].destroyed) {
                localSockets[tunnelId].end(); // Graceful close
            }
            break;
        case 'remoteError':
            console.error(`[INFO][${tunnelId}] Server indicated remote end of tunnel ${tunnelId} error: ${message.message}`);
            if (localSockets[tunnelId] && !localSockets[tunnelId].destroyed) {
                localSockets[tunnelId].destroy(); // Force close
            }
            break;
        default:
            console.log(`[WARN][${tunnelId}] Unknown control message action: ${message.action}`);
    }
}

function handleTunnelData(tunnelId, dataBuffer) {
    const target = LOCAL_TARGETS[tunnelId];
    const state = connectionStates[tunnelId];

    if (!localSockets[tunnelId] || localSockets[tunnelId].destroyed) {
        if (state.isConnecting) {
            state.buffer.push(dataBuffer);
            return;
        }
        console.log(`[INFO][${tunnelId}] Data for ${tunnelId}. Initiating connection to local ${target.host}:${target.port}`);
        state.isConnecting = true;
        state.buffer.push(dataBuffer);

        localSockets[tunnelId] = new net.Socket();
        const currentLocalSocket = localSockets[tunnelId]; // Capture current socket for closure

        currentLocalSocket.on('connect', () => {
            console.log(`[INFO][${tunnelId}] Connected to local ${target.host}:${target.port}. Forwarding data.`);
            state.isConnecting = false;
            while (state.buffer.length > 0) {
                currentLocalSocket.write(state.buffer.shift());
            }
            // Set up data handler from local to server only after connection
            currentLocalSocket.on('data', (localData) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(Buffer.concat([Buffer.from(TUNNEL_PREFIX[tunnelId]), localData]), { binary: true });
                }
            });
        });

        currentLocalSocket.on('close', () => {
            console.log(`[INFO][${tunnelId}] Local service connection for ${tunnelId} closed.`);
            state.isConnecting = false;
            state.buffer = []; // Clear buffer
            if (localSockets[tunnelId] === currentLocalSocket) { // Check if it's still the same socket
                 localSockets[tunnelId] = null;
            }
            // No need to send clientCloseTunnel here, server has its own external socket lifecycle
        });

        currentLocalSocket.on('error', (err) => {
            console.error(`[ERROR][${tunnelId}] Local service for ${tunnelId} error: ${err.message}`);
            state.isConnecting = false;
            state.buffer = []; // Clear buffer
            if (localSockets[tunnelId] === currentLocalSocket) {
                if (!currentLocalSocket.destroyed) currentLocalSocket.destroy();
                localSockets[tunnelId] = null;
            }
            // No need to send clientErrorTunnel here
        });
        currentLocalSocket.connect(target.port, target.host);

    } else { // localSocket exists and is presumed connected
        if (state.isConnecting) { // Should not happen if logic is correct
            state.buffer.push(dataBuffer);
        } else {
            localSockets[tunnelId].write(dataBuffer);
        }
    }
}


function scheduleReconnection() {
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);

    reconnectionAttempts++;
    let delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectionAttempts - 1), MAX_RECONNECT_DELAY);
    delay = Math.floor(delay * (0.8 + Math.random() * 0.4)); // Jitter

    console.log(`[INFO] Will attempt to reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectionAttempts}).`);
    reconnectionTimeout = setTimeout(() => {
        Object.keys(localSockets).forEach(tid => {
            if (localSockets[tid] && !localSockets[tid].destroyed) localSockets[tid].destroy();
            localSockets[tid] = null;
            connectionStates[tid].isConnecting = false;
            connectionStates[tid].buffer = [];
        });
        connectToServer();
    }, delay);
}

// --- Main ---
promptForIP((ip) => {
    serverIpAddress = ip;
    rl.close();
    connectToServer();
});

process.on('SIGINT', () => {
    console.log("\n[INFO] SIGINT received, shutting down client.");
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    if (ws) {
        ws.removeAllListeners('close'); // Prevent reconnection logic
        ws.close(1000, "Client shutting down");
    }
    Object.keys(localSockets).forEach(tid => {
        if (localSockets[tid] && !localSockets[tid].destroyed) localSockets[tid].destroy();
    });
    process.exit(0);
});
