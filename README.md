# ioBroker LIFX Smart Lighting

Version 0.1.0

An ioBroker adapter for discovering and controlling LIFX lamps on the local network.

## Features

- Discovers LIFX lamps automatically
- Reports lamp status, color, brightness, and temperature
- Controls power, color, brightness, and transition duration
- Creates objects before writing state values
- Uses its own adapter ID and state namespace: lifx-smart-lighting.0

## Installation

Install from this repository in ioBroker. The adapter requires Node.js 22 or newer and a compatible ioBroker controller.

## Configuration

Set the polling interval in seconds with native.lifx_interval; the default is 30 seconds.

## License

MIT.
