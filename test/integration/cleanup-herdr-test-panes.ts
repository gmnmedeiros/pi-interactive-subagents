import { cleanupStaleTestSurfaces } from "./harness.ts";

const remainingSurfaces: string[] = cleanupStaleTestSurfaces();

if (remainingSurfaces.length > 0) {
  throw new Error(`Failed to close Herdr test panes: ${remainingSurfaces.join(", ")}`);
}
