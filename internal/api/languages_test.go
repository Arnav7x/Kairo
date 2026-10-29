package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Arnav7x/kairo/internal/languages"
)

func TestLanguagesHandlerUsesRegistry(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/languages", nil)
	res := httptest.NewRecorder()
	LanguagesHandler(languages.NewRegistry()).ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d", res.Code)
	}
	if got := res.Body.String(); !(strings.Contains(got, `"id":"node"`) && strings.Contains(got, `"id":"java"`)) {
		t.Fatalf("response does not contain registry entries: %s", got)
	}
}
