# Praxis one-line commands (macOS / BSD Make compatible)
# Human UX is Claude UI + role plugins. Make is a thin wrapper over `praxis`.
SHELL := /bin/sh
PRAXIS := node tools/praxis.mjs
CLI := node packages/cli/dist/main.js
VERSION ?=
TEST_REPO ?=
EPIC ?=
WP ?=
REPO ?= .
CONFIRM ?=

.PHONY: setup verify release-local install-test demo-prepare jira-smoke jira-epic jira-status jira-discover ba architect developer qa ba-preview ba-status ba-apply architect-preview architect-apply architect-status developer-status qa-status quality-up quality-down quality-report quality-ensure demo-status demo-reset claude-plugins verify-claude-plugins verify-claude-hosted-plugins sync-claude-plugins claude-extension verify-claude-extension sync-claude-extension help

help:
	@echo "Praxis make targets — convenience wrappers over public CLI (see docs/cli and docs/claude-ui)"
	@echo "  Primary human UX: Claude UI role plugins, not Make."
	@echo "  make ba EPIC=PRX-1 REPO=$(REPO)          # Claude Code BA (fallback)"
	@echo "  praxis ba preview --epic PRX-1 --json    # machine / agent"

setup:
	$(PRAXIS) setup

verify:
	$(PRAXIS) verify

release-local:
	$(PRAXIS) release-local --version "$(VERSION)"

install-test:
	$(PRAXIS) install-test --version "$(VERSION)" --repo "$(TEST_REPO)"

demo-prepare: release-local install-test
	@echo "baseline: npm --prefix $(TEST_REPO) test || true"

jira-smoke:
	$(CLI) jira smoke

jira-discover:
	$(CLI) jira discover

jira-epic:
	$(CLI) jira epic --epic "$(EPIC)"

jira-status:
	$(CLI) jira status --epic "$(EPIC)"

ba:
	$(PRAXIS) ba --epic "$(EPIC)" --repo "$(REPO)"

architect:
	$(PRAXIS) architect --epic "$(EPIC)" --repo "$(REPO)"

developer:
	$(PRAXIS) developer --wp "$(WP)" --repo "$(REPO)"

qa:
	$(PRAXIS) qa --wp "$(WP)" --repo "$(REPO)"

ba-preview:
	$(CLI) ba preview --epic "$(EPIC)" --repo "$(REPO)"

ba-status:
	$(CLI) ba status --epic "$(EPIC)"

ba-apply:
	$(CLI) ba apply --epic "$(EPIC)" --repo "$(REPO)" --confirm "$(CONFIRM)"

architect-preview:
	$(CLI) architect preview --epic "$(EPIC)" --repo "$(REPO)"

architect-apply:
	$(CLI) architect apply --epic "$(EPIC)" --repo "$(REPO)" --confirm "$(CONFIRM)"

architect-status:
	$(CLI) architect status --epic "$(EPIC)"

developer-status:
	$(CLI) developer status --wp "$(WP)" --repo "$(REPO)"

qa-status:
	$(CLI) quality status

quality-up:
	$(PRAXIS) quality-up

quality-down:
	$(PRAXIS) quality-down

quality-ensure:
	$(CLI) quality ensure --json

quality-report:
	$(CLI) quality report --wp "$(WP)" --repo "$(REPO)" --json

demo-status:
	$(CLI) jira status --epic "$(EPIC)"

demo-reset:
	$(PRAXIS) demo-reset

claude-plugins:
	node tools/scripts/pack-claude-plugins.mjs --version "$(VERSION)"

verify-claude-plugins:
	node tools/scripts/verify-claude-plugins.mjs --version "$(VERSION)"

verify-claude-hosted-plugins:
	node tools/scripts/claude-hosted-plugins-acceptance.mjs

sync-claude-plugins:
	node tools/scripts/sync-claude-plugins.mjs --version "$(VERSION)"

claude-extension:
	node tools/scripts/pack-claude-extension.mjs --version "$(VERSION)"

verify-claude-extension:
	node tools/scripts/verify-claude-extension.mjs --version "$(VERSION)"

sync-claude-extension:
	node tools/scripts/sync-claude-extension.mjs --version "$(VERSION)"
