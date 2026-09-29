import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * The request body, or `{}` when the request has none.
 *
 * For routes whose body is entirely optional (`POST /api/workouts`,
 * `.../finish`, `.../sets`): a client may send no body at all. The global
 * `ZodValidationPipe` still validates the value against the parameter's Zod
 * DTO type, exactly as for `@Body()`. Pair it with `@ApiBody({ type, required:
 * false })` so the OpenAPI document still describes the body.
 */
export const BodyOrEmpty = createParamDecorator((_data: unknown, ctx: ExecutionContext): unknown => {
  const body = ctx.switchToHttp().getRequest<FastifyRequest>().body;
  return body === undefined || body === null ? {} : body;
});
