import { PERMISSIONS } from '../../common/constants/roles.constants';
import { AiConfigWriterLookup } from './ai-config-writer.lookup';

// =============================================================================
// AiConfigWriterLookup (issue #593) — resolver rule 2's permission half, read
// from user_roles -> roles -> role_permissions -> permissions.
// =============================================================================

describe('AiConfigWriterLookup', () => {
  function build(count: number) {
    const userRoleCount = jest.fn(async () => count);
    const lookup = new AiConfigWriterLookup({ userRole: { count: userRoleCount } } as never);

    return { lookup, userRoleCount };
  }

  it('asks for a role of THIS user that carries ai_config:write — one count query', async () => {
    const { lookup, userRoleCount } = build(1);

    await expect(lookup.holdsAiConfigWrite('user-42')).resolves.toBe(true);
    expect(userRoleCount).toHaveBeenCalledTimes(1);
    expect(userRoleCount).toHaveBeenCalledWith({
      where: {
        userId: 'user-42',
        role: { rolePermissions: { some: { permission: { name: 'ai_config:write' } } } },
      },
    });
    expect(PERMISSIONS.AI_CONFIG_WRITE).toBe('ai_config:write');
  });

  it('is false when no role grants it', async () => {
    const { lookup } = build(0);

    await expect(lookup.holdsAiConfigWrite('user-1')).resolves.toBe(false);
  });
});
