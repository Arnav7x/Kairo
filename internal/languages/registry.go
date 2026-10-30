package languages

import (
	_ "embed"
	"fmt"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed languages.yaml
var defaultLanguagesYAML []byte

// Limits defines execution resource caps.
type Limits struct {
	TimeoutMS    int64 `json:"timeout_ms" yaml:"timeout_ms"`
	MemoryMB     int64 `json:"memory_mb" yaml:"memory_mb"`
	OutputBytes  int64 `json:"output_bytes" yaml:"output_bytes"`
	CPUNanoCores int64 `json:"cpu_nano_cores" yaml:"cpu_nano_cores"`
	PidsLimit    int64 `json:"pids_limit" yaml:"pids_limit"`
}

// LanguageConfig describes execution settings, container image, and defaults for a supported language.
type LanguageConfig struct {
	ID            string   `json:"id" yaml:"id"`
	Name          string   `json:"name" yaml:"name"`
	Image         string   `json:"image" yaml:"image"`
	Filename      string   `json:"filename" yaml:"filename"`
	Compiled      bool     `json:"compiled" yaml:"compiled"`
	Aliases       []string `json:"aliases,omitempty" yaml:"aliases,omitempty"`
	CompileCmd    []string `json:"compile_cmd,omitempty" yaml:"compile_cmd,omitempty"`
	RunCmd        []string `json:"run_cmd" yaml:"run_cmd"`
	DefaultLimits Limits   `json:"default_limits" yaml:"default_limits"`
	CompileLimits *Limits  `json:"compile_limits,omitempty" yaml:"compile_limits,omitempty"`
}

type languagesYAMLFile struct {
	Languages []LanguageConfig `yaml:"languages"`
}

// Registry stores language configurations and prevents dynamic user interpolation into image names or commands.
type Registry struct {
	mu        sync.RWMutex
	languages map[string]LanguageConfig
	aliases   map[string]string
	order     []string
}

// NewRegistry initializes the language registry from the embedded data-driven YAML definition.
func NewRegistry() *Registry {
	r, err := NewRegistryFromYAML(defaultLanguagesYAML)
	if err != nil {
		// Fallback to empty registry in the catastrophic case of invalid embedded YAML
		return &Registry{
			languages: make(map[string]LanguageConfig),
			aliases:   make(map[string]string),
		}
	}
	return r
}

// NewRegistryFromYAML parses a YAML configuration into a language Registry.
func NewRegistryFromYAML(data []byte) (*Registry, error) {
	var file languagesYAMLFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse languages yaml: %w", err)
	}

	r := &Registry{
		languages: make(map[string]LanguageConfig, len(file.Languages)),
		aliases:   make(map[string]string),
		order:     make([]string, 0, len(file.Languages)),
	}

	for _, lang := range file.Languages {
		r.Register(lang)
	}

	return r, nil
}

// Register adds or updates a language configuration and its aliases.
func (r *Registry) Register(cfg LanguageConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()

	normID := strings.ToLower(strings.TrimSpace(cfg.ID))
	if _, exists := r.languages[normID]; !exists {
		r.order = append(r.order, normID)
	}

	// Auto-detect compiled if compile_cmd is provided
	if len(cfg.CompileCmd) > 0 {
		cfg.Compiled = true
	}

	r.languages[normID] = cfg
	r.aliases[normID] = normID

	for _, alias := range cfg.Aliases {
		normAlias := strings.ToLower(strings.TrimSpace(alias))
		if normAlias != "" {
			r.aliases[normAlias] = normID
		}
	}
}

// Get returns the language configuration for a given language ID or alias.
func (r *Registry) Get(id string) (LanguageConfig, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	normalized := strings.ToLower(strings.TrimSpace(id))
	canonical, ok := r.aliases[normalized]
	if !ok {
		canonical = normalized
	}

	cfg, ok := r.languages[canonical]
	if !ok {
		return LanguageConfig{}, fmt.Errorf("unsupported language: %q", id)
	}
	return cfg, nil
}

// List returns all registered canonical language IDs.
func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ids := make([]string, len(r.order))
	copy(ids, r.order)
	return ids
}

// ListDetailed returns all registered language configurations in registration order.
func (r *Registry) ListDetailed() []LanguageConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()

	configs := make([]LanguageConfig, 0, len(r.order))
	for _, id := range r.order {
		if cfg, ok := r.languages[id]; ok {
			configs = append(configs, cfg)
		}
	}
	return configs
}
