import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge'
import { DeviceStatus, DeviceType, DEVICE_TYPES, MotionGateway, Report } from 'motionblinds'

import { PLATFORM_NAME, PLUGIN_NAME } from './settings'
import { MotionBlindsAccessory } from './platformAccessory'

export type BlindAccessoryConfig = {
  mac: string
  name?: string
  tilt?: boolean
  invert?: boolean
  pollInterval?: number // Add optional pollInterval
  lowBatteryThreshold?: number // Add optional lowBatteryThreshold
  isBatteryPowered?: boolean // Add optional flag to override voltageMode check
}

export type BlindAccessoryContext = {
  mac?: string
  deviceType?: DeviceType
  status?: DeviceStatus
  targetPosition?: number
  targetAngle?: number
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class MotionBlindsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic

  public readonly accessories: PlatformAccessory[] = []
  public readonly blindConfigs = new Map<string, BlindAccessoryConfig>()
  public readonly gateway: MotionGateway

  private seenThisSession = new Set<string>()

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing MotionBlindsPlatform...') // Log platform init start

    // Load any configured blinds into a map
    if (Array.isArray(this.config.blinds)) {
      this.log.info(`Found ${this.config.blinds.length} blind configurations in config.json`)
      for (const entry of this.config.blinds) {
        if (typeof entry.mac !== 'string') {
          this.log.error('Blinds config entry is missing "mac", ignoring')
        } else {
          const macLower = entry.mac.toLowerCase() // Convert MAC to lowercase
          // Log the exact configuration being stored for each blind
          this.log.info(
            `Loading config for MAC: ${macLower} (Original: ${entry.mac}), ` +
            `Name: ${entry.name}, Invert: ${entry.invert}, Tilt: ${entry.tilt}, ` +
            `PollInterval: ${entry.pollInterval}, LowBattery: ${entry.lowBatteryThreshold}, ` +
            `IsBatteryPowered: ${entry.isBatteryPowered}`,
          ) // Log new option
          this.blindConfigs.set(macLower, entry) // Use lowercase MAC as key
        }
      }
    } else {
      this.log.warn('No "blinds" array found in config.json. Blinds must be configured manually.')
    }

    this.gateway = new MotionGateway({ key: config.key, gatewayIp: config.gatewayIp })

    this.log.debug('Finished initializing platform:', this.config.name)

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback')
      this.gateway.on('report', this.handleReport)
      this.discoverDevices()
    })
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName)
    this.accessories.push(accessory)
  }

  async discoverDevices() {
    try {
      this.log.debug('-> readAllDevices()')
      const devices = await this.gateway.readAllDevices()
      const newUUIDs = new Set<string>(devices.map((d) => this.api.hap.uuid.generate(d.mac)))
      this.log.debug(
        `<- readAllDevices() found ${devices.length} devices, uuids=${[...newUUIDs].join(', ')}`,
      )

      // Add newly discovered and previously discovered devices
      for (const device of devices) {
        this.maybeAddOrUpdateAccessory(device.mac, device.deviceType, device.data)
      }

      // Remove previously discovered devices that no longer exist
      const removed = this.accessories.filter((a) => !newUUIDs.has(a.UUID))
      if (removed.length) {
        this.log.warn(`Removing ${removed.length} accessories that are no longer present`)
        for (const accessory of removed) {
          this.accessories.splice(this.accessories.indexOf(accessory), 1)
        }
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed)
      }
    } catch (err) {
      this.log.error('Failed fetching list of MOTION Blinds:', err)
    }
  }

  maybeAddOrUpdateAccessory(mac: string, deviceType: DeviceType, status: DeviceStatus) {
    if (this.seenThisSession.has(mac)) {
      return
    }
    this.seenThisSession.add(mac)

    const uuid = this.api.hap.uuid.generate(mac)
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid)

    if (existingAccessory) {
      // the accessory already exists
      this.log.info(`Restoring existing accessory from cache [${existingAccessory.displayName}], status=${JSON.stringify(status)}`)
      existingAccessory.context.status = status
      this.api.updatePlatformAccessories([existingAccessory])
      new MotionBlindsAccessory(this, existingAccessory)
    } else {
      this.log.info(
        `Adding new accessory: mac=${mac}, uuid=${uuid}, deviceType=${
          DEVICE_TYPES[deviceType]
        }, status=${JSON.stringify(status)}`,
      )
      this.addAccessory(mac, uuid, deviceType, status)
    }
  }

  addAccessory(mac: string, uuid: string, deviceType: DeviceType, status: DeviceStatus) {
    // the accessory does not yet exist, so we need to create it
    this.log.info('Adding new accessory:', mac)

    // create a new accessory
    const accessory = new this.api.platformAccessory<BlindAccessoryContext>(mac, uuid)

    // store a copy of the device object in the `accessory.context`
    // the `context` property can be used to store any data about the accessory you may need
    accessory.context.mac = mac
    accessory.context.deviceType = deviceType
    accessory.context.status = status

    // create the accessory handler for the newly create accessory
    // this is imported from `platformAccessory.ts`
    new MotionBlindsAccessory(this, accessory)

    // link the accessory to your platform
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
  }

  handleReport = (report: Report) => {
    this.maybeAddOrUpdateAccessory(report.mac, report.deviceType, report.data)
  }
}
