import * as fs from 'fs';
import * as path from 'path';
import { AdapterCheckpoint } from './types';

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class CheckpointStore {
  private readonly checkpointsDir: string;

  constructor(storageDir: string) {
    this.checkpointsDir = path.join(storageDir, 'checkpoints');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.checkpointsDir, { recursive: true });
  }

  private filePath(adapterId: string): string {
    return path.join(this.checkpointsDir, `${sanitize(adapterId)}.json`);
  }

  async read(adapterId: string): Promise<AdapterCheckpoint | undefined> {
    try {
      const contents = await fs.promises.readFile(this.filePath(adapterId), 'utf8');
      return JSON.parse(contents) as AdapterCheckpoint;
    } catch {
      return undefined;
    }
  }

  async write(adapterId: string, checkpoint: AdapterCheckpoint): Promise<void> {
    await fs.promises.writeFile(this.filePath(adapterId), JSON.stringify(checkpoint, null, 2), 'utf8');
  }
}
