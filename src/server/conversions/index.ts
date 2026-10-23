import { archiveAdapters } from './adapters/archive'
import { audioAdapters } from './adapters/audio'
import { cleanAdapters } from './adapters/clean'
import { documentAdapters } from './adapters/document'
import { imageAdapters } from './adapters/image'
import { videoAdapters } from './adapters/video'
import { ConversionRegistry } from './registry'

/**
 * The application's conversion registry. Only adapters that are implemented and
 * covered by integration tests are registered here. Clean-up adapters come last
 * so real conversions stay first in the list of outputs.
 */
export const registry = new ConversionRegistry()
for (const adapter of [...videoAdapters, ...audioAdapters, ...imageAdapters, ...documentAdapters, ...archiveAdapters, ...cleanAdapters]) {
  registry.register(adapter)
}
