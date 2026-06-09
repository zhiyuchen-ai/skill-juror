import os
import shlex

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

from .proxy_env import with_cleared_proxy_env


DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/"
DEFAULT_NODE_MIRROR = "https://nodejs.org/dist"


class ClaudeCodeCached(ClaudeCode):
    """
    Claude Code agent variant for Harbor runtime-capture runs.

    The adapter installs Claude Code through npm using the configured registry
    and keeps proxy settings out of the container unless explicitly supplied.
    """

    def __init__(self, *args, extra_env: dict[str, str] | None = None, **kwargs):
        super().__init__(
            *args,
            extra_env=with_cleared_proxy_env(extra_env),
            **kwargs,
        )

    async def install(self, environment: BaseEnvironment) -> None:
        check = await environment.exec(
            command='export PATH="$HOME/.local/bin:$PATH"; command -v claude >/dev/null 2>&1 && claude --version',
            env=with_cleared_proxy_env(),
        )
        if check.return_code == 0:
            if self._version is None and check.stdout:
                try:
                    self._version = self.parse_version(check.stdout)
                except Exception:
                    pass
            return

        registry = os.environ.get(
            "SKILL_JUROR_HARBOR_NPM_REGISTRY", DEFAULT_NPM_REGISTRY
        ).strip()
        if not registry:
            registry = DEFAULT_NPM_REGISTRY

        node_mirror = os.environ.get(
            "SKILL_JUROR_HARBOR_NODE_MIRROR", DEFAULT_NODE_MIRROR
        ).strip()
        if not node_mirror:
            node_mirror = DEFAULT_NODE_MIRROR

        await self.exec_as_root(
            environment,
            command=(
                "if command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache bash ca-certificates curl nodejs npm xz; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y ca-certificates curl nodejs npm xz-utils; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum_packages=\"ca-certificates nodejs npm xz\"; "
                "  if ! command -v curl >/dev/null 2>&1; then yum_packages=\"curl ${yum_packages}\"; fi; "
                "  yum install -y ${yum_packages} || yum install -y --allowerasing ${yum_packages}; "
                "else "
                '  echo "No supported package manager found for npm bootstrap." >&2; '
                "  exit 1; "
                "fi"
            ),
            env=with_cleared_proxy_env({"DEBIAN_FRONTEND": "noninteractive"}),
        )

        version_suffix = f"@{self._version}" if self._version else ""
        escaped_registry = shlex.quote(registry)
        escaped_node_mirror = shlex.quote(node_mirror)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"export NPM_CONFIG_REGISTRY={escaped_registry}; "
                "node_major=\"$(node -p 'process.versions.node.split(\".\")[0]')\"; "
                "if [ \"$node_major\" -lt 18 ]; then "
                "  npm install -g n@9.2.3; "
                f"  N_NODE_MIRROR={escaped_node_mirror} n 20; "
                "  hash -r; "
                "fi; "
                "node --version; "
                "npm --version; "
                "mkdir -p /opt/claude-code /usr/local/bin; "
                f"npm install -g --prefix /opt/claude-code @anthropic-ai/claude-code{version_suffix}; "
                "cat > /usr/local/bin/claude <<'EOF'\n"
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "exec /opt/claude-code/bin/claude \"$@\"\n"
                "EOF\n"
                "chmod +x /usr/local/bin/claude; "
                "claude --version"
            ),
            env=with_cleared_proxy_env(),
        )
