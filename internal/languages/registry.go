package languages

import (
	"fmt"
)

// LanguageConfig describes execution settings, container image, and defaults for a supported language.
type LanguageConfig struct {
	ID            string
	Name          string
	Image         string
	Filename      string
	CompileCmd    []string
	RunCmd        []string
	DefaultLimits Limits
}

// Limits defines execution resource caps.
type Limits struct {
	TimeoutMS    int64
	MemoryMB     int64
	OutputBytes  int64
	CPUNanoCores int64
	PidsLimit    int64
}

// Registry stores language configurations and prevents dynamic user interpolation into image names or commands.
type Registry struct {
	languages map[string]LanguageConfig
}

// NewRegistry initializes the language registry with supported languages.
func NewRegistry() *Registry {
	r := &Registry{
		languages: make(map[string]LanguageConfig),
	}

	// Python runner specification
	r.Register(LanguageConfig{
		ID:         "python",
		Name:       "Python 3.12",
		Image:      "kairo-runner-python:latest",
		Filename:   "main.py",
		CompileCmd: nil, // Interpreted
		RunCmd:     []string{"python3", "main.py"},
		DefaultLimits: Limits{
			TimeoutMS:    10000,       // 10s default
			MemoryMB:     256,         // 256MB default
			OutputBytes:  1048576,     // 1MB default
			CPUNanoCores: 500_000_000, // 0.5 CPU default
			PidsLimit:    64,          // 64 processes
		},
	})

	return r
}

// Register adds a language configuration.
func (r *Registry) Register(cfg LanguageConfig) {
	r.languages[cfg.ID] = cfg
}

// Get returns the language configuration for a given language ID.
func (r *Registry) Get(id string) (LanguageConfig, error) {
	cfg, ok := r.languages[id]
	if !ok {
		return LanguageConfig{}, fmt.Errorf("unsupported language: %q", id)
	}
	return cfg, nil
}

// List returns all registered language IDs.
func (r *Registry) List() []string {
	ids := make([]string, 0, len(r.languages))
	for id := range r.languages {
		ids = append(ids, id)
	}
	return ids
}
