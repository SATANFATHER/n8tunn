#!/usr/bin/env node

const http = require('http');
const https = require('https'); // Keep for potential future TLS, though not used with current prompt
const fs = require('fs');    // Keep for potential future TLS
const net = require('net');
const WebSocket = require('ws');
const readline = require('readline');
const { constants } = require('crypto'); // Keep for potential future TLS

const SERVER_WS_PORT = 58985;
const TUNNEL_PORTS = {
    T1: 29865, // Tunnel 1 public port
    T2: 29856, // Tunnel 2 public port
};
const TUNNEL_PREFIX = {
    T1: "1:",
    T2: "2:",
};

// Stores the single active client WebSocket and its associated tunnel sockets
let activeClient = {
    ws: null,
    externalSocketT1: null,
    externalSocketT2: null,
    tcpServerT1: null,
    tcpServerT2: null,
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function promptForIP(callback) {
    rl.question('Enter the External (Public) Server IP Address to listen on: ', (ipAddress) => {
        if (!ipAddress || ipAddress.trim() === '') {
            console.error('[ERROR] IP Address cannot be empty. Please provide a valid IP.');
            promptForIP(callback); // Re-prompt
        } else {
            // Basic IP validation (not exhaustive)
            if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ipAddress) && ipAddress !== '0.0.0.0' && ipAddress.toLowerCase() !== 'localhost') {
                 // Allow '0.0.0.0' and 'localhost' for flexibility
                // A more robust validation might be needed for production if specific formats are required
                console.warn(`[WARN] The entered IP "${ipAddress}" might not be a standard IPv4 address. Proceeding, but ensure it's correct.`);
            }
            callback(ipAddress.trim());
        }
    });
}

function startServer(listenIp) {
    // For now, only HTTP server for WebSocket. TLS could be added back if needed.
    const server = http.createServer((req, res) => {
        // Basic response for HTTP requests to the WebSocket port
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('utunnel-server WebSocket endpoint. Please connect via WebSocket client.\n');
    });
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (wsClient, req) => {
        if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
            console.log('[WARN] Another client tried to connect while one is already active. Rejecting new client.');
            wsClient.send(JSON.stringify({ type: 'error', message: 'Server busy with another client.' }));
            wsClient.terminate();
            return;
        }

        console.log('[INFO] Client connected via WebSocket.');
        activeClient.ws = wsClient;

        wsClient.on('message', (message) => {
            const messageString = message.toString();
            if (messageString.startsWith(TUNNEL_PREFIX.T1)) {
                if (activeClient.externalSocketT1 && activeClient.externalSocketT1.writable) {
                    activeClient.externalSocketT1.write(messageString.substring(TUNNEL_PREFIX.T1.length));
                }
            } else if (messageString.startsWith(TUNNEL_PREFIX.T2)) {
                if (activeClient.externalSocketT2 && activeClient.externalSocketT2.writable) {
                    activeClient.externalSocketT2.write(messageString.substring(TUNNEL_PREFIX.T2.length));
                }
            } else {
                console.log(`[WARN] Received unhandled message from client: ${messageString.substring(0,100)}...`);
            }
        });

        wsClient.on('close', () => {
            console.log('[INFO] Client WebSocket disconnected.');
            if (activeClient.externalSocketT1) activeClient.externalSocketT1.destroy();
            if (activeClient.externalSocketT2) activeClient.externalSocketT2.destroy();
            activeClient.ws = null;
            activeClient.externalSocketT1 = null;
            activeClient.externalSocketT2 = null;
        });

        wsClient.on('error', (err) => {
            console.error(`[ERROR] Client WebSocket error: ${err.message}`);
            // 'close' event will usually follow
        });
    });

    server.listen(SERVER_WS_PORT, listenIp, () => {
        console.log(`[INFO] WebSocket server listening on ${listenIp}:${SERVER_WS_PORT}`);
        setupTunnelListeners(); // Setup TCP listeners after WS server is up
    });

    server.on('error', (err) => {
        console.error(`[FATAL] Failed to start WebSocket server on ${listenIp}:${SERVER_WS_PORT}: ${err.message}`);
        process.exit(1);
    });
}

function setupTunnelListeners() {
    // Tunnel 1 (Port 29865)
    activeClient.tcpServerT1 = net.createServer((socket) => {
        if (!activeClient.ws || activeClient.ws.readyState !== WebSocket.OPEN) {
            console.log(`[WARN][T1:${TUNNEL_PORTS.T1}] External connection received, but no active client WS. Rejecting.`);
            socket.end('No active tunnel client connected to the server.\n');
            return;
        }
        if (activeClient.externalSocketT1 && activeClient.externalSocketT1.readyState !== 'closed') {
            console.log(`[WARN][T1:${TUNNEL_PORTS.T1}] Tunnel 1 busy. Rejecting new external connection.`);
            socket.end('Tunnel 1 is busy. Please try again later.\n');
            return;
        }
        console.log(`[INFO][T1:${TUNNEL_PORTS.T1}] External connection received for Tunnel 1.`);
        activeClient.externalSocketT1 = socket;
        activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T1', action: 'newConnection' }));


        socket.on('data', (data) => {
            if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                // Send raw buffer prefixed by tunnel ID buffer
                activeClient.ws.send(Buffer.concat([Buffer.from(TUNNEL_PREFIX.T1), data]), { binary: true });
            }
        });
        socket.on('close', () => {
            console.log(`[INFO][T1:${TUNNEL_PORTS.T1}] External connection for Tunnel 1 closed.`);
            if (activeClient.externalSocketT1 === socket) activeClient.externalSocketT1 = null;
            if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T1', action: 'remoteClose' }));
            }
        });
        socket.on('error', (err) => {
            console.error(`[ERROR][T1:${TUNNEL_PORTS.T1}] External socket error for Tunnel 1: ${err.message}`);
            if (activeClient.externalSocketT1 === socket) activeClient.externalSocketT1 = null;
             if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T1', action: 'remoteError', message: err.message }));
            }
        });
    });

    activeClient.tcpServerT1.listen(TUNNEL_PORTS.T1, '0.0.0.0', () => {
        // Log combined message later
    });
    activeClient.tcpServerT1.on('error', (err) => {
        console.error(`[FATAL][T1:${TUNNEL_PORTS.T1}] Failed to listen on 0.0.0.0:${TUNNEL_PORTS.T1}: ${err.message}`);
        process.exit(1);
    });

    // Tunnel 2 (Port 29856)
    activeClient.tcpServerT2 = net.createServer((socket) => {
         if (!activeClient.ws || activeClient.ws.readyState !== WebSocket.OPEN) {
            console.log(`[WARN][T2:${TUNNEL_PORTS.T2}] External connection received, but no active client WS. Rejecting.`);
            socket.end('No active tunnel client connected to the server.\n');
            return;
        }
        if (activeClient.externalSocketT2 && activeClient.externalSocketT2.readyState !== 'closed') {
            console.log(`[WARN][T2:${TUNNEL_PORTS.T2}] Tunnel 2 busy. Rejecting new external connection.`);
            socket.end('Tunnel 2 is busy. Please try again later.\n');
            return;
        }
        console.log(`[INFO][T2:${TUNNEL_PORTS.T2}] External connection received for Tunnel 2.`);
        activeClient.externalSocketT2 = socket;
        activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T2', action: 'newConnection' }));


        socket.on('data', (data) => {
            if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                activeClient.ws.send(Buffer.concat([Buffer.from(TUNNEL_PREFIX.T2), data]), { binary: true });
            }
        });
        socket.on('close', () => {
            console.log(`[INFO][T2:${TUNNEL_PORTS.T2}] External connection for Tunnel 2 closed.`);
            if (activeClient.externalSocketT2 === socket) activeClient.externalSocketT2 = null;
            if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T2', action: 'remoteClose' }));
            }
        });
        socket.on('error', (err) => {
            console.error(`[ERROR][T2:${TUNNEL_PORTS.T2}] External socket error for Tunnel 2: ${err.message}`);
            if (activeClient.externalSocketT2 === socket) activeClient.externalSocketT2 = null;
            if (activeClient.ws && activeClient.ws.readyState === WebSocket.OPEN) {
                activeClient.ws.send(JSON.stringify({ type: 'control', tunnelId: 'T2', action: 'remoteError', message: err.message }));
            }
        });
    });

    activeClient.tcpServerT2.listen(TUNNEL_PORTS.T2, '0.0.0.0', () => {
        // Log combined message after both are confirmed listening
        if (activeClient.tcpServerT1 && activeClient.tcpServerT1.listening && activeClient.tcpServerT2 && activeClient.tcpServerT2.listening) {
             console.log(`Server started successfully. Tunnels established on ports ${TUNNEL_PORTS.T1} and ${TUNNEL_PORTS.T2}`);
        }
    });
    activeClient.tcpServerT2.on('error', (err) => {
        console.error(`[FATAL][T2:${TUNNEL_PORTS.T2}] Failed to listen on 0.0.0.0:${TUNNEL_PORTS.T2}: ${err.message}`);
        process.exit(1);
    });
}


// --- Main ---
promptForIP((listenIp) => {
    rl.close(); // Close readline interface after getting input
    startServer(listenIp);
});

process.on('SIGINT', () => {
    console.log("\n[INFO] SIGINT received, shutting down server.");
    if (activeClient.ws) {
        activeClient.ws.close(1000, "Server shutting down");
    }
    if (activeClient.tcpServerT1) activeClient.tcpServerT1.close();
    if (activeClient.tcpServerT2) activeClient.tcpServerT2.close();
    // Give a moment for graceful shutdown
    setTimeout(() => {
        process.exit(0);
    }, 500);
});
