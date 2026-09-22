# praxis-runtime

The single Praxis Runtime Desktop Extension. Builds `praxis-runtime.mcpb`.

Quality HTTP worker (`apps/quality-service`) stays here. Role Skills are four independent repos and must not embed a second MCPB.

Jira credentials are Runtime `user_config`, not a separate Jira MCPB.

Core libraries are vendored at `vendor/*.tgz` pinned to `0.1.0-alpha.44`.
