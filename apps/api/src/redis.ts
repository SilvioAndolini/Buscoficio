import IORedis from 'ioredis';

/** BullMQ requires maxRetriesPerRequest=null on blocking connections. */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}