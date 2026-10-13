import { archiveAdapters } from './adapters/archive'
import { audioAdapters } from './adapters/audio'
import { documentAdapters } from './adapters/document'
import { imageAdapters } from './adapters/image'
import { videoAdapters } from './adapters/video'
import { ConversionRegistry } from './registry'

/**
 * The application's conversion registry. Only adapters that are implemented and
 * covered by integration tests are registered here.
 */
export const registry = new ConversionRegistry()
for (const adapter of [...videoAdapters, ...audioAdapters, ...imageAdapters, ...documentAdapters, ...archiveAdapters]) {
  registry.register(adapter)
}
