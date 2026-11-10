import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Creates a copy of `src` at `<dir>/<base><ext>` without ever overwriting an existing file,
 * appending " (2)", " (3)", ... on collision. Returns the absolute destination path.
 *
 * Uses link(2), which is atomic and fails with EEXIST rather than clobbering. Falls back to an
 * exclusive copy (verified by hash) when hard links aren't possible, e.g. across filesystems.
 * The caller removes `src` once it has recorded the new location.
 */
export async function placeNoClobber(
  src: string,
  dir: string,
  base: string,
  ext: string,
  expectedSha256?: string,
): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const dest = join(dir, `${base}${n === 1 ? '' : ` (${n})`}${ext}`);
    try {
      await link(src, dest);
      return dest;
    } catch (err) {
      const code = errCode(err);
      if (code === 'EEXIST') continue;
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
    }
    try {
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    } catch (err) {
      if (errCode(err) === 'EEXIST') continue;
      throw err;
    }
    const expected = expectedSha256 ?? (await sha256File(src));
    if ((await sha256File(dest)) !== expected) {
      await rm(dest, { force: true });
      throw new Error(`Copy verification failed for ${dest}`);
    }
    return dest;
  }
  throw new Error(`Too many name collisions in ${dir}`);
}

/** Removes `dir` and its parents while they are empty, stopping at (and never removing) `root`. */
export async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  let current = resolve(dir);
  while (isInside(root, current)) {
    try {
      await rmdir(current);
    } catch (err) {
      // Not empty (or otherwise not removable): leave it, and its parents, alone.
      if (errCode(err) !== 'ENOENT') return;
    }
    current = dirname(current);
  }
}

/** Serializes async operations so filesystem + DB mutations never interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
