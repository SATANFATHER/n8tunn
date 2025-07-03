#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const WebSocket = require('ws');
const url = require('url');
const { constants } = require('crypto'); // For TLS options

const argv = require('process').argv.slice(2);

const defaultConfig = {
    listenHost: '0.0.0.0',
    listenPort: 8080,
    cert: null,
    key: null,
};

let config = { ...defaultConfig };
const clientConnections = new Map(); // Stores { forwardPort: { ws: WebSocket, tcpServer: net.Server, externalSocket: net.Socket | null } }

function parseArgs() {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--listen')) {
            const value = arg.includes('=') ? arg.split('=')[1] : argv[++i];
            if (value.includes(':')) {
                const [host, port] = value.split(':');
                args.listenHost = host === '' ? defaultConfig.listenHost : host;
                args.listenPort = parseInt(port, 10);
            } else {
                args.listenPort = parseInt(value, 10);
            }
        } else if (arg.startsWith('--cert')) {
            args.cert = arg.includes('=') ? arg.split('=')[1] : argv[++i];
        } else if (arg.startsWith('--key')) {
            args.key = arg.includes('=') ? arg.split('=')[1] : argv[++i];
        }
    }
    if (isNaN(args.listenPort) && args.listenHost === undefined) { // if only host is provided e.g. --listen localhost
        args.listenPort = defaultConfig.listenPort;
    } else if (isNaN(args.listenPort)) {
         args.listenPort = defaultConfig.listenPort;
    }


    return { ...defaultConfig, ...args };
}

config = parseArgs();

if (config.listenHost === '' || config.listenHost === undefined) { // Handle cases like --listen :80 or --listen 8080
    config.listenHost = defaultConfig.listenHost;
}


console.log(`Starting utunnel-server with configuration:`);
console.log(`  WebSocket Listen: ${config.listenHost}:${config.listenPort}`);
if (config.cert && config.key) {
    console.log(`  TLS Enabled: Yes`);
    console.log(`    Cert: ${config.cert}`);
    console.log(`    Key: ${config.key}`);
} else {
    console.log(`  TLS Enabled: No`);
}

let server;

if (config.cert && config.key) {
    try {
        const options = {
            cert: fs.readFileSync(config.cert),
            key: fs.readFileSync(config.key),
            // Enforce TLS 1.2+
            secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1,
        };
        server = https.createServer(options);
    } catch (err) {
        console.error(`[ERROR] Failed to create HTTPS server: ${err.message}`);
        console.error(`Make sure certificate and key files are valid and paths are correct.`);
        process.exit(1);
    }
} else {
    server = http.createServer();
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const requestUrl = url.parse(req.url, true);
    const forwardPort = parseInt(requestUrl.query.forwardPort, 10);

    if (isNaN(forwardPort) || forwardPort <= 0 || forwardPort > 65535) {
        console.log(`[INFO] Client connection rejected: Invalid or missing forwardPort parameter.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid or missing forwardPort parameter.' }));
        ws.terminate();
        return;
    }

    if (clientConnections.has(forwardPort)) {
        const existingClient = clientConnections.get(forwardPort);
        if (existingClient.ws && existingClient.ws.readyState === WebSocket.OPEN) {
            console.log(`[INFO] Client connection rejected: forwardPort ${forwardPort} is already in use by an active client.`);
            ws.send(JSON.stringify({ type: 'error', message: `Port ${forwardPort} is already in use.` }));
            ws.terminate();
            return;
        } else {
            // Clean up stale entry if WS is not open
            if (existingClient.tcpServer) {
                existingClient.tcpServer.close();
            }
            clientConnections.delete(forwardPort);
            console.log(`[INFO] Cleaned up stale client for forwardPort ${forwardPort}.`);
        }
    }

    console.log(`[INFO] Client connected, requesting forwardPort: ${forwardPort}`);

    const clientEntry = {
        ws: ws,
        tcpServer: null,
        externalSocket: null,
        forwardPort: forwardPort
    };
    clientConnections.set(forwardPort, clientEntry);

    const tcpServer = net.createServer();
    clientEntry.tcpServer = tcpServer;

    tcpServer.on('connection', (externalSocket) => {
        console.log(`[INFO][${forwardPort}] External connection received.`);

        if (clientEntry.externalSocket && clientEntry.externalSocket.readyState !== 'closed') {
            console.log(`[WARN][${forwardPort}] Tunnel is busy. Rejecting new external connection.`);
            externalSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nTunnel busy. Please try again later.\r\n');
            externalSocket.end();
            return;
        }

        clientEntry.externalSocket = externalSocket;
        console.log(`[INFO][${forwardPort}] Tunnel established with external client.`);
        ws.send(JSON.stringify({ type: 'control', action: 'newConnection' }));


        // Pipe data: externalSocket <-> WebSocket
        externalSocket.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        });

        externalSocket.on('close', () => {
            console.log(`[INFO][${forwardPort}] External connection closed.`);
            if (clientEntry.externalSocket === externalSocket) {
                clientEntry.externalSocket = null;
            }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'control', action: 'remoteClose' }));
            }
        });

        externalSocket.on('error', (err) => {
            console.error(`[ERROR][${forwardPort}] External socket error: ${err.message}`);
            if (clientEntry.externalSocket === externalSocket) {
                clientEntry.externalSocket = null;
            }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'control', action: 'remoteError', message: err.message }));
            }
        });

        // Clear externalSocket on ws message error or if ws is not open
        const messageHandler = (message) => {
            // If message is Buffer, it's data. If string, could be control.
            // For now, assume all messages from client are data for externalSocket
            if (externalSocket.writable && !externalSocket.destroyed) {
                 try {
                    if (Buffer.isBuffer(message)) {
                        externalSocket.write(message);
                    } else if (typeof message === 'string') {
                        // Attempt to parse as JSON for control messages from client
                        try {
                            const parsed = JSON.parse(message);
                            if (parsed.type === 'control' && parsed.action === 'clientCloseTunnel') {
                                console.log(`[INFO][${forwardPort}] Client requested tunnel closure.`);
                                if (externalSocket) externalSocket.destroy();
                                clientEntry.externalSocket = null;
                            }
                        } catch (e) {
                            // Not a JSON control message, treat as string data
                            externalSocket.write(message);
                        }
                    }
                } catch (e) {
                    console.error(`[ERROR][${forwardPort}] Error writing to external socket: ${e.message}. Closing external socket.`);
                    if (externalSocket) externalSocket.destroy();
                    clientEntry.externalSocket = null;
                     // Also remove this specific listener to prevent issues if ws stays open for a new external cxn
                    ws.off('message', messageHandler);
                }
            }
        };
        ws.on('message', messageHandler);

        // Ensure this specific message handler is removed when the external socket closes or ws closes for this tunnel
        externalSocket.on('close', () => {
            ws.off('message', messageHandler);
        });
        ws.on('close', () => { // Also remove if ws itself closes
             ws.off('message', messageHandler);
        });


    });

    tcpServer.on('error', (err) => {
        console.error(`[ERROR][${forwardPort}] TCP Server error for port ${forwardPort}: ${err.message}`);
        ws.send(JSON.stringify({ type: 'error', message: `Failed to listen on port ${forwardPort}: ${err.code === 'EADDRINUSE' ? 'Port already in use by another application.' : err.message}` }));
        // No ws.terminate() here, client might want to try different port or server might recover
        // However, we must clean up the clientConnections entry for this port
        if (clientConnections.get(forwardPort) === clientEntry) {
            clientConnections.delete(forwardPort);
        }
        if (clientEntry.ws.readyState === WebSocket.OPEN) {
            clientEntry.ws.close(1011, `TCP Server error on forwardPort ${forwardPort}`);
        }
    });

    tcpServer.listen(forwardPort, config.listenHost, () => { // Listen on configured host or 0.0.0.0
        console.log(`[INFO] TCP server listening on ${config.listenHost}:${forwardPort} for client.`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'info', message: `Server is now listening on public port ${forwardPort}` }));
        }
    });

    ws.on('close', () => {
        console.log(`[INFO][${forwardPort}] Client for forwardPort ${forwardPort} disconnected.`);
        if (clientEntry.tcpServer) {
            clientEntry.tcpServer.close(() => {
                console.log(`[INFO][${forwardPort}] TCP server on port ${forwardPort} shut down.`);
            });
        }
        if (clientEntry.externalSocket) {
            clientEntry.externalSocket.destroy();
            clientEntry.externalSocket = null;
        }
        // Check if this clientEntry is still the one associated with the forwardPort before deleting
        if (clientConnections.get(forwardPort) === clientEntry) {
            clientConnections.delete(forwardPort);
        }
    });

    ws.on('error', (err) => {
        console.error(`[ERROR][${forwardPort}] WebSocket error for client on port ${forwardPort}: ${err.message}`);
        // ws.on('close') will handle cleanup
    });
});

server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[INFO] utunnel-server WebSocket listening on ${config.listenHost}:${config.listenPort}`);
});

process.on('SIGINT', () => {
    console.log("\n[INFO] SIGINT received, shutting down server.");
    wss.clients.forEach(client => {
        client.close(1000, "Server shutting down");
    });
    server.close(() => {
        console.log("[INFO] HTTP/S server closed.");
        process.exit(0);
    });
    // Force exit if server doesn't close gracefully
    setTimeout(() => {
        process.exit(1);
    }, 5000);
});
