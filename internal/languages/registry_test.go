package languages

import (
	"testing"
)

func TestRegistryDefaultLanguages(t *testing.T) {
	r := NewRegistry()

	expectedLanguages := []string{"python", "node", "bash", "c", "cpp", "go", "rust", "java"}
	for _, lang := range expectedLanguages {
		cfg, err := r.Get(lang)
		if err != nil {
			t.Errorf("expected %q to be registered, got error: %v", lang, err)
			continue
		}
		if cfg.ID != lang {
			t.Errorf("expected ID %q, got %q", lang, cfg.ID)
		}
		if cfg.Filename == "" {
			t.Errorf("expected non-empty filename for %s", lang)
		}
		if len(cfg.RunCmd) == 0 {
			t.Errorf("expected non-empty RunCmd for %s", lang)
		}
	}
}

func TestRegistryAliases(t *testing.T) {
	r := NewRegistry()

	aliasMap := map[string]string{
		"py":         "python",
		"PYTHON":     "python",
		"nodejs":     "node",
		"javascript": "node",
		"js":         "node",
		"sh":         "bash",
		"shell":      "bash",
		"c++":        "cpp",
		"CPP":        "cpp",
		"golang":     "go",
	}

	for alias, expectedID := range aliasMap {
		cfg, err := r.Get(alias)
		if err != nil {
			t.Errorf("expected alias %q to resolve, got error: %v", alias, err)
			continue
		}
		if cfg.ID != expectedID {
			t.Errorf("expected alias %q to resolve to %q, got %q", alias, expectedID, cfg.ID)
		}
	}
}

func TestRegistryCompiledLanguages(t *testing.T) {
	r := NewRegistry()

	compiled := []string{"c", "cpp", "go", "rust", "java"}
	for _, lang := range compiled {
		cfg, err := r.Get(lang)
		if err != nil {
			t.Fatalf("get %s: %v", lang, err)
		}
		if !cfg.Compiled {
			t.Errorf("expected %s to be compiled=true", lang)
		}
		if len(cfg.CompileCmd) == 0 {
			t.Errorf("expected %s to have CompileCmd", lang)
		}
		if cfg.CompileLimits == nil {
			t.Errorf("expected %s to have CompileLimits configured", lang)
		}
	}

	interpreted := []string{"python", "node", "bash"}
	for _, lang := range interpreted {
		cfg, err := r.Get(lang)
		if err != nil {
			t.Fatalf("get %s: %v", lang, err)
		}
		if cfg.Compiled {
			t.Errorf("expected %s to be compiled=false", lang)
		}
		if len(cfg.CompileCmd) != 0 {
			t.Errorf("expected %s to have empty CompileCmd", lang)
		}
	}
}

func TestRegistryUnsupported(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("unsupported_lang")
	if err == nil {
		t.Fatalf("expected error for unsupported language, got nil")
	}
}

func TestRegistryListDetailed(t *testing.T) {
	r := NewRegistry()
	detailed := r.ListDetailed()
	if len(detailed) != 8 {
		t.Fatalf("expected 8 detailed configs, got %d", len(detailed))
	}
	ids := r.List()
	if len(ids) != 8 {
		t.Fatalf("expected 8 IDs, got %d", len(ids))
	}
}
