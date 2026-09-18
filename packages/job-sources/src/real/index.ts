import type { HttpClient, JobSourceAdapter } from '@job-system/core';
import { createFetchHttpClient } from '../http/fetch-client.js';
import { createArbeitnowAdapter, ARBEITNOW_POLICY_NOTES } from './arbeitnow.js';
import { createRemotiveAdapter, REMOTIVE_POLICY_NOTES } from './remotive.js';
import { createRemoteOkAdapter, REMOTEOK_POLICY_NOTES } from './remoteok.js';

export interface RealAdaptersOptions {
  http?: HttpClient;
  /** Test/E2E override: point adapters at a local fixture server. */
  bases?: { remotive?: string; arbeitnow?: string; remoteok?: string };
}

/** All Phase 2 real discovery adapters (each with its ToS policy notes). */
export function createRealSourceAdapters(options: RealAdaptersOptions = {}): JobSourceAdapter[] {
  const http = options.http ?? createFetchHttpClient();
  return [
    createRemotiveAdapter({
      http,
      ...(options.bases?.remotive === undefined ? {} : { baseUrl: options.bases.remotive }),
    }),
    createArbeitnowAdapter({
      http,
      ...(options.bases?.arbeitnow === undefined ? {} : { baseUrl: options.bases.arbeitnow }),
    }),
    createRemoteOkAdapter({
      http,
      ...(options.bases?.remoteok === undefined ? {} : { baseUrl: options.bases.remoteok }),
    }),
  ];
}

export const SOURCE_POLICY_NOTES: Record<string, string> = {
  remotive: REMOTIVE_POLICY_NOTES,
  arbeitnow: ARBEITNOW_POLICY_NOTES,
  remoteok: REMOTEOK_POLICY_NOTES,
};

export { createArbeitnowAdapter, createRemotiveAdapter, createRemoteOkAdapter };
export type { ArbeitnowOptions } from './arbeitnow.js';
export type { RemotiveOptions } from './remotive.js';
export type { RemoteOkOptions } from './remoteok.js';
export { ARBEITNOW_POLICY_NOTES, REMOTIVE_POLICY_NOTES, REMOTEOK_POLICY_NOTES };