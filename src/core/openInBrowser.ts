import { spawn } from 'child_process';

/** Opens a URL in the default browser: true once the opener started, false if there's none (a container without xdg-open). */
export function openInBrowser(url: string): Promise<boolean> {
  // start's first quoted argument is the window title: an empty one, which Node passes to cmd as "".
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
