import { SecureObsidianAPI, VaultSecurityManager, SecurityError } from '../src/security';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { createSemanticTools, isActionVisible, OPT_IN_ACTIONS } from '../src/tools/semantic-tools';
import { App } from 'obsidian';

// Mock Obsidian (mirrors read-only-mode.test.ts)
jest.mock('obsidian', () => ({
  normalizePath: jest.fn((p: string) => p.replace(/\\/g, '/'))
}));

/**
 * ADR-204: gated command-palette execution. Three independent gates —
 * enumeration (tool visibility), runtime permission (EXECUTE_COMMAND), and the
 * exact-ID allowlist — each default off/empty and each verified here.
 */
describe('Gated command execution (ADR-204)', () => {
  let executed: string[];
  let mockApp: App;

  const buildApp = (): App => {
    executed = [];
    return {
      vault: {
        adapter: { basePath: '/test/vault' },
        getName: () => 'test-vault'
      },
      commands: {
        commands: {
          'app:open-settings': { id: 'app:open-settings', name: 'Open settings' },
          'app:delete-file': { id: 'app:delete-file', name: 'Delete current file' }
        },
        executeCommandById: (id: string) => {
          executed.push(id);
          return true;
        }
      }
    } as unknown as App;
  };

  const pluginWith = (allowlist: string[]) => ({
    settings: { commandExecutionAllowlist: allowlist }
  });

  beforeEach(() => {
    mockApp = buildApp();
  });

  // --- Gate 3: the allowlist (base ObsidianAPI) ---

  describe('allowlist gate', () => {
    test('empty allowlist blocks every command (fail-closed)', async () => {
      const api = new ObsidianAPI(mockApp, undefined, pluginWith([]));

      const result = await api.executeCommand('app:open-settings');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(executed).toEqual([]); // never reached executeCommandById
    });

    test('populated allowlist allows only listed IDs', async () => {
      const api = new ObsidianAPI(mockApp, undefined, pluginWith(['app:open-settings']));

      const allowed = await api.executeCommand('app:open-settings');
      expect(allowed.success).toBe(true);
      expect(allowed.error).toBeUndefined();
      expect(executed).toEqual(['app:open-settings']);

      // A command NOT on the list is refused without executing, even though the
      // capability is otherwise on.
      const blocked = await api.executeCommand('app:delete-file');
      expect(blocked.success).toBe(false);
      expect(blocked.error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(executed).toEqual(['app:open-settings']); // unchanged — delete never ran
    });

    test('absent allowlist setting behaves as empty', async () => {
      const api = new ObsidianAPI(mockApp, undefined, { settings: {} });

      const result = await api.executeCommand('app:open-settings');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(executed).toEqual([]);
    });
  });

  // --- Gate 1: enumeration / tool visibility (independent of the allowlist) ---

  describe('enumeration gate', () => {
    const systemActions = (visibility?: Record<string, boolean>): string[] => {
      const tools = createSemanticTools(undefined, visibility);
      const system = tools.find(t => t.name === 'system');
      const enumProp = system?.inputSchema.properties.action as { enum?: string[] } | undefined;
      return enumProp?.enum ?? [];
    };

    test('system.execute is an opt-in action', () => {
      expect(OPT_IN_ACTIONS.has('system.execute')).toBe(true);
    });

    test('system.execute is hidden by default (no visibility map)', () => {
      expect(isActionVisible('system', 'execute')).toBe(false);
      expect(systemActions()).not.toContain('execute');
    });

    test('system.execute stays hidden with an empty visibility map', () => {
      expect(isActionVisible('system', 'execute', {})).toBe(false);
      expect(systemActions({})).not.toContain('execute');
    });

    test('visibility-off blocks enumeration regardless of allowlist state', () => {
      // Even with commands allowlisted, the action is not enumerated unless the
      // visibility gate is explicitly opened — the two gates are independent.
      const api = new ObsidianAPI(mockApp, undefined, pluginWith(['app:open-settings']));
      void api; // allowlist populated, but that has no bearing on enumeration
      expect(isActionVisible('system', 'execute', { 'system.execute': false })).toBe(false);
      expect(systemActions({ 'system.execute': false })).not.toContain('execute');
    });

    test('explicit true opts the action in', () => {
      expect(isActionVisible('system', 'execute', { 'system.execute': true })).toBe(true);
      expect(systemActions({ 'system.execute': true })).toContain('execute');
    });

    test('non-opt-in actions keep ADR-101 default-enabled behavior', () => {
      // A regular action is enabled unless explicitly false.
      expect(isActionVisible('system', 'info', {})).toBe(true);
      expect(isActionVisible('system', 'info', { 'system.info': false })).toBe(false);
    });
  });

  // --- Gate 2: runtime permission, integration through SecureObsidianAPI ---

  describe('runtime permission gate (SecureObsidianAPI integration)', () => {
    test('readOnly preset blocks command execution even with a populated allowlist', async () => {
      const secure = new SecureObsidianAPI(
        mockApp,
        undefined,
        pluginWith(['app:open-settings']),
        VaultSecurityManager.presets.readOnly()
      );

      await expect(secure.executeCommand('app:open-settings')).rejects.toThrow(SecurityError);
      expect(executed).toEqual([]); // permission gate stopped it before the allowlist gate
    });

    test('safeMode preset blocks command execution (allows openFile, not commands)', async () => {
      const secure = new SecureObsidianAPI(
        mockApp,
        undefined,
        pluginWith(['app:open-settings']),
        VaultSecurityManager.presets.safeMode()
      );

      await expect(secure.executeCommand('app:open-settings')).rejects.toThrow(SecurityError);
      expect(executed).toEqual([]);
    });

    test('fullAccess + allowlisted ID runs the command end-to-end', async () => {
      const secure = new SecureObsidianAPI(
        mockApp,
        undefined,
        pluginWith(['app:open-settings']),
        VaultSecurityManager.presets.fullAccess()
      );

      const result = await secure.executeCommand('app:open-settings');

      expect(result.success).toBe(true);
      expect(executed).toEqual(['app:open-settings']);
    });

    test('fullAccess but non-allowlisted ID is refused by the allowlist gate', async () => {
      const secure = new SecureObsidianAPI(
        mockApp,
        undefined,
        pluginWith(['app:open-settings']),
        VaultSecurityManager.presets.fullAccess()
      );

      // Permission gate passes; allowlist gate refuses without executing.
      const result = await secure.executeCommand('app:delete-file');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(executed).toEqual([]);
    });
  });

  // --- Preset shape ---

  test('presets carry the executeCommand permission (off except fullAccess)', () => {
    expect(VaultSecurityManager.presets.readOnly().permissions?.executeCommand).toBe(false);
    expect(VaultSecurityManager.presets.safeMode().permissions?.executeCommand).toBe(false);
    expect(VaultSecurityManager.presets.fullAccess().permissions?.executeCommand).toBe(true);
  });
});
