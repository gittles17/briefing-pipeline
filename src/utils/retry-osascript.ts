import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/**
 * Run an osascript with retry on timeout.
 * Tries once, waits 10s on failure, tries again.
 */
export async function runOsascript(scriptPath: string, timeout = 120000): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { stdout } = await exec('osascript', [scriptPath], { timeout });
      return stdout;
    } catch (err: any) {
      if (attempt < 2) {
        console.log(`[osascript] attempt ${attempt} failed (${err.message?.slice(0, 50)}) — retrying in 10s`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('osascript failed after 2 attempts');
}
