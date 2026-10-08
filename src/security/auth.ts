import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';

export function hasValidBearer(request: FastifyRequest, expected?: string): boolean {
  if (!expected) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function managementAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  return hasValidBearer(request, config.MANAGEMENT_API_TOKEN);
}
