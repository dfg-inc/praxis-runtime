import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/**
 * The real location of `relative` under `root`, or UNSAFE_PATH. The check is on the path the operating system will actually
 * use: symbolic links in the root, in any directory of the path and in the file itself are resolved first, so a link inside
 * the repository that points outside it (or a dangling one) is refused, and so are absolute paths, `..` segments and NUL.
 * A path that does not exist yet (a file about to be written) is judged by its nearest existing parent.
 */
export function containedPath(root: string, relative: unknown): string {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0") || isAbsolute(relative) || relative.split(/[/\\]/).includes("..")) {
    throw new Error("UNSAFE_PATH");
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    throw new Error("UNSAFE_PATH");
  }
  const lexical = resolve(realRoot, relative);
  if (!within(realRoot, lexical)) throw new Error("UNSAFE_PATH");
  let existing = lexical;
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error("UNSAFE_PATH");
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new Error("UNSAFE_PATH"); // a dangling link
  }
  const real = resolve(realExisting, ...rest);
  if (!within(realRoot, real)) throw new Error("UNSAFE_PATH");
  return real;
}
