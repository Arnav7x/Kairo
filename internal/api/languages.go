package api

import (
	"encoding/json"
	"net/http"

	"github.com/Arnav7x/kairo/internal/languages"
)

// LanguagesHandler exposes the same data-driven registry used by workers.
// Keeping this at the registry boundary means a YAML entry is immediately
// discoverable without duplicating a route-level allowlist.
func LanguagesHandler(registry *languages.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"languages": registry.ListDetailed()})
	}
}
