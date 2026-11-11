import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// npm links global bins as symlinks, so argv[1] is the link, not the real file.
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}
