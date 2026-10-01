import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { androidStudioSdkDir, cmdlineToolsUrl, resolveSdk, sdkCandidates, sdkLayout } from './sdk.js';

const HOME = '/home/u';

describe('SDK location', () => {
  it('orders ANDROID_HOME, ANDROID_SDK_ROOT, managed, Android Studio', () => {
    const candidates = sdkCandidates({
      env: { ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b' },
      home: HOME,
      platform: 'linux',
      exists: () => false,
    });
    expect(candidates.map((c) => c.source)).toEqual(['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'managed', 'android-studio']);
    expect(candidates[2]?.root).toBe(join(HOME, '.evopathcli', 'android-sdk'));
  });

  it('picks the first existing candidate', () => {
    const managed = join(HOME, '.evopathcli', 'android-sdk');
    const sdk = resolveSdk({ env: { ANDROID_HOME: '/missing' }, home: HOME, platform: 'linux', exists: (p) => p === managed });
    expect(sdk).toEqual({ root: managed, source: 'managed', exists: true });
  });

  it('falls back to ANDROID_HOME as the install target when nothing exists', () => {
    const sdk = resolveSdk({ env: { ANDROID_HOME: '/want/here' }, home: HOME, platform: 'linux', exists: () => false });
    expect(sdk).toEqual({ root: '/want/here', source: 'ANDROID_HOME', exists: false });
  });

  it('falls back to the managed directory without any env', () => {
    const sdk = resolveSdk({ env: {}, home: HOME, platform: 'darwin', exists: () => false });
    expect(sdk.source).toBe('managed');
    expect(sdk.exists).toBe(false);
  });

  it('knows Android Studio defaults per OS', () => {
    expect(androidStudioSdkDir('linux', HOME, {})).toBe(join(HOME, 'Android', 'Sdk'));
    expect(androidStudioSdkDir('darwin', HOME, {})).toBe(join(HOME, 'Library', 'Android', 'sdk'));
    expect(androidStudioSdkDir('win32', HOME, { LOCALAPPDATA: 'C:\\L' })).toBe(join('C:\\L', 'Android', 'Sdk'));
  });
});

describe('SDK layout', () => {
  it('uses .bat scripts on Windows', () => {
    expect(sdkLayout('/s', 'win32').sdkmanager).toBe(join('/s', 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'));
    expect(sdkLayout('/s', 'win32').apksigner).toBe(join('/s', 'build-tools', '36.0.0', 'apksigner.bat'));
    expect(sdkLayout('/s', 'linux').sdkmanager).toBe(join('/s', 'cmdline-tools', 'latest', 'bin', 'sdkmanager'));
  });

  it('downloads the right cmdline-tools zip per OS', () => {
    expect(cmdlineToolsUrl('linux')).toBe('https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip');
    expect(cmdlineToolsUrl('darwin')).toContain('commandlinetools-mac-');
    expect(cmdlineToolsUrl('win32')).toContain('commandlinetools-win-');
  });
});
