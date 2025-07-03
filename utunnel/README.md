# utunnel - Secure Reverse TCP Tunnel over WebSocket

`utunnel` is a command-line tool that implements a secure reverse TCP tunnel over WebSocket. It allows you to expose a local TCP service (e.g., SSH, web server) running on a machine behind a NAT or firewall to the internet via a publicly accessible server.

The system consists of two components:
1.  `utunnel-server`: Runs on a publicly accessible server, listens for WebSocket connections from clients, and forwards traffic from public ports to the respective clients.
2.  `utunnel-client`: Runs on the machine with the local TCP service, connects to the `utunnel-server`, and tunnels data between the server and the local service.

## Features

*   **Reverse Tunneling**: Expose local services from private networks.
*   **Secure Communication**: Supports TLS encryption (wss://) for the WebSocket connection.
*   **Configurable Ports**: Both server and client allow configuration of listening and target ports.
*   **Automatic Reconnection**: Client attempts to reconnect to the server with exponential backoff if the connection is lost.
*   **Simple CLI**: Easy-to-use command-line interface for both server and client.
*   **Essential Dependencies**: Uses only `ws` for WebSockets and built-in Node.js modules.

## Prerequisites

*   Node.js (version 12.x or newer recommended)
*   npm (usually comes with Node.js)

## Installation

1.  **Clone the repository (or download the files):**
    ```bash
    # If you have git
    # git clone <repository_url>
    # cd utunnel

    # Or, ensure you have utunnel-server.js and utunnel-client.js in a directory.
    # Make sure package.json is present or run `npm init -y` if setting up manually.
    ```

2.  **Install dependencies:**
    Navigate to the `utunnel` directory in your terminal and run:
    ```bash
    npm install ws
    ```
    (If you already have the `node_modules` directory from previous steps, you might skip this if `ws` is listed in `package.json`'s dependencies and installed).

3.  **Make scripts executable (if not already):**
    ```bash
    chmod +x utunnel-server.js
    chmod +x utunnel-client.js
    ```

## Usage

### `utunnel-server`

The server component listens for WebSocket connections from `utunnel-client` instances.

**Command:**
```bash
./utunnel-server.js [options]
```

**Options:**

*   `--listen <[host:]port>`: Specifies the host and port for the WebSocket server to listen on.
    *   Default: `0.0.0.0:8080`
    *   Examples:
        *   `--listen :9000` (listens on port 9000 on all interfaces)
        *   `--listen 127.0.0.1:8080` (listens on localhost port 8080)
*   `--cert <path_to_cert.pem>`: Path to the SSL certificate file (for TLS/wss).
*   `--key <path_to_key.pem>`: Path to the SSL private key file (for TLS/wss).

**Server Operation:**
The server waits for clients to connect. Each client, upon connection, specifies a `forwardPort` via its WebSocket URL (e.g., `ws://server_ip:8080?forwardPort=2222`). The `utunnel-server` will then start a new TCP listener on `0.0.0.0:<forwardPort>`. Any traffic coming to this `<forwardPort>` on the server will be tunneled to the client that registered it.

**Example (HTTP - No TLS):**
```bash
./utunnel-server.js --listen :8080
```
Server will listen for WebSocket connections on `0.0.0.0:8080`.

**Example (HTTPS - With TLS):**
You'll need an SSL certificate and a private key. For testing, you can generate a self-signed certificate:
```bash
openssl genrsa -out key.pem 2048
openssl req -new -key key.pem -out csr.pem
openssl x509 -req -days 365 -in csr.pem -signkey key.pem -out cert.pem
```
Then run the server:
```bash
./utunnel-server.js --listen :8443 --cert ./cert.pem --key ./key.pem
```
Server will listen for secure WebSocket (wss) connections on `0.0.0.0:8443`.

---

### `utunnel-client`

The client component connects to the `utunnel-server` and makes a local TCP service available through the tunnel.

**Command:**
```bash
./utunnel-client.js --server <server_websocket_url> --local-service <host:port>
```

**Options:**

*   `--server <ws[s]://host:port?forwardPort=publicPort>`: **(Required)** The full WebSocket URL of the `utunnel-server`.
    *   The `?forwardPort=<publicPort>` query parameter is crucial. It tells the server which port it should open to the public internet for this tunnel. This `publicPort` on the server will then forward traffic to your client's `--local-service`.
*   `--local-service <[host:]port>` or `--target <[host:]port>`: **(Required)** The local TCP service that the client should forward tunnelled traffic to.
    *   Default host if only port is specified: `127.0.0.1`
    *   Examples:
        *   `--local-service 127.0.0.1:22` (for an SSH server)
        *   `--local-service :3000` (for a web server on `127.0.0.1:3000`)
        *   `--target 192.168.1.100:80` (to expose a service on another machine on the local network)

**Client Operation:**
The client establishes a WebSocket connection to the server. The `forwardPort` in the server URL tells the server which public port to open. When the server receives a connection on that public port, it signals the client, which then connects to the specified `local-service`. Data is then piped between the server (via WebSocket) and the local service.

**Example (Connecting to an HTTP server):**
Suppose `utunnel-server` is running on `example.com:8080`. You want to expose your local SSH server (running on `127.0.0.1:22`) through the server's public port `2222`.
```bash
./utunnel-client.js --server ws://example.com:8080?forwardPort=2222 --local-service 127.0.0.1:22
```
Now, connecting to `example.com:2222` (e.g., `ssh user@example.com -p 2222`) will be tunneled to your local machine's port 22.

**Example (Connecting to an HTTPS server with self-signed cert):**
If `utunnel-server` is using a self-signed certificate on `example.com:8443`, you might need to tell Node.js to allow it:
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 ./utunnel-client.js --server wss://example.com:8443?forwardPort=2223 --local-service 127.0.0.1:22
```
**Warning:** `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS certificate validation and should only be used for testing with self-signed certificates. For production, use valid certificates.

## Basic Security Considerations

*   **TLS Encryption**: Always use `wss://` (TLS) for the server-client WebSocket connection, especially over untrusted networks. Use valid, trusted certificates in production. The self-signed certificate method is for testing/development only.
*   **Firewall**: On the server, ensure your firewall allows incoming connections on the WebSocket port (e.g., 8080) and any `forwardPort`s you intend to use.
*   **`forwardPort` Exposure**: Be aware that any `forwardPort` opened by the server is potentially accessible from the internet. Only forward services you intend to expose.
*   **Authentication (Not Implemented)**: This version of `utunnel` does not implement any authentication between the client and server beyond the WebSocket connection. Anyone who knows your server's address and a free `forwardPort` could potentially connect a client. For enhanced security, a future version might include API keys or other authentication mechanisms.
*   **Input Validation**: The server validates the `forwardPort` parameter. The client validates its parameters.
*   **Rate Limiting (Basic)**: The server prevents multiple clients from claiming the same `forwardPort` simultaneously. Reconnection attempts by the client use exponential backoff. More sophisticated rate limiting is not implemented.
*   **Service Security**: The security of the service being tunneled (e.g., your local SSH server, web application) is your responsibility. Ensure it is properly configured and secured.

## Troubleshooting

*   **"Error: listen EADDRINUSE" on Server**: This means the port the server is trying to listen on (either the WebSocket port or a `forwardPort`) is already in use by another application on the server machine. Change the port or stop the conflicting application.
*   **Client "Connection Refused"**:
    *   Ensure the `utunnel-server` is running and accessible from the client machine.
    *   Check server firewall rules.
    *   Verify the server URL (hostname/IP and port) in the client command.
*   **Client "Invalid or missing forwardPort parameter"**: The `--server` URL for the client *must* include `?forwardPort=<number>`.
*   **Client "Server URL must include a valid ?forwardPort=<number> query parameter."**: The `forwardPort` was missing or not a number.
*   **TLS/WSS Issues**:
    *   If using `wss://` with self-signed certificates, the client will likely fail with a certificate validation error unless you set `NODE_TLS_REJECT_UNAUTHORIZED=0` as an environment variable for the client process. **This is insecure for production.**
    *   Ensure correct paths to `cert.pem` and `key.pem` for the server.
*   **Tunnel Busy**: The server currently allows only one active tunneled connection per `forwardPort` at a time. If an external user tries to connect while another is active, they will get a "Tunnel busy" message.
*   **Client stuck at "Attempting to reconnect..."**:
    *   Server might be down or unreachable.
    *   Network issues between client and server.
    *   Server might be rejecting client for some reason (check server logs).
*   **Data Not Flowing**:
    *   Check logs on both client and server for errors.
    *   Ensure the local service on the client machine is running and accessible on the specified `localServiceHost:localServicePort`.
    *   Firewall on the client machine might be blocking connections to the local service.

## Future Enhancements (Optional)

*   Client authentication (e.g., API keys).
*   Allowing multiple concurrent tunneled connections for a single client/`forwardPort` (multiplexing).
*   Configuration via files.
*   More detailed statistics (bandwidth, latency).
*   Daemonization for server/client processes.
```
