.PHONY: up down restart ps logs test lint build runners clean help

SHELL := /bin/bash
COMPOSE_FILE := deploy/compose/docker-compose.yml

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Start the full Docker Compose stack (redis, postgres, api, worker)
	docker compose -f $(COMPOSE_FILE) up -d --build

down: ## Stop and remove all containers and networks
	docker compose -f $(COMPOSE_FILE) down

restart: down up ## Restart the stack

ps: ## Check status of Docker Compose services
	docker compose -f $(COMPOSE_FILE) ps

logs: ## Tail logs for all services
	docker compose -f $(COMPOSE_FILE) logs -f

test: ## Run Go unit tests with race detection
	go test -v -race ./...

lint: ## Run golangci-lint
	golangci-lint run ./...

build: ## Build both api and worker binaries locally
	mkdir -p bin
	go build -o bin/api ./cmd/api
	go build -o bin/worker ./cmd/worker

runners: ## Build runner sandbox container images
	@./scripts/build-runners.sh

clean: ## Clean built artifacts and cache
	rm -rf bin/
