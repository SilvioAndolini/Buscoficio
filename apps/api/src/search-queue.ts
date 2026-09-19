import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { QUEUE_DOCUMENTS, QUEUE_MAINTENANCE, QUEUE_MATCH, QUEUE_SEARCH } from './queue-names.js';

export function createSearchQueue(connection: IORedis, prefix?: string): Queue {
  return new Queue(QUEUE_SEARCH, prefix === undefined ? { connection } : { connection, prefix });
}

export function createMatchQueue(connection: IORedis, prefix?: string): Queue {
  return new Queue(QUEUE_MATCH, prefix === undefined ? { connection } : { connection, prefix });
}

export function createDocumentsQueue(connection: IORedis, prefix?: string): Queue {
  return new Queue(QUEUE_DOCUMENTS, prefix === undefined ? { connection } : { connection, prefix });
}

export function createMaintenanceQueue(connection: IORedis, prefix?: string): Queue {
  return new Queue(QUEUE_MAINTENANCE, prefix === undefined ? { connection } : { connection, prefix });
}