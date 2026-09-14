# Praxis one-line commands (macOS / BSD Make compatible)
# Load optional local secrets without printing them:
#   make ba EPIC=PRX-1 REPO=.
SHELL := /bin/sh
PRAXIS := node tools/praxis.mjs
VERSION ?=
TEST_REPO ?=
EPIC ?=
WP ?=
REPO ?= .
CONFIRM ?=

.PHONY: setup verify release-local install-test demo-prepare jira-smoke jira-epic ba architect developer quality-up quality-down qa quality-report jira-preview-write jira-workflow-preview jira-workflow-live demo-status demo-reset help

help:
	@echo "Praxis make targets — see docs/commands.md"
	@echo "  make setup"
	@echo "  make verify"
	@echo "  make release-local VERSION=$(VERSION)"
	@echo "  make jira-smoke"
	@echo "  make ba EPIC=PRX-1 REPO=$(REPO)"

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
	$(PRAXIS) jira-smoke

jira-epic:
	$(PRAXIS) jira-epic --epic "$(EPIC)"

jira-workflow-preview:
	$(PRAXIS) jira-workflow-preview --epic "$(EPIC)" --repo "$(REPO)"

jira-preview-write: jira-workflow-preview

jira-workflow-live:
	$(PRAXIS) jira-workflow-live --epic "$(EPIC)" --confirm "$(CONFIRM)"

ba:
	@echo "Start Claude Code in $(REPO) with praxis-ba enabled, then:"
	@echo "  Analyze Jira Epic $(EPIC) using skill session-start then the BA Jira flow."
	@echo "Machine dry-run:"
	@$(PRAXIS) jira-workflow-preview --epic "$(EPIC)" --repo "$(REPO)"

architect:
	@echo "Start Claude Code in $(REPO) with praxis-architect enabled for Epic $(EPIC)."
	@$(PRAXIS) jira-workflow-preview --epic "$(EPIC)" --repo "$(REPO)"

developer:
	@echo "Start Claude Code in $(REPO) with praxis-developer enabled for Work Package $(WP)."
	@echo "Claim (needs live Jira env): node -e \"console.log('see docs/workflows/jira-developer.md')\""

quality-up:
	$(PRAXIS) quality-up

quality-down:
	$(PRAXIS) quality-down

qa:
	@echo "Start Claude Code in $(REPO) with praxis-quality enabled for WP $(WP)."
	@echo "Or: node plugins/quality/tools/qa-verify.mjs --wp $(WP) --repo $(REPO)"

quality-report:
	@echo "cat $(REPO)/.praxis-jira/quality/$(WP).md"

demo-status:
	$(PRAXIS) demo-status --epic "$(EPIC)"

demo-reset:
	$(PRAXIS) demo-reset
