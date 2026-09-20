import { AdapterContext, NormalizedEvent } from './types';
import { EventBus } from './eventBus';
import { CheckpointStore } from './checkpointStore';

export function makeAdapterContext(
  adapterId: string,
  bus: EventBus,
  checkpoints: CheckpointStore
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
  };
}
