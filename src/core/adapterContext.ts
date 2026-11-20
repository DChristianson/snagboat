import { AdapterContext, NormalizedEvent } from '@snagboat/schema';
import { EventBus } from './eventBus';
import { CheckpointStore } from './checkpointStore';
import { HealthRegistry } from './health';

/** checkpoints: none for adapters that keep no read positions (a VS Code window's): reads find none, writes are dropped. */
export function makeAdapterContext(
  adapterId: string,
  bus: EventBus,
  checkpoints: CheckpointStore | undefined,
  health: HealthRegistry,
  captureContent: () => boolean = () => false
): AdapterContext {
  return {
    publish(event: NormalizedEvent) {
      bus.publish(event);
    },
    readCheckpoint() {
      return checkpoints ? checkpoints.read(adapterId) : Promise.resolve(undefined);
    },
    writeCheckpoint(checkpoint) {
      return checkpoints ? checkpoints.write(adapterId, checkpoint) : Promise.resolve();
    },
    reportHealth(key, message) {
      health.report(adapterId, key, message);
    },
    captureContent,
  };
}
