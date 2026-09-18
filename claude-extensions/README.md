# Praxis Runtime

Install this Claude Desktop Extension once. Role plugins use its tools.

## Install (no terminal)

1. Claude Desktop → **Settings** → **Extensions** → **Advanced settings** → **Install extension**
2. Select `praxis-runtime.mcpb` from this folder
3. Configure:
   - Jira Base URL
   - Jira Email
   - Jira Project Key
   - Jira API Token (sensitive; stored in OS Keychain / Credential Manager)
4. Install the four role plugins from `claude-plugins/`
5. Open Cowork, select the product folder, invoke a Skill

Do not use `launchctl setenv`, `source .env`, or paste tokens into chat.

To update Jira later: **Settings → Extensions → Praxis Runtime → Settings**. No reinstall required.

Organization owners may upload this custom desktop extension where Team/Enterprise deployment is supported. Public directory publishing is not required.

Claude Desktop installation remains a manual check after each release.
