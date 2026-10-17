import { AdapterContext, NormalizedEvent } from './types';
import { EventBus } from './eventBus';
import { CheckpointStore } from './checkpointStore';
import { HealthRegistry } from './health';

export function makeAdapterContext(
  adapterId: string,
  bus: EventBus,
  checkpoints: CheckpointStore,
  health: HealthRegistry,
  captureContent: () => boolean = () => false
): AdapterContext {
  return {
    publish(event: NormalizedEvent) {
      bus.publish(event);
    },
    readCheckpoint() {
      return checkpoints.read(adapterId);
    },
    writeCheckpoint(checkpoint) {
      return checkpoints.write(adapterId, checkpoint);
    },
    reportHealth(key, message) {
      health.report(adapterId, key, message);
    },
    captureContent,
  };
}
