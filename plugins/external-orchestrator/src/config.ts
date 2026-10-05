import os from 'node:os';
import path from 'node:path';

export const CONTROL_API_PROTOCOL = 1;
export const USER_DATA_OVERRIDE_ENV = 'CHAT_ON_STEROIDS_USER_DATA_DIR';

export interface ExternalOrchestratorConfig {
  userDataDir: string;
  endpointFile: string;
  tokenFile: string;
  supportedControlApiProtocols: readonly number[];
}

function defaultUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return path.join(appData || path.join(home, 'AppData', 'Roaming'), 'chat-on-steroids');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'chat-on-steroids');
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(home, '.config'), 'chat-on-steroids');
}

export function loadExternalOrchestratorConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): ExternalOrchestratorConfig {
  const override = env[USER_DATA_OVERRIDE_ENV]?.trim();
  const userDataDir = path.resolve(override || defaultUserDataDir(platform, env, home));
  const controlApiDir = path.join(userDataDir, 'control-api');
  return Object.freeze({
    userDataDir,
    endpointFile: path.join(controlApiDir, 'endpoint.json'),
    tokenFile: path.join(controlApiDir, 'token'),
    supportedControlApiProtocols: Object.freeze([CONTROL_API_PROTOCOL]),
  });
}
