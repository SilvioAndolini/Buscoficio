import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { QUEUE_SEARCH } from './queue-names.js';

export function createSearchQueue(connection: IORedis, prefix?: string): Queue {
  return new Queue(QUEUE_SEARCH, prefix === undefined ? { connection } : { connection, prefix });
}