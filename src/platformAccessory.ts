import { Service, PlatformAccessory } from 'homebridge'//, CharacteristicValue } from 'homebridge'
import {
  BlindType,
  DeviceStatus,
  DeviceType,
  LimitsState,
  MotionGateway,
  Operation,
} from 'motionblinds'

import { BlindAccessoryConfig, BlindAccessoryContext, MotionBlindsPlatform } from './platform'

function IsVerticalBlind(blindType: BlindType) {
  switch (blindType) {
    case BlindType.RollerBlind:
    case BlindType.VenetianBlind:
    case BlindType.RomanBlind:
    case BlindType.HoneycombBlind:
    case BlindType.ShangriLaBlind:
    case BlindType.Awning:
    case BlindType.TopDownBottomUp:
    case BlindType.DayNightBlind:
    case BlindType.DimmingBlind:
    case BlindType.DoubleRoller:
    case BlindType.Switch:
      return true
    default:
      return false
  }
}

export class MotionBlindsAccessory {
  private service: Service
  private battery: Service | undefined // Make battery service optional
  private config: BlindAccessoryConfig

  constructor(
    private readonly platform: MotionBlindsPlatform,
    private readonly accessory: PlatformAccessory<BlindAccessoryContext>,
  ) {
    this.config = this.platform.blindConfigs.get(this.mac.toLowerCase()) ?? { mac: this.mac }

    const accessoryInfoService = this.accessory
      .getService(this.platform.Service.AccessoryInformation);

    if (!accessoryInfoService) {
      this.platform.log.error(`[${this.mac}] AccessoryInformation service not found! This should not happen.`);
    } else {
      accessoryInfoService
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'MOTION')
        .setCharacteristic(this.platform.Characteristic.Model, BlindType[this.status.type])
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.mac);
    }

    // TODO: Support TDBU blinds by creating two separate WindowCovering services

    this.service =
      this.accessory.getService(this.platform.Service.WindowCovering) ??
      this.accessory.addService(this.platform.Service.WindowCovering)

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.config.name ?? this.mac)

    // --- CurrentPosition Getter ---
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => {
        const currentPosition = this.status.currentPosition
        const homekitPosition = this.config.invert ? (100 - currentPosition) : currentPosition
        this.platform.log.debug(
          `<- get CurrentPosition (${this.mac}): blind=${currentPosition}, hk=${homekitPosition} (inverted=${!!this.config.invert})`,
        )
        return homekitPosition
      })

    // --- PositionState Getter ---
    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => {
        const state = this.positionState(this.status)
        this.platform.log.debug(`<- get PositionState (${this.mac}): ${state}`)
        return state
      })

    // A key is required for write commands
    if (this.platform.gateway.key) {
      // --- TargetPosition Getter & Setter ---
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetPosition)
        .onGet(() => {
          // Target position should also be inverted for HomeKit display consistency if needed
          // We store the HomeKit target position in context
          const targetPosition = this.accessory.context.targetPosition ?? this.getCurrentHomeKitPosition()
          this.platform.log.debug(`<- get TargetPosition (${this.mac}): ${targetPosition}`)
          return targetPosition
        })
        .onSet(async (value) => {
          const targetPosition = value as number // HomeKit position (0=Closed, 100=Open)
          const effectiveTarget = this.config.invert ? (100 - targetPosition) : targetPosition
          // Store the HomeKit target position in context
          this.accessory.context.targetPosition = targetPosition
          this.platform.log.debug(
            `-> set TargetPosition (${this.mac}): hk=${targetPosition}, blind=${effectiveTarget} (inverted=${!!this.config.invert})`,
          )
          try {
            await this.platform.gateway
              .writeDevice(this.mac, this.deviceType, { targetPosition: effectiveTarget })
            this.platform.log.debug(`<- writeDevice(${this.mac}, targetPosition=${effectiveTarget}) OK`)
            // Optimistically update state? Maybe not necessary as report should follow.
          } catch (err) {
            this.platform.log.error(`<- writeDevice(${this.mac}, targetPosition=${effectiveTarget}) FAILED: ${err}`)
            // Rethrow the error so HomeKit knows it failed
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
          }
        })

      // --- HoldPosition Setter ---
      this.service
        .getCharacteristic(this.platform.Characteristic.HoldPosition)
        .onSet(async () => {
          // This characteristic is write-only (value is always true when set)
          this.platform.log.debug(`-> set HoldPosition (${this.mac})`)
          try {
            await this.platform.gateway
              .writeDevice(this.mac, this.deviceType, { operation: Operation.Stop })
            this.platform.log.debug(`<- writeDevice(${this.mac}, operation=Stop) OK`)
          } catch (err) {
            this.platform.log.error(`<- writeDevice(${this.mac}, operation=Stop) FAILED: ${err}`)
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
          }
        })

      // --- Tilt Logic (with modern getters/setters and error handling) ---
      if (this.config.tilt) {
        const targetTiltCharacteristic = IsVerticalBlind(this.status.type)
          ? this.platform.Characteristic.TargetVerticalTiltAngle
          : this.platform.Characteristic.TargetHorizontalTiltAngle
        const currentTiltCharacteristic = IsVerticalBlind(this.status.type)
          ? this.platform.Characteristic.CurrentVerticalTiltAngle
          : this.platform.Characteristic.CurrentHorizontalTiltAngle

        // Target Tilt Angle
        this.service
          .getCharacteristic(targetTiltCharacteristic)
          .onGet(() => {
            const targetAngle = this.accessory.context.targetAngle ?? (this.status.currentAngle - 90)
            this.platform.log.debug(`<- get TargetTiltAngle (${this.mac}): ${targetAngle}`)
            return targetAngle
          })
          .onSet(async (value) => {
            const targetAngle = value as number // HomeKit angle [-90, 90]
            const effectiveTarget = targetAngle + 90 // Convert to blind angle [0, 180]
            this.accessory.context.targetAngle = targetAngle
            this.platform.log.debug(`-> set TargetTiltAngle (${this.mac}): hk=${targetAngle}, blind=${effectiveTarget}`)
            try {
              await this.platform.gateway
                .writeDevice(this.mac, this.deviceType, { targetAngle: effectiveTarget })
              this.platform.log.debug(`<- writeDevice(${this.mac}, targetAngle=${effectiveTarget}) OK`)
            } catch (err) {
              this.platform.log.error(`<- writeDevice(${this.mac}, targetAngle=${effectiveTarget}) FAILED: ${err}`)
              throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
            }
          })

        // Current Tilt Angle
        this.service
          .getCharacteristic(currentTiltCharacteristic)
          .onGet(() => {
            const currentAngle = this.status.currentAngle - 90 // Convert from blind [0, 180] to HomeKit [-90, 90]
            this.platform.log.debug(
              `<- get CurrentTiltAngle (${this.mac}): blind=${this.status.currentAngle}, hk=${currentAngle}`,
            )
            return currentAngle
          })
      }
    } else {
      // If no key, make characteristics read-only by removing setters/write perm
      this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).props.perms = [this.platform.api.hap.Perms.PAIRED_READ, this.platform.api.hap.Perms.NOTIFY]
      this.service.getCharacteristic(this.platform.Characteristic.HoldPosition).props.perms = [] // No read/write/notify
      if (this.config.tilt) {
        const targetTiltCharacteristic = IsVerticalBlind(this.status.type)
          ? this.platform.Characteristic.TargetVerticalTiltAngle
          : this.platform.Characteristic.TargetHorizontalTiltAngle
        this.service.getCharacteristic(targetTiltCharacteristic).props.perms = [this.platform.api.hap.Perms.PAIRED_READ, this.platform.api.hap.Perms.NOTIFY]
      }
    }

    // --- Battery Service (Conditional based on config override OR voltageMode) ---
    let isBatteryPowered: boolean
    if (this.config.isBatteryPowered !== undefined) {
      // Use the explicit config setting if provided
      isBatteryPowered = this.config.isBatteryPowered
      this.platform.log.debug(`[${this.mac}] Using explicit config isBatteryPowered=${isBatteryPowered}`)
    } else {
      // Fallback to voltageMode check if config setting is missing
      isBatteryPowered = this.status.voltageMode === 0
      this.platform.log.warn( // Line 173
        `[${this.mac}] Config 'isBatteryPowered' not set. ` +
        `Falling back to voltageMode (=${this.status.voltageMode}, ` +
        `assuming isBatteryPowered=${isBatteryPowered}). ` +
        'Set in config.json ' +
        'for reliability.',
      ) // eslint-disable-line max-len
    }

    // Log final decision
    this.platform.log.debug( // Line 179
      `[${this.mac}] Power source check: ` +
      'isBatteryPowered=' +
      `${isBatteryPowered}`,
    ) // eslint-disable-line max-len

    if (isBatteryPowered) {
      this.platform.log.info(
        `[${this.mac}] Blind is configured or detected ` +
        'as battery powered. Adding Battery service.',
      )
      this.battery =
          this.accessory.getService(this.platform.Service.Battery) ??
          this.accessory.addService(this.platform.Service.Battery, 'Battery', `${this.mac}-Battery`)

      this.battery
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .onGet(() => {
          const status = this.batteryStatus(this.status)
          this.platform.log.debug(`<- get StatusLowBattery (${this.mac}): ${status}`)
          return status
        })

      this.battery
        .getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .onGet(() => {
          const level = this.batteryLevel(this.status)
          this.platform.log.debug(`<- get BatteryLevel (${this.mac}): ${level}`)
          return level
        })
    } else {
      this.platform.log.info(
        `[${this.mac}] Blind is configured or detected as mains powered. ` +
        'Removing existing Battery service if present.',
      )
      // If not battery powered, try to remove any existing battery service
      const existingBatteryService = this.accessory.getService(this.platform.Service.Battery)
      if (existingBatteryService) {
        this.accessory.removeService(existingBatteryService)
        this.platform.log.debug(`[${this.mac}] Removed Battery service.`)
      }
      this.battery = undefined // Ensure battery service reference is undefined
    }

    // --- Polling ---
    // Allow polling interval configuration, default to 30s, 0 disables
    const pollInterval = this.config.pollInterval ?? 60000 // Changed default to 60000ms (60s)
    if (pollInterval > 0) {
      setInterval(() => {
        this.platform.log.debug(`-> Polling readDevice(${this.mac}, ${this.deviceType})`)
        this.platform.gateway
          .readDevice(this.mac, this.deviceType)
          .then((res) => {
            this.platform.log.debug(
              `<- Polling readDevice(${this.mac}, ${this.deviceType}) => ` +
              `${JSON.stringify(res.data)}`,
            )
            this.updateAccessory(res.data)
          })
          .catch((err) => {
            this.platform.log.debug(
              `Polling readDevice(${this.mac}, ${this.deviceType}) failed: `,
              err.message,
            )
            // Consider marking accessory offline? Homebridge might do this automatically on communication failures.
          })
      }, pollInterval)
    }

    // --- Gateway Event Listener (Handled by platform globally) ---
    // No need for accessory-specific listener here

    // Initialize context target position/angle if undefined
    if (this.accessory.context.targetPosition === undefined) {
      this.accessory.context.targetPosition = this.getCurrentHomeKitPosition()
    }
    if (this.config.tilt && this.accessory.context.targetAngle === undefined) {
      this.accessory.context.targetAngle = this.status.currentAngle - 90
    }

    // Initial update based on cached status
    this.updateAccessory(this.status, true) // Pass flag to indicate initial update
  }

  // --- Getters for context properties ---
  get mac() {
    return this.accessory.context.mac ?? ''
  }

  get deviceType(): DeviceType {
    // Return the stored device type, defaulting to Unknown (0) if undefined
    // Use the recommended cast via 'unknown' to resolve TS2352
    return this.accessory.context.deviceType ?? (0 as unknown as DeviceType)
  }

  get status() {
    // Return a default status if context is missing to prevent errors during init
    // Use numeric enum values or appropriate defaults if direct enum members cause issues
    return this.accessory.context.status ?? {
      type: BlindType.RollerBlind, // Assuming this enum member is correct
      currentPosition: 50,
      currentAngle: 90,
      operation: Operation.Stop, // Assuming this enum member is correct
      batteryLevel: 0,
      // Corrected enum values based on potential definitions or using numeric defaults
      currentState: LimitsState.NoLimits, // Corrected based on error message
      voltageMode: 0, // Using numeric default, replace if actual enum member is known
      wirelessMode: 0, // Using numeric default, replace if actual enum member is known
      RSSI: 0,
    }
  }

  // --- Helper to get current position adjusted for HomeKit inversion ---
  getCurrentHomeKitPosition(): number {
    const currentPosition = this.status.currentPosition
    return this.config.invert ? (100 - currentPosition) : currentPosition
  }

  // --- Battery Helpers ---
  batteryLevel(status: DeviceStatus): number {
    const rawBattery = typeof status.batteryLevel === 'number' ? status.batteryLevel : 0
    // Assuming BatteryInfo returns [voltage, percentage 0-1]
    return Math.round(MotionGateway.BatteryInfo(rawBattery)[1] * 100)
  }

  batteryStatus(status: DeviceStatus): number {
    const level = this.batteryLevel(status)
    // Allow configuration of low battery threshold, default 20
    const lowBatteryThreshold = this.config.lowBatteryThreshold ?? 20
    return level >= lowBatteryThreshold
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
  }

  // --- PositionState Calculation (Refactored) ---
  positionState(status: DeviceStatus): 0 | 1 | 2 {
    const DECREASING = this.platform.Characteristic.PositionState.DECREASING // 0
    const INCREASING = this.platform.Characteristic.PositionState.INCREASING // 1
    const STOPPED = this.platform.Characteristic.PositionState.STOPPED // 2

    const operation = status.operation ?? Operation.Stop
    const isInverted = !!this.config.invert
    let calculatedState: 0 | 1 | 2

    switch (operation) {
      case Operation.CloseDown: // Moving down
        calculatedState = isInverted ? INCREASING : DECREASING
        break
      case Operation.OpenUp: // Moving up
        calculatedState = isInverted ? DECREASING : INCREASING
        break
      case Operation.Stop:
      default:
        calculatedState = STOPPED
        break
    }
    return calculatedState
  }

  // --- Update Accessory Characteristics (Refactored) ---
  updateAccessory(newStatus: DeviceStatus, isInitialUpdate = false) {
    const prevStatus = this.status // Get previous status before updating context
    const isInverted = !!this.config.invert

    // Calculate HomeKit values based on newStatus and inversion
    const newHomeKitPosition = isInverted ? (100 - newStatus.currentPosition) : newStatus.currentPosition
    const newHomeKitState = this.positionState(newStatus)
    const newHomeKitAngle = newStatus.currentAngle - 90 // HomeKit tilt [-90, 90]
    const newBatteryLevel = this.batteryLevel(newStatus)
    const newBatteryStatus = this.batteryStatus(newStatus)

    // Get previous HomeKit values for comparison
    const prevHomeKitPosition = this.getCurrentHomeKitPosition()
    const prevHomeKitState = this.positionState(prevStatus)
    const prevHomeKitAngle = prevStatus.currentAngle - 90
    const prevBatteryLevel = this.batteryLevel(prevStatus)
    const prevBatteryStatus = this.batteryStatus(prevStatus)

    this.platform.log.debug(`Updating accessory ${this.mac} (inverted=${isInverted})`)
    this.platform.log.debug(
      `  Blind Status: pos=${newStatus.currentPosition}, angle=${newStatus.currentAngle}, ` +
      `op=${Operation[newStatus.operation]}, batt=${newStatus.batteryLevel}`,
    )
    this.platform.log.debug(
      `  HK Status:    pos=${newHomeKitPosition}, state=${newHomeKitState}, ` +
      `angle=${newHomeKitAngle}, battLvl=${newBatteryLevel}, battStat=${newBatteryStatus}`,
    )

    // Update CurrentPosition if changed or initial update
    if (newHomeKitPosition !== prevHomeKitPosition || isInitialUpdate) {
      this.platform.log.debug(`$ CurrentPosition (${this.mac}) ${prevHomeKitPosition} -> ${newHomeKitPosition}`)
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentPosition,
        newHomeKitPosition,
      )
    }

    // Update PositionState if changed or initial update
    if (newHomeKitState !== prevHomeKitState || isInitialUpdate) {
      this.platform.log.debug(`$ PositionState (${this.mac}) ${prevHomeKitState} -> ${newHomeKitState}`)
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, newHomeKitState)
    }

    // If state changed TO stopped, update TargetPosition to match CurrentPosition
    if (newHomeKitState !== prevHomeKitState && newHomeKitState === this.platform.Characteristic.PositionState.STOPPED) {
      this.platform.log.debug(`$ TargetPosition (${this.mac}) -> ${newHomeKitPosition} (stopped)`)
      this.accessory.context.targetPosition = newHomeKitPosition // Update context
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, newHomeKitPosition)
      // DO NOT update HoldPosition here. It's write-only for commands.
    }

    // Update Tilt if enabled and changed or initial update
    if (this.config.tilt) {
      const currentTiltCharacteristic = IsVerticalBlind(newStatus.type)
        ? this.platform.Characteristic.CurrentVerticalTiltAngle
        : this.platform.Characteristic.CurrentHorizontalTiltAngle

      if (newHomeKitAngle !== prevHomeKitAngle || isInitialUpdate) {
        this.platform.log.debug(`$ CurrentTiltAngle (${this.mac}) ${prevHomeKitAngle} -> ${newHomeKitAngle}`)
        this.service.updateCharacteristic(currentTiltCharacteristic, newHomeKitAngle)

        // If state is stopped, update target angle as well for consistency
        if (newHomeKitState === this.platform.Characteristic.PositionState.STOPPED) {
          this.platform.log.debug(`$ TargetTiltAngle (${this.mac}) -> ${newHomeKitAngle} (stopped)`)
          this.accessory.context.targetAngle = newHomeKitAngle // Update context
          const targetTiltCharacteristic = IsVerticalBlind(newStatus.type)
            ? this.platform.Characteristic.TargetVerticalTiltAngle
            : this.platform.Characteristic.TargetHorizontalTiltAngle
          this.service.updateCharacteristic(targetTiltCharacteristic, newHomeKitAngle)
        }
      }
    }

    // Update Battery Level and Status only if the battery service exists
    if (this.battery) {
      // Update Battery Level if changed or initial update
      if (newBatteryLevel !== prevBatteryLevel || isInitialUpdate) {
        this.platform.log.debug(`$ BatteryLevel (${this.mac}) ${prevBatteryLevel} -> ${newBatteryLevel}`)
        this.battery.updateCharacteristic(this.platform.Characteristic.BatteryLevel, newBatteryLevel)
      }

      // Update Battery Status if changed or initial update
      if (newBatteryStatus !== prevBatteryStatus || isInitialUpdate) {
        this.platform.log.debug(`$ StatusLowBattery (${this.mac}) ${prevBatteryStatus} -> ${newBatteryStatus}`)
        this.battery.updateCharacteristic(
          this.platform.Characteristic.StatusLowBattery,
          newBatteryStatus,
        )
      }
    } else {
      // If battery service doesn't exist, ensure no battery info is logged as being updated
      // Log only if it's not the initial update to avoid spamming logs
      if (!isInitialUpdate) {
        this.platform.log.debug(`[${this.mac}] Skipping battery updates as blind is not battery powered.`)
      }
    }

    // Update the stored status context *after* comparisons and updates
    this.accessory.context.status = newStatus
  }
}
