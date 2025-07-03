# utunnel - Secure Reverse TCP Tunnel over WebSocket (Binary Version)

`utunnel` is a command-line tool that implements a reverse TCP tunnel over WebSocket. This version is designed to be packaged into standalone binaries (`./server` and `./client`) for easy use, with hardcoded ports and interactive prompts for IP addresses.

It allows you to expose local TCP services running on a machine behind a NAT or firewall to users who can connect to specific ports on your public server.

The system consists of two components:
1.  `./server`: Runs on a publicly accessible server. It prompts for the public IP it should use, listens for WebSocket connections from a single `./client`, and forwards traffic from two predefined public ports (`29865`, `29856`) to the client over the WebSocket.
2.  `./client`: Runs on the machine with the local TCP services. It prompts for the server's IP address, connects to the `./server`, and tunnels data between the server and two predefined local services (`127.0.0.1:29865`, `127.0.0.1:29856`).

## Features

*   **Simplified Operation**: Prompts for IP addresses, uses hardcoded ports for tunnels.
*   **Dual Tunnel Multiplexing**: Supports two distinct TCP tunnels over a single WebSocket connection.
*   **Secure Communication**: Uses WebSockets (`ws://`). TLS (`wss://`) setup is not part of the interactive prompt in this version but the underlying code structure could be adapted.
*   **Automatic Reconnection**: Client attempts to reconnect to the server with exponential backoff if the connection is lost.
*   **Standalone Binaries**: Designed to be packaged with tools like `pkg` for Linux.

## Prerequisites for Running Source / Building Binaries

*   Node.js (version 18.x or newer recommended for `pkg` target `node18`)
*   npm (usually comes with Node.js)

## Installation (from Source)

1.  **Clone the repository (or download the files):**
    ```bash
    # If you have git
    # git clone <repository_url>
    # cd utunnel
    # Or, ensure you have utunnel-server.js, utunnel-client.js, and package.json in a directory.
    ```

2.  **Install dependencies:**
    Navigate to the `utunnel` directory in your terminal and run:
    ```bash
    npm install
    ```

## Building the Binaries (`./server`, `./client`)

This project is configured to use `pkg` to create standalone Linux executables.

1.  **Install `pkg` globally (if you haven't already):**
    ```bash
    npm install -g pkg
    ```

2.  **Navigate to the `utunnel` project directory.**

3.  **Run the build script:**
    ```bash
    npm run build
    ```
    This will execute `pkg` to create two files in the `utunnel` directory:
    *   `server` (for Linux x64)
    *   `client` (for Linux x64)

    *Note: The `pkg` target in `package.json` is `node18-linux-x64`. You can change this in `package.json` if you need to target other Node.js versions or architectures.*

## Usage (Running Binaries)

### `./server` (Server Component)

1.  Place the `server` binary on your publicly accessible Linux server.
2.  Make it executable: `chmod +x server`.
3.  Run it:
    ```bash
    ./server
    ```
4.  It will prompt: `Enter the External (Public) Server IP Address to listen on: `
    *   Enter the public IP address of your server where clients should connect. You can also use `0.0.0.0` to listen on all available network interfaces on the server.
5.  Upon successful startup, it will display:
    `Server started successfully. Tunnels established on ports 29865 and 29856`

**Server Operation:**
*   Listens for WebSocket connections on `<entered_IP>:58985`.
*   Listens for incoming TCP connections on `0.0.0.0:29865` (Tunnel 1) and `0.0.0.0:29856` (Tunnel 2).
*   Supports one active `./client` connection at a time.
*   Traffic from port `29865` is multiplexed to the client with a `"1:"` prefix.
*   Traffic from port `29856` is multiplexed to the client with a `"2:"` prefix.

---

### `./client` (Client Component)

1.  Place the `client` binary on the Linux machine that has the local services you want to expose (e.g., your machine in Iran).
2.  Make it executable: `chmod +x client`.
3.  Run it:
    ```bash
    ./client
    ```
4.  It will prompt: `Enter the Server IP Address to connect to: `
    *   Enter the public IP address of your `./server` (the same IP you entered when starting the server).
5.  Upon successful connection to the server, it will display:
    `Connected to server. Tunnels established.`

**Client Operation:**
*   Connects to the server's WebSocket at `<entered_server_IP>:58985`.
*   Handles multiplexed traffic:
    *   Data received from the server prefixed with `"1:"` is forwarded to the local TCP service at `127.0.0.1:29865`.
    *   Data received from the server prefixed with `"2:"` is forwarded to the local TCP service at `127.0.0.1:29856`.
*   Data originating from `127.0.0.1:29865` is prefixed with `"1:"` and sent to the server.
*   Data originating from `127.0.0.1:29856` is prefixed with `"2:"` and sent to the server.
*   If the connection to the server drops, it will attempt to reconnect automatically.

**Example Flow:**

1.  **On your server machine (e.g., a VPS):**
    *   Run `./server`.
    *   Enter its public IP (e.g., `YOUR_SERVER_PUBLIC_IP`).
    *   Server confirms it's listening and tunnels are ready.

2.  **On your local machine (e.g., in Iran):**
    *   Ensure you have services running on `127.0.0.1:29865` and `127.0.0.1:29856`. For testing, you can use `netcat`:
        *   Terminal 1: `nc -l -p 29865 -k -e /bin/cat` (simple echo for tunnel 1)
        *   Terminal 2: `nc -l -p 29856 -k -e /bin/cat` (simple echo for tunnel 2)
    *   Run `./client`.
    *   Enter the server's public IP (`YOUR_SERVER_PUBLIC_IP`).
    *   Client confirms connection.

3.  **External Access:**
    *   Users can now connect to `YOUR_SERVER_PUBLIC_IP:29865`. This traffic will be tunnelled to your local machine's `127.0.0.1:29865`.
    *   Users can also connect to `YOUR_SERVER_PUBLIC_IP:29856`. This traffic will be tunnelled to your local machine's `127.0.0.1:29856`.

## Security Considerations

*   **No TLS by Default in Binary Version**: This simplified binary version currently uses `ws://` (unencrypted WebSockets) because prompting for certificate paths would complicate the "minimal user interaction" goal. For secure communication, you would need to:
    *   Modify the server to load certificate files (potentially via fixed paths or further prompts).
    *   Modify the client to use `wss://` and handle certificate validation (e.g. `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed certs during testing, or proper CA validation for production).
*   **Server Exposure**: The IP address you enter for the server makes its WebSocket port (`58985`) and tunnel ports (`29865`, `29856`) listen on that IP. If you use `0.0.0.0` for the server's listening IP, it listens on all interfaces. Ensure your server's firewall is configured appropriately.
*   **Single Client**: The server is designed for a single active client. No specific authentication is implemented beyond this.
*   **Service Security**: The security of the services running on your local `127.0.0.1:29865` and `127.0.0.1:29856` is your responsibility.

## Troubleshooting

*   **"Error: listen EADDRINUSE" on Server**: A port the server is trying to use (`58985`, `29865`, or `29856`) is already in use on the server machine.
*   **Client "Connection Refused" / Reconnection Loop**:
    *   Ensure `./server` is running and you entered the correct public IP for it.
    *   Ensure the server's firewall allows connections to port `58985`.
    *   You entered the correct server IP when starting `./client`.
*   **Data Not Flowing**:
    *   Check logs on both client and server.
    *   Ensure your local services are actually running on `127.0.0.1:29865` and `127.0.0.1:29856` on the client machine.
    *   Check firewalls on both client and server machines.
*   **Binary Execution Issues on Linux**:
    *   Ensure the binary has execute permissions (`chmod +x server`, `chmod +x client`).
    *   If `pkg` was used to build for a different architecture or glibc version than your target Linux, it might not run. Ensure your build target (`-t` option in `pkg`) matches your execution environment.
```
