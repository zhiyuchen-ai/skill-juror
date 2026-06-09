import os


PROXY_CLEAR_ENV = {
    "HTTP_PROXY": "",
    "HTTPS_PROXY": "",
    "ALL_PROXY": "",
    "http_proxy": "",
    "https_proxy": "",
    "all_proxy": "",
    "NO_PROXY": "*",
    "no_proxy": "*",
}


def with_cleared_proxy_env(env: dict[str, str] | None = None) -> dict[str, str]:
    merged = dict(PROXY_CLEAR_ENV)
    if env:
        merged.update(env)
    return merged


def with_configured_proxy_env(
    env: dict[str, str] | None = None,
    proxy_url: str | None = None,
) -> dict[str, str]:
    merged = with_cleared_proxy_env(env)
    resolved_proxy = (
        proxy_url
        or merged.get("SKILL_JUROR_CODEX_PROXY_URL")
        or merged.get("CODEX_PROXY_URL")
        or os.environ.get("SKILL_JUROR_CODEX_PROXY_URL")
        or os.environ.get("CODEX_PROXY_URL")
        or os.environ.get("SKILL_JUROR_HARBOR_CODEX_PROXY_URL")
        or ""
    ).strip()
    merged.pop("SKILL_JUROR_CODEX_PROXY_URL", None)
    merged.pop("CODEX_PROXY_URL", None)
    if not resolved_proxy:
        return merged

    no_proxy = (
        merged.get("CODEX_NO_PROXY")
        or os.environ.get("CODEX_NO_PROXY")
        or "localhost,127.0.0.1,::1"
    )
    merged.update(
        {
            "HTTP_PROXY": resolved_proxy,
            "HTTPS_PROXY": resolved_proxy,
            "ALL_PROXY": resolved_proxy,
            "http_proxy": resolved_proxy,
            "https_proxy": resolved_proxy,
            "all_proxy": resolved_proxy,
            "NO_PROXY": no_proxy,
            "no_proxy": no_proxy,
        }
    )
    return merged
