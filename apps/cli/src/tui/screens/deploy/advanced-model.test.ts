import { describe, expect, it } from 'vitest';

import { DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT } from '../../../commands/deploy.js';
import { DEFAULT_PROXY_CONTAINER } from '../../../deploy/proxy.js';
import {
  ADVANCED_KEYS,
  advancedDefaults,
  advancedFields,
  advancedFromAnswers,
  advancedSummary,
  advancedValues,
  proxyOverrides,
  validateAbsolutePath,
  validateContainerName,
  validateProxyModeChoice,
} from './advanced-model.js';
import { VALUE_FLAGS } from './flags-model.js';

// =============================================================================
// The Advanced step  (issue #393)
// =============================================================================
//
// Root, proxy root, port, proxy container and proxy mode: prefilled from the
// record, skippable with one Enter, validated with the CLI's own validators.
// =============================================================================

const RECORDED = {
  proxyRoot: '/srv/proxy',
  bindPort: 3536,
  proxyMode: 'host' as const,
  proxyContainer: 'edge',
};

describe('advancedDefaults', () => {
  it('prefills from the record, so Enter keeps what the deployment runs on', () => {
    // ⚠ The defect this prevents: a deployment on 3536, re-installed through a
    // form that offered 3535, moved to a port nothing forwards to.
    expect(advancedDefaults('/opt/apps', 'shop', RECORDED)).toEqual({
      deployRoot: '/opt/apps/shop',
      proxyRoot: '/srv/proxy',
      bindPort: 3536,
      proxyContainer: 'edge',
      proxyMode: 'host',
    });
  });

  it("falls back to the subcommand's own defaults when nothing is recorded", () => {
    expect(advancedDefaults('/opt/apps', 'shop', undefined)).toEqual({
      deployRoot: '/opt/apps/shop',
      proxyRoot: DEFAULT_PROXY_ROOT,
      bindPort: DEFAULT_BIND_PORT,
      proxyContainer: DEFAULT_PROXY_CONTAINER,
      proxyMode: 'auto',
    });
  });
});

describe('skipping the step', () => {
  it('an untouched form yields exactly the defaults', () => {
    // FieldWizard stores the placeholder for an empty submission, so "Change
    // them…" followed by Enter through every field must change nothing.
    const defaults = advancedDefaults('/opt/apps', 'shop', RECORDED);
    const answers = new Map(
      advancedFields('install', defaults, RECORDED).map((field) => [field.key, field.placeholder]),
    );
    expect(advancedFromAnswers(defaults, answers)).toEqual(defaults);
  });

  it('and passes no proxy override, so the run resolves exactly as the CLI would', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', RECORDED);
    expect(proxyOverrides(defaults, RECORDED)).toEqual({});
    expect(proxyOverrides(advancedDefaults('/opt/apps', 'shop', undefined), undefined)).toEqual({});
  });
});

describe('advancedFields', () => {
  it('asks update only what update declares: no proxy root, no port', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', undefined);
    expect(advancedFields('update', defaults, undefined).map((field) => field.key)).toEqual([
      '__root',
      '__proxyContainer',
      '__proxyMode',
    ]);
  });

  it('every field it asks is a value flag the same screen declares', () => {
    // One list for "what the screen asks" and "what the re-run command
    // prints" -- a field with no flag could never be repeated from a shell.
    for (const action of ['doctor', 'install', 'update'] as const) {
      const fields = advancedFields(action, advancedDefaults('/a', 'b', undefined), undefined);
      const declared = new Set(VALUE_FLAGS[action].map((flag) => flag.field));
      expect(fields.map((field) => field.key).filter((key) => !declared.has(key))).toEqual([]);
      expect(fields).toHaveLength(ADVANCED_KEYS[action].length);
    }
  });

  it('marks a field prefilled only when the record supplied it', () => {
    const fields = advancedFields('install', advancedDefaults('/a', 'b', { bindPort: 4000 }), {
      bindPort: 4000,
    });
    const prefilled = fields.filter((field) => field.prefilled).map((field) => field.key);
    expect(prefilled).toEqual(['__port']);
  });

  it('is never secret: these are the facts a review exists to show', () => {
    const fields = advancedFields('install', advancedDefaults('/a', 'b', undefined), undefined);
    expect(fields.every((field) => !field.secret)).toBe(true);
  });
});

describe('validation, using the CLI’s own validators', () => {
  const fields = advancedFields('install', advancedDefaults('/a', 'b', undefined), undefined);
  const validate = (key: string, value: string): string | undefined =>
    fields.find((field) => field.key === key)?.validate?.(value);

  it('port: 1..65535 only', () => {
    expect(validate('__port', '3536')).toBeUndefined();
    expect(validate('__port', '0')).toBeDefined();
    expect(validate('__port', '70000')).toBeDefined();
    expect(validate('__port', 'http')).toBeDefined();
  });

  it('container: docker’s grammar, and never a leading dash that argv would read as a flag', () => {
    expect(validateContainerName('proxy-nginx')).toBeUndefined();
    expect(validateContainerName('-rm')).toBeDefined();
    expect(validateContainerName('has space')).toBeDefined();
    expect(validate('__proxyContainer', '--privileged')).toBeDefined();
  });

  it('mode: auto, container or host', () => {
    expect(validateProxyModeChoice('auto')).toBeUndefined();
    expect(validateProxyModeChoice('container')).toBeUndefined();
    expect(validateProxyModeChoice('host')).toBeUndefined();
    expect(validateProxyModeChoice('docker')).toBeDefined();
  });

  it('roots: absolute paths only', () => {
    expect(validateAbsolutePath('/opt/apps/shop')).toBeUndefined();
    expect(validateAbsolutePath('apps/shop')).toBeDefined();
    expect(validate('__root', 'relative')).toBeDefined();
    expect(validate('__proxyRoot', '../proxy')).toBeDefined();
  });
});

describe('advancedFromAnswers', () => {
  const defaults = advancedDefaults('/opt/apps', 'shop', undefined);

  it('reads what was changed', () => {
    const settings = advancedFromAnswers(
      defaults,
      new Map([
        ['__root', '/srv/shop'],
        ['__port', '3600'],
        ['__proxyContainer', 'edge'],
        ['__proxyMode', 'host'],
      ]),
    );
    expect(settings).toEqual({
      deployRoot: '/srv/shop',
      proxyRoot: DEFAULT_PROXY_ROOT,
      bindPort: 3600,
      proxyContainer: 'edge',
      proxyMode: 'host',
    });
  });

  it('never lets an invalid value through to a path or an argv', () => {
    const settings = advancedFromAnswers(
      defaults,
      new Map([
        ['__root', 'relative'],
        ['__port', 'x'],
        ['__proxyContainer', '-x'],
        ['__proxyMode', 'docker'],
      ]),
    );
    expect(settings).toEqual(defaults);
  });
});

describe('proxyOverrides', () => {
  it('passes a mode or container only when it differs from the record', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', RECORDED);
    expect(proxyOverrides({ ...defaults, proxyMode: 'container' }, RECORDED)).toEqual({
      proxyMode: 'container',
    });
    expect(proxyOverrides({ ...defaults, proxyContainer: 'other' }, RECORDED)).toEqual({
      proxyContainer: 'other',
    });
  });

  it('treats `auto` as "no flag", which lets a recorded mode stand', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', RECORDED);
    expect(proxyOverrides({ ...defaults, proxyMode: 'auto' }, RECORDED)).toEqual({});
  });

  it('with no record, a non-default container is an override', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', undefined);
    expect(proxyOverrides({ ...defaults, proxyContainer: 'edge' }, undefined)).toEqual({
      proxyContainer: 'edge',
    });
  });
});

describe('advancedValues and advancedSummary', () => {
  it('always show where the run acts; the proxy fields only when overridden', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', undefined);
    expect([...advancedValues('install', defaults, undefined)]).toEqual([
      ['__root', '/opt/apps/shop'],
      ['__proxyRoot', DEFAULT_PROXY_ROOT],
      ['__port', String(DEFAULT_BIND_PORT)],
    ]);
    expect([
      ...advancedValues('update', { ...defaults, proxyMode: 'host' }, undefined),
    ]).toEqual([
      ['__root', '/opt/apps/shop'],
      ['__proxyMode', 'host'],
    ]);
  });

  it('summarises one row per setting the action asks', () => {
    const defaults = advancedDefaults('/opt/apps', 'shop', undefined);
    expect(advancedSummary('update', defaults).map((row) => row.label)).toEqual([
      'root',
      'container',
      'mode',
    ]);
    expect(advancedSummary('install', defaults)).toHaveLength(5);
  });
});
