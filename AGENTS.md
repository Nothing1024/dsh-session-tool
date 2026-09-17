# session-tool/plugin

This git repo's loopback DSH env is `env/` (profile `st`, port `3081`).

Machine-local shared catalog (not in this git repo):
- `~/workspace/dsh/plugin/.shared/settings.yaml` — `llm-pi-ai` / `agent-default-model`
- `~/workspace/dsh/plugin/.shared/plugins.yaml` — extra plugins keyed by warehouse path
- `~/workspace/dsh/plugin/.shared/.env` — API key (mode 600)

After changing the catalog: `sh ~/workspace/dsh/plugin/.shared/apply.sh --warehouse session-tool/plugin`
then restart `env/boot.sh` if extra plugin versions changed.

Do not hand-edit `env/settings.yaml` shared namespaces.
Do not vendor extra plugins into `packages/`.
Neighbor `link:` packages stay in this profile; apply does not touch them.
