# Praxis one-line commands (macOS / BSD Make compatible)
SHELL := /bin/sh
PRAXIS := node tools/praxis.mjs
VERSION ?=
TEST_REPO ?=
EPIC ?=
WP ?=
REPO ?= .
CONFIRM ?=

.PHONY: setup verify release-local install-test demo-prepare jira-smoke jira-epic jira-status ba architect developer qa ba-preview ba-status ba-apply architect-preview architect-status developer-status qa-status quality-up quality-down quality-report demo-status demo-reset help

help:
	@echo "Praxis make targets — see docs/commands.md"
	@echo "  make ba EPIC=PRX-1 REPO=$(REPO)          # Claude BA"
	@echo "  make ba-preview EPIC=PRX-1 REPO=$(REPO)  # machine only"

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

jira-status:
	$(PRAXIS) jira-status --epic "$(EPIC)"

ba:
	$(PRAXIS) ba --epic "$(EPIC)" --repo "$(REPO)"

architect:
	$(PRAXIS) architect --epic "$(EPIC)" --repo "$(REPO)"

developer:
	$(PRAXIS) developer --wp "$(WP)" --repo "$(REPO)"

qa:
	$(PRAXIS) qa --wp "$(WP)" --repo "$(REPO)"

ba-preview:
	$(PRAXIS) ba-preview --epic "$(EPIC)" --repo "$(REPO)"

ba-status:
	$(PRAXIS) ba-status --epic "$(EPIC)"

ba-apply:
	$(PRAXIS) ba-apply --epic "$(EPIC)" --repo "$(REPO)" --confirm "$(CONFIRM)"

architect-preview:
	$(PRAXIS) architect-preview --epic "$(EPIC)" --repo "$(REPO)"

architect-status:
	$(PRAXIS) architect-status --epic "$(EPIC)"

developer-status:
	$(PRAXIS) developer-status --epic "$(EPIC)"

qa-status:
	$(PRAXIS) qa-status --epic "$(EPIC)"

quality-up:
	$(PRAXIS) quality-up

quality-down:
	$(PRAXIS) quality-down

quality-report:
	@echo "cat $(REPO)/.praxis-jira/quality/$(WP).md"

demo-status:
	$(PRAXIS) demo-status --epic "$(EPIC)"

demo-reset:
	$(PRAXIS) demo-reset
