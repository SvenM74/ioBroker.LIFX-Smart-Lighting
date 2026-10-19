# ioBroker LIFX Smart Lighting

Version 0.1.0

An ioBroker adapter for discovering and controlling LIFX lamps on the local network.

## Features

- Discovers LIFX lamps automatically
- Reports lamp status, color, brightness, and temperature
- Controls power, color, brightness, and transition duration
- Reports last-seen time, Wi-Fi signal and packet counters, and firmware version
- Optionally synchronizes LIFX groups, locations, and scenes through the LIFX Cloud API
- Provides writable group/location power controls and scene activation buttons
- Provides per-light `effect` controls for Breathe, Pulse, Color Loop, and Off
- Creates objects before writing state values
- Uses its own adapter ID and state namespace: lifx-smart-lighting.0

## Installation

Install from this repository in ioBroker. The adapter requires Node.js 22 or newer and a compatible ioBroker controller.

## Configuration

The adapter configuration is available in the ioBroker Admin UI.

- Local device polling defaults to 30 seconds.
- Wi-Fi and firmware diagnostics are enabled by default and run every five minutes.
- LIFX Cloud support is optional and disabled by default. Enable it and enter a LIFX Cloud API token to synchronize groups, locations, and scenes. Cloud data is synchronized every five minutes by default.
- Group and location power states control all matching lights through the LIFX Cloud API. Scene states expose an activation button.
- Each light has a writable `effect` state. Breathe and Pulse run on the light for the configured number of cycles. Color Loop is managed by the adapter and runs until `effect` is set to `off`; stopping an effect restores the color saved when it started.
- Effect color, cycle period/count, pulse duty cycle, and Color Loop speed can be set in the Admin UI. Color Loop is only available for color-capable lights.

The Cloud API token is stored as a protected, encrypted native configuration value. Local discovery and control continue to work when Cloud integration is disabled. Cloud synchronization requires internet access and a valid token.

Diagnostics are collected from devices on the local network. `wifiSignal` stores the raw value reported by each LIFX device; interpretation can vary by device and firmware. `wifiTx` and `wifiRx` are the device-reported packet counters.

## License

MIT.
