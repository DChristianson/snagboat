import * as fs from 'fs';
import * as path from 'path';

/** Minimal recursive file finder; only supports the "**\/*.test.js" case we need here. */
export function globSync(pattern: string, root: string): string[] {
  if (pattern !== '**/*.test.js') {
    throw new Error(`Unsupported pattern: ${pattern}`);
  }
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        results.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return results;
}
