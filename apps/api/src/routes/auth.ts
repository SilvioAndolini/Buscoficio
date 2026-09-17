import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '@job-system/core';
import { signSessionToken, verifyPassword } from '../auth.js';
import { parse, type ApiCtx } from '../context.js';

const LoginSchema = z.object({ password: z.string().min(1).max(200) });

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiCtx): void {
  app.post('/v1/auth/login', async (request, reply) => {
    const { password } = parse(LoginSchema, request.body, 'login payload');
    if (!verifyPassword(password, ctx.env.AUTH_PASSWORD_HASH)) {
      throw new UnauthorizedError('Invalid credentials');
    }
    const token = signSessionToken(ctx.env.AUTH_SECRET, ctx.clock.now());
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.env.AUTH_COOKIE_SECURE,
      path: '/',
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    ctx.logger.info({ correlationId: request.id }, 'user logged in');
    return { authenticated: true };
  });

  app.post('/v1/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { authenticated: false };
  });

  app.get('/v1/auth/me', async () => ({ authenticated: true }));
}