package languages

import (
	"testing"
)

func TestRegistryPython(t *testing.T) {
	r := NewRegistry()

	cfg, err := r.Get("python")
	if err != nil {
		t.Fatalf("expected python to be registered, got error: %v", err)
	}

	if cfg.Filename != "main.py" {
		t.Errorf("expected filename main.py, got %s", cfg.Filename)
	}
	if cfg.DefaultLimits.MemoryMB != 256 {
		t.Errorf("expected 256MB memory limit, got %d", cfg.DefaultLimits.MemoryMB)
	}
	if len(cfg.RunCmd) != 2 || cfg.RunCmd[0] != "python3" {
		t.Errorf("unexpected run command: %v", cfg.RunCmd)
	}
}

func TestRegistryUnsupported(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("unsupported_lang")
	if err == nil {
		t.Fatalf("expected error for unsupported language, got nil")
	}
}
