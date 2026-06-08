const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
];

const NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

const TOOLING_ENV_KEYS = [
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "PYTHONPATH",
  "SSH_AUTH_SOCK",
  "PIP_INDEX_URL",
  "PIP_TRUSTED_HOST",
  "UV_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "UV_INSECURE_HOST",
  "UV_PYTHON",
];

const TOOLING_ENV_PREFIXES = [
  "npm_config_",
  "NPM_CONFIG_",
];

export interface ControlledEnvOptions {
  includeNetwork?: boolean;
  includeTooling?: boolean;
  extraKeys?: string[];
}

export function createControlledEnv(
  overrides: Record<string, string | undefined> = {},
  options: ControlledEnvOptions = {},
): Record<string, string> {
  const allowedKeys = new Set([
    ...BASE_ENV_KEYS,
    ...(options.includeNetwork === true ? NETWORK_ENV_KEYS : []),
    ...(options.includeTooling === true ? TOOLING_ENV_KEYS : []),
    ...(options.extraKeys ?? []),
  ]);
  const env: Record<string, string> = {};

  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (value == null) {
      continue;
    }
    if (allowedKeys.has(key) || (options.includeTooling === true && TOOLING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}
