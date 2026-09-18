export {
  buildNormalizedJob,
  normalizeJob,
  RawJobPayloadSchema,
  type RawJobPayload,
} from './normalize.js';
export {
  createMockJobSource,
  type MockJobSourceOptions,
} from './mock/mock-adapter.js';
export {
  MOCK_FIXTURE_FETCHED_AT,
  MOCK_PAYLOADS,
  MOCK_SOURCE_KEY,
} from './mock/fixtures.js';
export { SourceRegistry } from './registry.js';
export { createFetchHttpClient } from './http/fetch-client.js';
export {
  htmlToText,
  parseJobType,
  parseSalaryRange,
  positiveOrNull,
  type ParsedSalary,
} from './util/text.js';
export { detectAtsFromUrl, detectAtsFromUrls, type DetectedAtsTarget } from './util/targets.js';
export {
  ARBEITNOW_POLICY_NOTES,
  REMOTIVE_POLICY_NOTES,
  REMOTEOK_POLICY_NOTES,
  SOURCE_POLICY_NOTES,
  createArbeitnowAdapter,
  createRealSourceAdapters,
  createRemotiveAdapter,
  createRemoteOkAdapter,
  type ArbeitnowOptions,
  type RealAdaptersOptions,
  type RemotiveOptions,
  type RemoteOkOptions,
} from './real/index.js';