# <img src="https://matterbridge.io/assets/matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;Matterbridge Reolink

![Node.js CI](https://github.com/RyanMorash/matterbridge-reolink/actions/workflows/build.yml/badge.svg)
![CodeQL](https://github.com/RyanMorash/matterbridge-reolink/actions/workflows/codeql.yml/badge.svg)
[![codecov](https://codecov.io/gh/RyanMorash/matterbridge-reolink/branch/main/graph/badge.svg)](https://codecov.io/gh/RyanMorash/matterbridge-reolink)
[![tested with Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18.svg?logo=vitest&logoColor=white)](https://vitest.dev)
[![styled with Oxc](https://img.shields.io/badge/styled_with-Oxc-9BE4E0.svg?logo=oxc&logoColor=white)](https://oxc.rs/docs/guide/usage/formatter.html)
[![linted with Oxc](https://img.shields.io/badge/linted_with-Oxc-9BE4E0.svg?logo=oxc&logoColor=white)](https://oxc.rs/docs/guide/usage/linter.html)
[![TypeScript Native](https://img.shields.io/badge/TypeScript_Native-3178C6?logo=typescript&logoColor=white)](https://github.com/microsoft/typescript-go)
[![ESM](https://img.shields.io/badge/ESM-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![ESM](https://img.shields.io/badge/ESM-Bun-000000?logo=bun&logoColor=white)](https://bun.com)
[![matterbridge.io](https://img.shields.io/badge/matterbridge.io-online-brightgreen)](https://matterbridge.io)

[![powered by](https://img.shields.io/badge/powered%20by-matterbridge-blue)](https://www.npmjs.com/package/matterbridge)

This plugin exposes Reolink cameras, doorbells, and NVR or Home Hub channels to Matter through [Matterbridge](https://github.com/Luligu/matterbridge). It talks to each device with [@apocaliss92/nodelink-js](https://github.com/apocaliss92/nodelink-js) on the Baichuan port (9000). Live view and snapshots stay on Matterbridge’s ffmpeg and WebRTC path. The plugin publishes a localhost RTSP proxy for each channel and does not spawn ffmpeg itself.

If you like this project, please consider giving it a star on [GitHub](https://github.com/RyanMorash/matterbridge-reolink).

## Features

- One configured host is one Baichuan session. A standalone camera is channel 0. An NVR or Home Hub becomes one endpoint set per online channel, unless `channels` lists the channels to expose.
- A doorbell is a Matter video doorbell. A press is a single switch event and is not also reported as occupancy.
- A floodlight that is not a doorbell is a floodlight camera. On and off call the white LED. A doorbell that also has a floodlight stays a video doorbell and adds a separate spotlight plug.
- Any other channel is a camera. Pan and tilt are exposed only on that plain camera.
- Motion, person, vehicle, pet, and package detection each become a bridged occupancy sensor when the camera actually reports that capability. Occupancy clears after `eventHoldSeconds` (default 30).
- A siren becomes a sibling on/off plug.
- A battery camera reports a rechargeable power source. The plugin polls battery percent, charge level, and voltage.
- Live view uses the sub stream by default (`profile` can be `main`, `sub`, or `ext`). Snapshots use the same local RTSP URL.
- Optional email or webhook push delivers events from battery cameras that drop the Baichuan socket while they sleep. `configurePush` is off unless you opt in to writing the camera’s SMTP or webhook settings.
- Two-way talk, recordings, chime pairing, privacy mode, and UDP discovery are not in this version. Devices are added explicitly.

## Configuration

Add each camera to `devices` in the plugin config. `host`, `username`, and `password` are required. Optional fields are `name`, `port` (default 9000), `uid`, `transport` (`tcp` or `udp`), `channels`, and `profile` (`main`, `sub`, or `ext`, default `sub`).

Platform fields are `whiteList`, `blackList`, `debug`, `unregisterOnShutdown`, `eventHoldSeconds`, `batteryPollSeconds` (default 300, and 0 disables the poll), `push` (`none`, `email`, `webhook`, or `both`), `configurePush` (default false), `emailPushPort` (2525), `webhookPort` (9081), and `emailPushDomain` (`reolink.local`).

ffmpeg must be on `PATH`. Matterbridge shells out to it for WebRTC and snapshots. When email or webhook push is enabled, the camera must be able to reach the bridge. Leave `configurePush` off unless you want the plugin to change the camera’s SMTP or webhook URL. Passwords stay in the plugin config and are not written to the log. A failed login is logged and skipped; the other devices still start.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## Style guide

See [STYLEGUIDE.md](./STYLEGUIDE.md) for code style, naming, documentation, and testing conventions.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history and notable changes.

## Issues and feature requests

Report bugs and suggest improvements on [GitHub Issues](https://github.com/RyanMorash/matterbridge-reolink/issues).

## License

Licensed under the [Apache License 2.0](./LICENSE).
