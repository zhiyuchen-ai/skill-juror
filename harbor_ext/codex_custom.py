import json
import os
import shlex

from harbor.agents.installed.codex import Codex
from harbor.agents.installed.base import with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from .proxy_env import with_cleared_proxy_env, with_configured_proxy_env


DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/"


class CodexCustom(Codex):
    """
    Codex agent variant for Skill Juror Harbor runs.

    Harbor upstream does not synthesize Codex config.toml from the project
    runtime config. This agent consumes explicit Harbor environment settings
    and writes config.toml into CODEX_HOME before executing `codex exec`.
    """

    def __init__(self, *args, extra_env: dict[str, str] | None = None, **kwargs):
        self._skill_juror_proxy_url = self._resolve_proxy_url(extra_env)
        super().__init__(
            *args,
            extra_env=with_configured_proxy_env(extra_env),
            **kwargs,
        )

    @staticmethod
    def _resolve_proxy_url(extra_env: dict[str, str] | None) -> str | None:
        candidates = [
            extra_env.get("SKILL_JUROR_CODEX_PROXY_URL") if extra_env else None,
            extra_env.get("CODEX_PROXY_URL") if extra_env else None,
            os.environ.get("SKILL_JUROR_CODEX_PROXY_URL"),
            os.environ.get("CODEX_PROXY_URL"),
            os.environ.get("SKILL_JUROR_HARBOR_CODEX_PROXY_URL"),
        ]
        for candidate in candidates:
            if candidate is not None and candidate.strip():
                return candidate.strip()
        return None

    async def install(self, environment: BaseEnvironment) -> None:
        check = await environment.exec(
            command='export PATH="$HOME/.local/bin:$PATH"; command -v codex >/dev/null 2>&1 && codex --version',
            env=with_cleared_proxy_env(),
        )
        if check.return_code == 0:
            return

        registry = os.environ.get(
            "SKILL_JUROR_HARBOR_NPM_REGISTRY", DEFAULT_NPM_REGISTRY
        ).strip()
        if not registry:
            registry = DEFAULT_NPM_REGISTRY

        await self.exec_as_root(
            environment,
            command=(
                "if command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache bash ca-certificates curl nodejs npm ripgrep; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y ca-certificates curl nodejs npm ripgrep; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y ca-certificates curl nodejs npm ripgrep; "
                "else "
                '  echo "No supported package manager found for npm bootstrap." >&2; '
                "  exit 1; "
                "fi"
            ),
            env=with_cleared_proxy_env({"DEBIAN_FRONTEND": "noninteractive"}),
        )

        escaped_registry = shlex.quote(registry)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                f"export NPM_CONFIG_REGISTRY={escaped_registry}; "
                "mkdir -p /opt/codex /usr/local/bin; "
                "npm install -g --prefix /opt/codex @openai/codex@latest; "
                "cat > /usr/local/bin/codex <<'EOF'\n"
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "exec /opt/codex/bin/codex \"$@\"\n"
                "EOF\n"
                "chmod +x /usr/local/bin/codex; "
                "codex --version"
            ),
            env=with_cleared_proxy_env(),
        )

    def _load_config_data(self) -> dict:
        raw_json = self._get_env("SKILL_JUROR_CODEX_CONFIG_JSON")
        if raw_json:
            data = json.loads(raw_json)
            if not isinstance(data, dict):
                raise ValueError("SKILL_JUROR_CODEX_CONFIG_JSON must encode an object.")
            return data

        return {}

    def _build_config_toml(self) -> str:
        data = self._load_config_data()
        base_url_override = self._get_env("CODEX_PROVIDER_BASE_URL")
        model_override = self.model_name
        reasoning_effort = self._resolved_flags.get("reasoning_effort", "high")

        if model_override:
            data["model"] = model_override
        data["model_provider"] = data.get("model_provider") or "custom"
        data["model_reasoning_effort"] = data.get("model_reasoning_effort") or reasoning_effort
        data["approval_policy"] = data.get("approval_policy") or "never"
        data["sandbox_mode"] = data.get("sandbox_mode") or "danger-full-access"

        providers = data.get("model_providers")
        if not isinstance(providers, dict):
            providers = {}
            data["model_providers"] = providers

        provider_key = str(data["model_provider"])
        custom = providers.get(provider_key)
        if not isinstance(custom, dict):
            custom = {}
            providers[provider_key] = custom

        custom["name"] = custom.get("name") or "OpenAI"
        custom["wire_api"] = custom.get("wire_api") or "responses"
        custom["requires_openai_auth"] = True

        if base_url_override:
            custom["base_url"] = base_url_override

        if "base_url" not in custom or not str(custom["base_url"]).strip():
            env_base_url = self._get_env("OPENAI_BASE_URL")
            if env_base_url:
                custom["base_url"] = env_base_url

        lines: list[str] = []
        for key in (
            "model",
            "model_provider",
            "model_reasoning_effort",
            "approval_policy",
            "sandbox_mode",
        ):
            if key in data:
                lines.append(f'{key} = {json.dumps(data[key])}')
        lines.append("")
        lines.append(f"[model_providers.{provider_key}]")
        for key in ("name", "wire_api", "requires_openai_auth", "base_url"):
            if key in custom:
                lines.append(f'{key} = {json.dumps(custom[key])}')
        lines.append("")
        return "\n".join(lines)

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        self._extra_env = with_configured_proxy_env(
            self._extra_env,
            self._skill_juror_proxy_url
            or self._get_env("SKILL_JUROR_CODEX_PROXY_URL")
            or self._get_env("CODEX_PROXY_URL"),
        )
        config_toml = self._build_config_toml()

        env = {
            "CODEX_HOME": EnvironmentPaths.agent_dir.as_posix(),
        }
        env = with_configured_proxy_env(
            env,
            self._skill_juror_proxy_url
            or self._get_env("SKILL_JUROR_CODEX_PROXY_URL")
            or self._get_env("CODEX_PROXY_URL"),
        )
        env["OPENAI_API_KEY"] = self._get_env("OPENAI_API_KEY") or ""

        config_target = (EnvironmentPaths.agent_dir / "config.toml").as_posix()
        setup_parts = [
            f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}",
            f"cat > {shlex.quote(config_target)} <<'EOF'\n{config_toml}\nEOF",
            "umask 077",
            'cat >"$CODEX_HOME/auth.json" <<EOF\n'
            '{\n  "OPENAI_API_KEY": "${OPENAI_API_KEY}"\n}\nEOF',
            'chmod 600 "$CODEX_HOME/auth.json"',
        ]

        skills_command = self._build_register_skills_command()
        if skills_command:
            setup_parts.append(skills_command)

        mcp_command = self._build_register_mcp_servers_command()
        if mcp_command:
            setup_parts.append(mcp_command)

        await self.exec_as_agent(
            environment,
            command="\n".join(setup_parts),
            env=env,
        )

        await super().run(instruction, environment, context)
