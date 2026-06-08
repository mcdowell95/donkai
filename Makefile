.DEFAULT_GOAL := help

.PHONY: help setup start dev orchestrator dashboard typecheck

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies
	pnpm install

start: ## Start orchestrator + dashboard together
	@set -a; . ./.env; set +a; pnpm start

dev: ## Same as start, with auto-reload on file change
	@set -a; . ./.env; set +a; pnpm dev

orchestrator: ## Run orchestrator only
	@set -a; . ./.env; set +a; pnpm orchestrator

dashboard: ## Run dashboard only
	@set -a; . ./.env; set +a; pnpm dashboard

typecheck: ## Static type-check the project
	pnpm typecheck
