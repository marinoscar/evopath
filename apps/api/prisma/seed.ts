import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
// The declarative half of this script. Split out (#256) so a Jest test can
// import it: this file instantiates a PrismaClient and calls `main()` at import
// time, so nothing can import IT to check the data. See seed-data.ts.
import {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  DEFAULT_SYSTEM_SETTINGS,
  CAPABILITY_CATALOG,
  EQUIPMENT_CATALOG,
  EXERCISE_CATALOG,
} from './seed-data';

// Prisma 7 requires a driver adapter — PrismaClient can no longer be
// instantiated with no options. The seed script is invoked as a standalone
// ts-node process (see prisma.config.ts: migrations.seed), not through
// Nest's DI container, so it can't reuse PrismaService's buildConnectionString()
// without also pulling in @nestjs/common. Every Prisma CLI invocation in this
// project (npm run prisma:*, or `npx prisma db seed` per the README) already
// guarantees DATABASE_URL is set before the CLI — and therefore this seed
// script — runs, either via scripts/prisma-env.js or an explicit export, so
// reading it directly here is sufficient and keeps the script framework-free.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run this script via `npm run prisma:seed` ' +
      '(or export DATABASE_URL) so Prisma can connect to the database.',
  );
}

const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

// =============================================================================
// Seed Functions
// =============================================================================

async function seedRoles() {
  console.log('Seeding roles...');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  console.log(`✓ Seeded ${ROLES.length} roles`);
}

async function seedPermissions() {
  console.log('Seeding permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: permission.name },
      update: { description: permission.description },
      create: permission,
    });
  }

  console.log(`✓ Seeded ${PERMISSIONS.length} permissions`);
}

async function seedRolePermissions() {
  console.log('Seeding role-permission mappings...');

  let count = 0;

  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) continue;

    for (const permissionName of permissionNames) {
      const permission = await prisma.permission.findUnique({
        where: { name: permissionName },
      });
      if (!permission) continue;

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
      count++;
    }
  }

  console.log(`✓ Seeded ${count} role-permission mappings`);
}

/**
 * Upsert the capability and seeded equipment catalogs by `slug` (E3.2).
 *
 * Idempotent: name, category, aliases, description and sortOrder are refreshed
 * and each equipment type's capability links are re-synced to the catalog.
 * Never deletes a row, and never touches a custom equipment type
 * (`ownerUserId != null`): a catalog slug only ever addresses the seeded row.
 * An unknown capability slug throws before any equipment is written.
 */
async function seedCatalogs() {
  console.log('Seeding capability and equipment catalogs...');

  const capabilityIds = new Map<string, string>();
  for (const cap of CAPABILITY_CATALOG) {
    const data = {
      name: cap.name,
      movementPattern: cap.movementPattern,
      primaryMuscles: cap.primaryMuscles,
      description: cap.description ?? null,
      sortOrder: cap.sortOrder,
    };
    const row = await prisma.capability.upsert({
      where: { slug: cap.slug },
      update: data,
      create: { slug: cap.slug, ...data },
      select: { id: true },
    });
    capabilityIds.set(cap.slug, row.id);
  }

  // Typo guard: resolve every reference before writing any equipment.
  for (const item of EQUIPMENT_CATALOG) {
    for (const slug of item.capabilities) {
      if (!capabilityIds.has(slug)) {
        throw new Error(
          `Equipment "${item.slug}" references unknown capability "${slug}"`,
        );
      }
    }
  }

  for (const item of EQUIPMENT_CATALOG) {
    const data = {
      name: item.name,
      category: item.category,
      aliases: item.aliases,
      description: item.description ?? null,
      sortOrder: item.sortOrder,
    };
    // `slug` is unique across custom and seeded rows; custom slugs are
    // 'custom-<random>' so they cannot collide with the catalog.
    const existing = await prisma.equipmentType.findUnique({
      where: { slug: item.slug },
      select: { id: true, ownerUserId: true },
    });
    if (existing && existing.ownerUserId !== null) {
      throw new Error(
        `Catalog slug "${item.slug}" is taken by a user-owned equipment type`,
      );
    }
    const row = await prisma.equipmentType.upsert({
      where: { slug: item.slug },
      update: data,
      create: { slug: item.slug, ...data },
      select: { id: true },
    });

    const wanted = item.capabilities.map((slug) => capabilityIds.get(slug)!);
    await prisma.equipmentTypeCapability.deleteMany({
      where: { equipmentTypeId: row.id, capabilityId: { notIn: wanted } },
    });
    await prisma.equipmentTypeCapability.createMany({
      data: wanted.map((capabilityId) => ({
        equipmentTypeId: row.id,
        capabilityId,
      })),
      skipDuplicates: true,
    });
  }

  console.log(
    `✓ Seeded ${CAPABILITY_CATALOG.length} capabilities and ${EQUIPMENT_CATALOG.length} equipment types`,
  );
}

/**
 * Upsert the seeded exercise library by `slug` (E4.1).
 *
 * Idempotent: fields are refreshed and each exercise's requirement rows are
 * re-synced (delete + insert, one transaction per exercise). Never touches a
 * user-owned exercise: a catalog slug that is taken by one throws. Every
 * requirement slug is resolved before anything is written (typo guard).
 */
async function seedExercises() {
  console.log('Seeding exercise library...');

  const equipment = await prisma.equipmentType.findMany({
    where: { ownerUserId: null },
    select: { id: true, slug: true },
  });
  const capabilities = await prisma.capability.findMany({
    select: { id: true, slug: true },
  });
  const equipmentIds = new Map(equipment.map((e) => [e.slug, e.id]));
  const capabilityIds = new Map(capabilities.map((c) => [c.slug, c.id]));

  for (const ex of EXERCISE_CATALOG) {
    for (const group of ex.requirements) {
      const known = group.kind === 'equipment' ? equipmentIds : capabilityIds;
      for (const slug of group.slugs) {
        if (!known.has(slug)) {
          throw new Error(
            `Exercise "${ex.slug}" references unknown ${group.kind} "${slug}"`,
          );
        }
      }
    }
  }

  for (const ex of EXERCISE_CATALOG) {
    const existing = await prisma.exercise.findUnique({
      where: { slug: ex.slug },
      select: { ownerUserId: true },
    });
    if (existing && existing.ownerUserId !== null) {
      throw new Error(
        `Catalog slug "${ex.slug}" is taken by a user-owned exercise`,
      );
    }
    const data = {
      name: ex.name,
      primaryMuscles: ex.primaryMuscles,
      secondaryMuscles: ex.secondaryMuscles,
      movementPattern: ex.movementPattern,
      trackingMode: ex.trackingMode,
      isUnilateral: ex.isUnilateral,
      isBodyweight: ex.isBodyweight,
      origin: 'seed',
      status: 'active',
    };
    await prisma.$transaction(async (tx) => {
      const row = await tx.exercise.upsert({
        where: { slug: ex.slug },
        update: data,
        create: { slug: ex.slug, ...data },
        select: { id: true },
      });
      await tx.exerciseRequirement.deleteMany({ where: { exerciseId: row.id } });
      const rows = ex.requirements.flatMap((group, groupIndex) =>
        group.slugs.map((slug) => ({
          exerciseId: row.id,
          groupIndex,
          equipmentTypeId:
            group.kind === 'equipment' ? equipmentIds.get(slug)! : null,
          capabilityId:
            group.kind === 'capability' ? capabilityIds.get(slug)! : null,
        })),
      );
      if (rows.length > 0) {
        await tx.exerciseRequirement.createMany({ data: rows });
      }
    });
  }

  console.log(`✓ Seeded ${EXERCISE_CATALOG.length} exercises`);
}

async function seedSystemSettings() {
  console.log('Seeding system settings...');

  await prisma.systemSettings.upsert({
    where: { key: 'global' },
    update: {}, // Don't overwrite existing settings
    create: {
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS,
      version: 1,
    },
  });

  console.log('✓ Seeded default system settings');
}

async function seedInitialAdminAllowlist() {
  console.log('Seeding initial admin allowlist...');

  const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL;
  if (initialAdminEmail) {
    await prisma.allowedEmail.upsert({
      where: { email: initialAdminEmail.toLowerCase() },
      update: {},
      create: {
        email: initialAdminEmail.toLowerCase(),
        notes: 'Initial admin (auto-seeded)',
      },
    });
    console.log(`✓ Added ${initialAdminEmail} to allowlist`);
  } else {
    console.log('⊘ INITIAL_ADMIN_EMAIL not set, skipping allowlist seed');
  }
}

// =============================================================================
// Main Seed Function
// =============================================================================

async function main() {
  console.log('Starting database seed...\n');

  await seedRoles();
  await seedPermissions();
  await seedRolePermissions();
  await seedCatalogs();
  await seedExercises();
  await seedSystemSettings();
  await seedInitialAdminAllowlist();

  console.log('\n✓ Database seeding completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
