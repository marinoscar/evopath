/**
 * Gyms fixtures (E3.3): builders for the API views and a small stateful MSW
 * API that behaves like `apps/api/src/gyms` for the web suites (first gym is
 * the default, delete promotes the oldest remaining gym, equipment and photos
 * hang off a gym, custom types join the catalog).
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type {
  EquipmentType,
  GymDetail,
  GymEquipment,
  GymPhoto,
  GymSummary,
} from '../../../services/gyms';

const API = '*/api';
const NOW = '2026-09-29T12:00:00.000Z';

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  // Shaped like a UUID so nothing that validates ids trips on it.
  return `00000000-0000-4000-8000-${prefix}${String(seq).padStart(12 - prefix.length, '0')}`;
};

export const ELLIPTICAL: EquipmentType = {
  id: '00000000-0000-4000-8000-e00000000001',
  slug: 'elliptical',
  name: 'Elliptical',
  category: 'cardio',
  aliases: ['cross trainer'],
  description: null,
  isCustom: false,
  capabilities: [{ id: 'c1', slug: 'cardio_steady', name: 'Steady cardio' }],
};

export const DUMBBELLS: EquipmentType = {
  id: '00000000-0000-4000-8000-e00000000002',
  slug: 'dumbbells',
  name: 'Dumbbells',
  category: 'free_weights',
  aliases: [],
  description: null,
  isCustom: false,
  capabilities: [
    { id: 'c2', slug: 'db_press', name: 'Dumbbell press' },
    { id: 'c3', slug: 'db_row', name: 'Dumbbell row' },
  ],
};

export const LEG_CURL: EquipmentType = {
  id: '00000000-0000-4000-8000-e00000000003',
  slug: 'leg-curl-machine',
  name: 'Leg curl machine',
  category: 'selectorized',
  aliases: [],
  description: null,
  isCustom: false,
  capabilities: [{ id: 'c4', slug: 'leg_curl', name: 'Leg curl' }],
};

export const CATALOG: EquipmentType[] = [DUMBBELLS, LEG_CURL, ELLIPTICAL];

export const CAPABILITIES = [
  { id: 'c5', slug: 'farmer_carry', name: 'Farmer carry', movementPattern: 'carry', primaryMuscles: [], description: null },
  { id: 'c2', slug: 'db_press', name: 'Dumbbell press', movementPattern: 'horizontal_push', primaryMuscles: [], description: null },
];

export function mockGymDetail(overrides: Partial<GymDetail> = {}): GymDetail {
  return {
    id: nextId('a'),
    name: 'Home Gym',
    type: 'home',
    description: null,
    notes: null,
    latitude: null,
    longitude: null,
    isDefault: true,
    isTemporary: false,
    createdAt: NOW,
    updatedAt: NOW,
    equipment: [],
    photos: [],
    ...overrides,
  };
}

export function mockEquipment(type: EquipmentType, overrides: Partial<GymEquipment> = {}): GymEquipment {
  return {
    id: nextId('b'),
    gymId: 'gym',
    equipmentTypeId: type.id,
    equipmentType: {
      id: type.id,
      slug: type.slug,
      name: type.name,
      category: type.category,
      isCustom: type.isCustom,
      capabilities: type.capabilities,
    },
    quantity: 1,
    brand: null,
    model: null,
    notes: null,
    origin: 'manual',
    confidence: null,
    userVerified: true,
    originalAiValue: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function mockPhoto(overrides: Partial<GymPhoto> = {}): GymPhoto {
  return {
    id: nextId('c'),
    gymId: 'gym',
    storageObjectId: nextId('d'),
    caption: null,
    takenAt: null,
    createdAt: NOW,
    equipmentIds: [],
    ...overrides,
  };
}

export function toSummary(gym: GymDetail): GymSummary {
  const { equipment, photos, ...rest } = gym;
  return {
    ...rest,
    equipmentCount: equipment.length,
    photoCount: photos.length,
    coverPhotoId: photos[0]?.id ?? null,
    coverStorageObjectId: photos[0]?.storageObjectId ?? null,
  };
}

export interface GymsApiState {
  gyms: GymDetail[];
  types: EquipmentType[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

/** Install a stateful gyms API for one test. */
export function statefulGymsApi(initial: GymDetail[] = [], types: EquipmentType[] = CATALOG): GymsApiState {
  const state: GymsApiState = { gyms: initial.map((g) => ({ ...g })), types: [...types], calls: [] };
  const find = (id: string) => state.gyms.find((g) => g.id === id);
  const notFound = () =>
    HttpResponse.json({ statusCode: 404, message: 'Gym not found', error: 'Not Found' }, { status: 404 });
  const sorted = () =>
    [...state.gyms].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const record = async (request: Request, path: string) => {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      body = await request.clone().json().catch(() => undefined);
    }
    state.calls.push({ method: request.method, path, body });
    return body;
  };

  server.use(
    http.get(`${API}/gyms`, () => HttpResponse.json({ data: sorted().map(toSummary) })),
    http.post(`${API}/gyms`, async ({ request }) => {
      const body = (await record(request, '/gyms')) as Partial<GymDetail>;
      const gym = mockGymDetail({
        name: body.name,
        type: body.type,
        description: body.description ?? null,
        notes: body.notes ?? null,
        isTemporary: body.isTemporary ?? false,
        // E6.2: the first PERMANENT gym becomes the default; a temporary one never does.
        isDefault: !body.isTemporary && !state.gyms.some((g) => g.isDefault),
      });
      state.gyms.push(gym);
      return HttpResponse.json({ data: gym }, { status: 201 });
    }),
    http.get(`${API}/gyms/:id`, ({ params }) => {
      const gym = find(String(params.id));
      return gym ? HttpResponse.json({ data: gym }) : notFound();
    }),
    http.patch(`${API}/gyms/:id`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}`)) as Partial<GymDetail>;
      const gym = find(String(params.id));
      if (!gym) return notFound();
      Object.assign(gym, body);
      // E6.2: saving a temporary gym fills an empty default slot only.
      if (body.isTemporary === false && !state.gyms.some((g) => g.isDefault)) gym.isDefault = true;
      if (body.isTemporary === true) gym.isDefault = false;
      return HttpResponse.json({ data: gym });
    }),
    http.delete(`${API}/gyms/:id`, async ({ request, params }) => {
      await record(request, `/gyms/${params.id}`);
      const gym = find(String(params.id));
      if (!gym) return notFound();
      state.gyms = state.gyms.filter((g) => g !== gym);
      if (gym.isDefault && state.gyms[0]) state.gyms[0].isDefault = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.put(`${API}/gyms/:id/location`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}/location`)) as {
        latitude: number;
        longitude: number;
        accuracyMeters?: number;
      };
      const gym = find(String(params.id));
      if (!gym) return notFound();
      gym.latitude = Math.round(body.latitude * 1e5) / 1e5;
      gym.longitude = Math.round(body.longitude * 1e5) / 1e5;
      return HttpResponse.json({ data: { ...gym, accuracyMeters: body.accuracyMeters ?? null } });
    }),
    http.delete(`${API}/gyms/:id/location`, async ({ request, params }) => {
      await record(request, `/gyms/${params.id}/location`);
      const gym = find(String(params.id));
      if (!gym) return notFound();
      gym.latitude = null;
      gym.longitude = null;
      return HttpResponse.json({ data: gym });
    }),
    http.post(`${API}/gyms/:id/default`, async ({ request, params }) => {
      await record(request, `/gyms/${params.id}/default`);
      const gym = find(String(params.id));
      if (!gym) return notFound();
      if (gym.isTemporary) {
        return HttpResponse.json(
          {
            statusCode: 409,
            message: 'Save this gym before making it your default',
            error: 'Conflict',
            code: 'CONFLICT',
            details: { reason: 'TEMPORARY_GYM_NOT_DEFAULT' },
          },
          { status: 409 },
        );
      }
      for (const g of state.gyms) g.isDefault = g === gym;
      return HttpResponse.json({ data: gym });
    }),
    http.post(`${API}/gyms/:id/equipment`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}/equipment`)) as {
        equipmentTypeId: string;
        quantity?: number;
        brand?: string;
        model?: string;
      };
      const gym = find(String(params.id));
      const type = state.types.find((t) => t.id === body.equipmentTypeId);
      if (!gym || !type) return notFound();
      const row = mockEquipment(type, {
        gymId: gym.id,
        quantity: body.quantity ?? 1,
        brand: body.brand ?? null,
        model: body.model ?? null,
      });
      gym.equipment.push(row);
      return HttpResponse.json({ data: row }, { status: 201 });
    }),
    http.patch(`${API}/gyms/:id/equipment/:eid`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}/equipment/${params.eid}`)) as Partial<GymEquipment>;
      const row = find(String(params.id))?.equipment.find((e) => e.id === params.eid);
      if (!row) return notFound();
      Object.assign(row, body, { userVerified: true });
      return HttpResponse.json({ data: row });
    }),
    http.delete(`${API}/gyms/:id/equipment/:eid`, async ({ request, params }) => {
      await record(request, `/gyms/${params.id}/equipment/${params.eid}`);
      const gym = find(String(params.id));
      if (!gym) return notFound();
      gym.equipment = gym.equipment.filter((e) => e.id !== params.eid);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/gyms/:id/photos`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}/photos`)) as { storageObjectId: string };
      const gym = find(String(params.id));
      if (!gym) return notFound();
      const photo = mockPhoto({ gymId: gym.id, storageObjectId: body.storageObjectId });
      gym.photos.push(photo);
      return HttpResponse.json({ data: photo }, { status: 201 });
    }),
    http.patch(`${API}/gyms/:id/photos/:pid`, async ({ request, params }) => {
      const body = (await record(request, `/gyms/${params.id}/photos/${params.pid}`)) as Partial<GymPhoto>;
      const photo = find(String(params.id))?.photos.find((p) => p.id === params.pid);
      if (!photo) return notFound();
      Object.assign(photo, body);
      return HttpResponse.json({ data: photo });
    }),
    http.delete(`${API}/gyms/:id/photos/:pid`, async ({ request, params }) => {
      await record(request, `/gyms/${params.id}/photos/${params.pid}`);
      const gym = find(String(params.id));
      if (!gym) return notFound();
      gym.photos = gym.photos.filter((p) => p.id !== params.pid);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/equipment-types`, ({ request }) => {
      const url = new URL(request.url);
      const q = url.searchParams.get('q')?.toLowerCase();
      const category = url.searchParams.get('category');
      const data = state.types.filter(
        (t) =>
          (!q || t.name.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q))) &&
          (!category || t.category === category),
      );
      return HttpResponse.json({ data });
    }),
    http.post(`${API}/equipment-types`, async ({ request }) => {
      const body = (await record(request, '/equipment-types')) as { name: string; category: string };
      const type: EquipmentType = {
        id: nextId('f'),
        slug: 'custom-abcdefgh',
        name: body.name,
        category: body.category,
        aliases: [],
        description: null,
        isCustom: true,
        capabilities: [],
      };
      state.types.push(type);
      return HttpResponse.json({ data: type }, { status: 201 });
    }),
    http.get(`${API}/capabilities`, () => HttpResponse.json({ data: CAPABILITIES })),
  );
  return state;
}
