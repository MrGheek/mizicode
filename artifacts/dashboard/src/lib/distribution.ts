/**
 * distribution.ts
 *
 * Runtime helpers for checking which distribution is active.
 * The __IS_LOCAL_BUILD__ / __IS_CLOUD_BUILD__ constants are injected by Vite
 * at build time via the define config, enabling dead-code elimination of
 * cloud-specific UI in local builds and vice versa.
 */

declare const __IS_LOCAL_BUILD__: boolean;
declare const __IS_CLOUD_BUILD__: boolean;
declare const __MIZI_DISTRIBUTION__: string;

export const IS_LOCAL_BUILD: boolean =
  typeof __IS_LOCAL_BUILD__ !== "undefined" ? __IS_LOCAL_BUILD__ : false;

export const IS_CLOUD_BUILD: boolean =
  typeof __IS_CLOUD_BUILD__ !== "undefined" ? __IS_CLOUD_BUILD__ : true;

export const MIZI_DISTRIBUTION: string =
  typeof __MIZI_DISTRIBUTION__ !== "undefined" ? __MIZI_DISTRIBUTION__ : "cloud";
