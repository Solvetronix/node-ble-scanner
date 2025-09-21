# Node BLE Scanner

A Node.js application for scanning and connecting to Bluetooth Low Energy (BLE) devices with a web-based interface.

## Features

- **Real-time BLE scanning** - Discover nearby BLE devices with live updates
- **Web interface** - Modern React-based UI for device management
- **Device connection** - Connect to BLE devices and explore their services/characteristics
- **WebSocket support** - Real-time communication between server and client
- **RSSI monitoring** - Signal strength visualization with color coding
- **Service discovery** - Automatic discovery of GATT services and characteristics
- **Notification support** - Subscribe to device notifications and indications

## Requirements

- Node.js 14+ 
- Bluetooth adapter with BLE support
- macOS/Linux (Windows support limited)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/node_ble.git
cd node_ble
```

2. Install dependencies:
```bash
npm install
```

3. Start the application:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Usage

1. Open your browser and navigate to `http://localhost:3000`
2. The application will automatically start scanning for BLE devices
3. View discovered devices in the table with RSSI, name, and connection status
4. Click "Connect" to establish a connection with a device
5. Use "Info" button to view detailed device information and services
6. Monitor real-time notifications from connected devices

## API Endpoints

- `GET /devices` - List all discovered devices
- `POST /connect/:id` - Connect to a specific device
- `POST /disconnect/:id` - Disconnect from a device
- `POST /scan/start` - Manually start scanning
- `GET /events` - Server-Sent Events stream for real-time updates
- `WS /ws` - WebSocket connection for bidirectional communication

## Environment Variables

- `PORT` - Server port (default: 3000)
- `ALLOW_DUPLICATES` - Allow duplicate advertisements (default: true)
- `FILTER_MIN_RSSI` - Minimum RSSI threshold (default: -200)
- `SUMMARY_INTERVAL_MS` - Console summary interval (default: 10000)
- `SUMMARY_MAX_ROWS` - Maximum rows in console summary (default: 50)

## Permissions

On macOS, ensure your terminal/application has Bluetooth permissions:
- System Preferences → Security & Privacy → Privacy → Bluetooth
- Add your terminal application to the list

## Troubleshooting

- **No devices found**: Check Bluetooth permissions and ensure Bluetooth is enabled
- **Connection failures**: Some devices may require pairing or have connection limits
- **Scanning stops**: The app automatically pauses scanning during connections

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
