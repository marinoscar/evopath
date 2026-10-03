import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { forCoach, safely } from './minimise';
import { dropNulls, userText } from './user-context';

/**
 * `get_gyms` (#338): every gym of the caller (default, temporary and other
 * ones) with its type, description, notes, location, and the FULL equipment
 * inventory: each item's catalog name, category and description, quantity,
 * brand, model, the user's notes, how it got there (manual or AI scan, with
 * the AI's confidence, whether the user verified it and what the scan first
 * read), plus the gym photos' captions and dates and which equipment they
 * show. Never a photo's storage object, key or URL. Two reads per level,
 * batched by Prisma; scoped to `userId`.
 */
export function createGetGymsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_gyms',
    description:
      "Every gym the user has set up: name, type (home, club, office, hotel, apartment, outdoor, other), the user's " +
      'description and notes, whether it is the default or temporary, its location (latitude/longitude) and the ' +
      'full equipment inventory (each machine or tool: name, category, quantity, brand, model, the user\'s notes ' +
      'such as seat settings, whether an AI scan found it, its confidence and whether the user verified it), plus ' +
      'photo captions and which equipment each photo shows. Call it before talking about what equipment or ' +
      'machines the user has or where they train.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const gyms = await deps.prisma.gym.findMany({
          where: { userId: ctx.userId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: {
            name: true,
            type: true,
            description: true,
            notes: true,
            latitude: true,
            longitude: true,
            isDefault: true,
            isTemporary: true,
            createdAt: true,
            equipment: {
              orderBy: [{ equipmentType: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
              select: {
                quantity: true,
                brand: true,
                model: true,
                notes: true,
                origin: true,
                confidence: true,
                userVerified: true,
                originalAiValue: true,
                equipmentType: { select: { name: true, category: true, description: true, ownerUserId: true } },
              },
            },
            photos: {
              orderBy: { createdAt: 'asc' },
              select: {
                caption: true,
                takenAt: true,
                createdAt: true,
                equipment: { select: { gymEquipment: { select: { equipmentType: { select: { name: true } } } } } },
              },
            },
          },
        });

        return {
          count: gyms.length,
          gyms: gyms.map((gym) => ({
            name: gym.name,
            type: gym.type,
            default: gym.isDefault,
            temporary: gym.isTemporary,
            ...dropNulls({
              description: userText(gym.description),
              notes: userText(gym.notes),
              location: gym.latitude !== null && gym.longitude !== null ? { latitude: gym.latitude, longitude: gym.longitude } : null,
            }),
            addedOn: gym.createdAt.toISOString().slice(0, 10),
            equipment: gym.equipment.map((item) =>
              dropNulls({
                name: item.equipmentType.name,
                category: item.equipmentType.category,
                description: userText(item.equipmentType.description),
                customType: item.equipmentType.ownerUserId ? true : null,
                quantity: item.quantity,
                brand: userText(item.brand),
                model: userText(item.model),
                notes: userText(item.notes),
                origin: item.origin,
                aiConfidence: item.confidence,
                userVerified: item.userVerified,
                aiOriginallyRead: item.originalAiValue ? forCoach(item.originalAiValue) : null,
              }),
            ),
            photos: gym.photos.map((photo) =>
              dropNulls({
                caption: userText(photo.caption),
                takenOn: (photo.takenAt ?? photo.createdAt).toISOString().slice(0, 10),
                shows: photo.equipment.length ? photo.equipment.map((link) => link.gymEquipment.equipmentType.name) : null,
              }),
            ),
          })),
        };
      }, TOOL_UNAVAILABLE),
  });
}
