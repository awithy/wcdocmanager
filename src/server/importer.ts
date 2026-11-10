import { spawn } from 'node:child_process';
import type { ImportResult } from '../shared/types';

const MAX_OUTPUT = 200_000;

/** Runs the phone pull script, capturing interleaved stdout/stderr. */
export function runImport(script: string, timeoutMs = 10 * 60_000): Promise<ImportResult> {
  return new Promise((resolve) => {
    let output = '';
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    const child = spawn(script, [], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => resolve({ ok: false, output: `${output}${err.message}\n` }));
    child.on('close', (code, signal) => {
      const status = signal ? `killed by ${signal}` : code === 0 ? '' : `exited with code ${code}`;
      resolve({ ok: code === 0, output: status ? `${output}\n[${status}]\n` : output });
    });
  });
}
