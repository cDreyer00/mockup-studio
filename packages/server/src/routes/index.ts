import type { Express } from 'express';
import { registerAssetsRoutes } from './assets.js';
import { registerDataRoutes } from './data.js';
import { registerFilesRoutes } from './files.js';
import type { RouteContext } from './shared.js';

export type { RouteContext } from './shared.js';

/** Routes for assets/CDN, repeater data and file organization. */
export function registerFeatureRoutes(app: Express, ctx: RouteContext): void {
  registerAssetsRoutes(app, ctx);
  registerDataRoutes(app, ctx);
  registerFilesRoutes(app, ctx);
}
