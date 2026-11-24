PYTHON ?= python3
MUSIC_PORT ?= 8099
#MUSIC_BIND ?= 127.0.0.1
MUSIC_BIND ?= 0.0.0.0
BASE_URL ?= http://127.0.0.1:$(MUSIC_PORT)
export PYTHON MUSIC_PORT MUSIC_BIND BASE_URL

.PHONY: build check up down logs shell test

build: ## Regenerate site/playlist.json from data/
	$(PYTHON) tools/build_playlist.py

check: ## Fail if site/playlist.json is stale
	$(PYTHON) tools/build_playlist.py --check

up: build ## Regenerate the manifest, then start the static server
	docker compose up -d

down: ## Stop the static server
	docker compose down

logs: ## Follow server logs
	docker compose logs -f

shell: ## Shell inside the server container
	docker compose exec web sh

test: ## Build check + HTTP range and header checks against a running server
	$(PYTHON) tools/build_playlist.py --check
	./tools/smoke_test.sh
