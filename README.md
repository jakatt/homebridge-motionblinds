# homebridge-motionblinds

[![npm](https://badgen.net/npm/v/homebridge-motionblinds)](https://www.npmjs.com/package/homebridge-motionblinds)
[![npm](https://badgen.net/npm/dt/homebridge-motionblinds)](https://www.npmjs.com/package/homebridge-motionblinds)

Homebridge plugin to control MOTION Blinds by Coulisse B.V. including derivative products such as OmniaBlinds.

## Installation
1. Follow the step-by-step instructions on the [Homebridge Wiki](https://github.com/homebridge/homebridge/wiki) for how to install Homebridge.
2. Follow the step-by-step instructions on the [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x/wiki) for how to install Homebridge Config UI X.
3. Install homebridge-motionblinds using: `npm install -g homebridge-motionblinds` or search for `MOTION Blinds` in Config UI X.

## Info
1. Blinds are only identified by a 16-character MAC address. They will show up in HomeKit with the MAC address as their name. You can rename them in HomeKit or using the configuration options below.
2. If your blinds support tilt angle control, you must manually enable it using the "tilt" config option described below.
3. If your blind is moving up when it should move down, or left when it should move right, use the "invert" config option described below.

## Configuration

All fields are optional except `"platform"`, and `"mac"` if any blinds are specified. If no `"key"` is given, blinds will appear as read only with no control. If you are having connectivity issues, try specifying the `"gatewayIp"`.

```json
{
  "platform": "MotionBlinds",
  "key": "xxxxxxxx-xxxx-xx",
  "gatewayIp": "10.0.0.23",
  "blinds": [
    {
      "mac": "xxxxxxxxxxxxxxxx",
      "name": "Bedroom Blinds",
      "tilt": true,
      "invert": false,
      "pollInterval": 60000, // Optional: Poll status every 60 seconds (default)
      "lowBatteryThreshold": 20, // Optional: Set low battery warning threshold (default: 20%)
      "isBatteryPowered": true // Optional: Explicitly set if battery powered (overrides auto-detect)
    },
    {
      "mac": "xxxxxxxxxxxxxxxx",
      "name": "Living Room Roller Shade",
      "tilt": false,
      "invert": false,
      "pollInterval": 60000, // Optional: Poll status every 60 seconds (default)
      "isBatteryPowered": false // Optional: Set to false for grid-powered blinds
    }
  ]
}
```

## Plugin Improvements

This version of the plugin includes several important improvements over the original:

1. **Fixed Invert Mode**: Corrected erratic behavior when using the `invert` option, ensuring consistent operation.
2. **Improved HomeKit Status Updates**: Fixed inconsistencies in status reporting to Apple HomeKit.
3. **Better Power Source Management**: Proper handling of grid-powered blinds vs. battery-powered blinds.
   - For grid-powered blinds, set `"isBatteryPowered": false` to remove the battery service from HomeKit.
   - For battery-powered blinds, set `"isBatteryPowered": true` or leave unspecified for auto-detection.

**Configuration Options:**

*   `key`: (Required for control) The 16-character key printed on the bottom of the MOTION gateway/bridge.
*   `gatewayIp`: (Optional) Specify the gateway IP address to skip discovery. Useful for complex network setups.
*   `blinds`: (Array) List of individual blind configurations.
    *   `mac`: (Required) The MAC address of the blind (e.g., F4CFA2ABAAA40001).
    *   `name`: (Required) The name for this blind in HomeKit.
    *   `tilt`: (Optional, default: `false`) Enable horizontal/vertical tilt control if the blind supports it.
    *   `invert`: (Optional, default: `false`) Invert the position values (0=Open, 100=Closed).
    *   `pollInterval`: (Optional, default: `60000`) Interval in milliseconds to poll the blind status (0 to disable).
    *   `lowBatteryThreshold`: (Optional, default: `20`) Battery percentage below which the low battery status is triggered.
    *   `isBatteryPowered`: (Optional) Explicitly set if the blind is battery powered (`true` or `false`). Overrides automatic detection based on `voltageMode`. Useful for mains-powered blinds reporting incorrect voltage.
