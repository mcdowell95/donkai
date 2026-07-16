.DEFAULT_GOAL := help

.PHONY: help setup start dev orchestrator dashboard typecheck

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies
	pnpm install

start: ## Start orchestrator + dashboard together
	@pnpm start

dev: ## Same as start, with auto-reload on file change
	@pnpm dev

orchestrator: ## Run orchestrator only
	@pnpm orchestrator

dashboard: ## Run dashboard only
	@pnpm dashboard

typecheck: ## Static type-check the project
	pnpm typecheck

smoke: ## Run API/MCP smoke test against a scratch DB
	SMOKE_DIR=$${TMPDIR:-/tmp}/donkai-smoke-$$$$ pnpm exec tsx scripts/smoke.mts

pwa: ## Build the PWA bundle
	pnpm --dir src/pwa install && pnpm --dir src/pwa build

docker: ## Build the Docker image
	docker build -t donkai:latest .
