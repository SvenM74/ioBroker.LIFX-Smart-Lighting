# ioBroker LIFX Smart Lighting

Version 0.1.0

An ioBroker adapter for discovering and controlling LIFX lamps on the local network.

## Features

- Discovers LIFX lamps automatically
- Reports lamp status, color, brightness, and temperature
- Controls power, color, brightness, and transition duration
- Reports last-seen time, Wi-Fi signal and packet counters, and firmware version
- Tracks device timeouts, marks unreachable lights offline, and refreshes their state after reconnection
- Optionally synchronizes LIFX groups, locations, and scenes through the LIFX Cloud API
- Provides writable group/location power, brightness, color and temperature controls
- Synchronizes and activates LIFX Cloud scenes; also supports adapter-owned local scenes that can be saved, recaptured, activated and deleted
- Runs configurable weekday/time schedules against LIFX Cloud selectors
- Provides per-light `effect` controls for Breathe, Pulse, Color Loop, and Off
- Provides configurable mood palettes for individual lights, groups and locations
- Provides a separate `zoneEffect` control for the device-side Move effect on multizone lights
- Provides a per-zone on/off control that restores the zone's previous brightness
- Provides Cloud effects (Clouds, Sunrise, Sunset, Morph, Flame, Move and Clean) for compatible devices
- Provides device-side Morph, Flame and Sky effects on compatible matrix lamps
- Provides writable infrared brightness controls on devices with infrared capability
- Provides a `rename` command to change a lamp's label on the device
- Integrates discovered lamps into the ioBroker Device Manager with power, brightness, temperature and supported color controls
- Runs unit tests and package-content checks in GitHub Actions
- Creates objects before writing state values
- Uses its own adapter ID and state namespace: lifx-smart-lighting.0

## Installation

Install from this repository in ioBroker. The adapter requires Node.js 22 or newer and a compatible ioBroker controller.

## Configuration

The adapter configuration is available in the ioBroker Admin UI.

The **Device Manager** tab lists discovered lamps as cards. From a card, you can switch a lamp, adjust brightness and color temperature, and rename it. Hue and saturation controls appear for color-capable lamps. Expand a card to view the product, hardware and firmware versions, Wi-Fi signal value, and last-seen time. Device Manager requires Admin 7.8.20 or newer.

- Local device polling defaults to 30 seconds.
- Wi-Fi and firmware diagnostics are enabled by default and run every five minutes.
- LIFX Cloud support is optional and disabled by default. Enable it and enter a LIFX Cloud API token to synchronize groups, locations, and scenes. Cloud data is synchronized every five minutes by default.
- Group and location power states control all matching lights through the LIFX Cloud API. Scene states expose an activation button.
- Group/location channels also expose writable `brightness` (0–100), `color` (`#RRGGBB`) and `kelvin` states. Their controls use stable Cloud group/location IDs.
- Cloud scenes are read-only except for activation because the public LIFX API only documents listing and activating scenes. Adapter-owned scenes under `Scenes.Local` can be created by writing a name to `newName`, updated with `capture`, activated, and deleted. Local scene snapshots include discovered lamps' power and color state.
- Schedules are configured in the Admin “Schedules and routines” tab. They execute in the selected IANA timezone while the adapter is running, once per matching date, and use Cloud selectors (`all`, `id:...`, `group_id:...`, `location_id:...`). A Cloud token is required.
- Each light has a writable `effect` state. Breathe and Pulse run on the light for the configured number of cycles. Color Loop is managed by the adapter and runs until `effect` is set to `off`; stopping an effect restores the color saved when it started.
- Effect color, cycle period/count, pulse duty cycle, and Color Loop speed can be set in the Admin UI. Color Loop is only available for color-capable lights.
- Moods are configured in the Admin UI with named presets and comma-separated `#RRGGBB` colors. A bulb picks a stable palette color; multizone strips blend the palette across their zones. Mood commands on synchronized groups and locations apply to locally discovered member lights.
- Multizone lights get a writable `zoneEffect` state for the firmware Move effect. Its cycle duration and direction are configurable in the Admin UI. The effect is sent to and runs on the light itself.
- Each multizone color zone has a writable `zonePower` state; turning a zone off sets its brightness to zero and turning it back on restores the brightness last observed or stored by this adapter.
- With Cloud enabled, each discovered lamp exposes `cloudEffect` for Clouds, Sunrise, Sunset, Morph, Flame, Move, Clean and Off. LIFX Cloud applies these effects only on compatible devices and firmware.
- Infrared-capable lights get a writable `infraredBrightness` state from 0 to 100 percent. The adapter reads and writes the device's maximum infrared brightness.
- Each light has a writable `rename` command. It writes the new name to the LIFX device and updates the reported `label` state. LIFX labels are limited to 32 UTF-8 bytes.
- Matrix-capable Tile, Candle and Ceiling devices get a writable `tileEffect` state with `off`, `morph`, `flame` and `sky`. Morph uses three configurable hue values. Flame uses the device's firmware palette. Sky is restricted to Ceiling devices running firmware 4.4 or newer. Its cycle speed and Sky variant are configurable in Admin.
- Admin settings are separated into tabs for local devices, Device Manager, Cloud groups/locations/scenes, standard light effects, lightstrips and matrix effects. Every configuration tab includes a short explanation of its controls and related states.

The Cloud API token is stored as a protected, encrypted native configuration value. Local discovery and control continue to work when Cloud integration is disabled. Cloud synchronization requires internet access and a valid token.

Diagnostics are collected from devices on the local network. `wifiSignal` stores the raw value reported by each LIFX device; interpretation can vary by device and firmware. `wifiTx` and `wifiRx` are the device-reported packet counters.

## Hardware validation

The automated tests verify the LIFX Tile SetTileEffect packet layout and exercise the adapter commands with mocked devices. GitHub Actions also runs package-content checks. Before relying on matrix effects in a live installation, test `morph`, `flame` and `off` on a Tile/Candle device; test `sky` only on Ceiling firmware 4.4 or newer. Confirm local UDP traffic to the lamp's LIFX port (normally 56700) is permitted by the network.

The `tileEffect` state records the last command sent. SetTileEffect is sent without requesting a device acknowledgement, so this state is not confirmation that the effect has started on the lamp.

## License

MIT.
