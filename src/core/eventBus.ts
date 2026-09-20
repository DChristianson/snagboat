import { NormalizedEvent } from './types';

type Listener = (event: NormalizedEvent) => void;

export class EventBus {
  private listeners: Listener[] = [];

  onEvent(listener: Listener): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  publish(event: NormalizedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
