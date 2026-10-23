package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/docker/docker/client"
)

func main() {
	langFlag := flag.String("lang", "python", "Target programming language")
	timeoutFlag := flag.Int64("timeout", 10000, "Timeout in milliseconds")
	memFlag := flag.Int64("mem", 256, "Memory limit in MB")
	fileFlag := flag.String("file", "", "Path to code file (or pass inline via arg)")
	flag.Parse()

	var code string
	if *fileFlag != "" {
		data, err := os.ReadFile(*fileFlag)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading source file: %v\n", err)
			os.Exit(1)
		}
		code = string(data)
	} else if flag.NArg() > 0 {
		code = flag.Arg(0)
	} else {
		// Default hello world test
		code = "print('Hello from Kairo sandbox!')\n"
	}

	registry := languages.NewRegistry()
	langConfig, err := registry.Get(*langFlag)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	if os.Getenv("DOCKER_HOST") == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			userSock := os.ExpandEnv("$HOME/.docker/run/docker.sock")
			if _, sErr := os.Stat(userSock); sErr == nil {
				opts = append(opts, client.WithHost("unix://"+userSock))
			}
		}
	}

	dockerCli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to Docker: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		_ = dockerCli.Close()
	}()

	limits := langConfig.DefaultLimits
	limits.TimeoutMS = *timeoutFlag
	limits.MemoryMB = *memFlag

	executor := sandbox.NewDockerSandbox(dockerCli, "runc", "deploy/compose/seccomp.json")

	fmt.Printf("==> Executing code in sandbox [language=%s, timeout=%dms, memory=%dMB]...\n", *langFlag, limits.TimeoutMS, limits.MemoryMB)

	jobID := fmt.Sprintf("test-%d", time.Now().UnixNano())
	res, err := executor.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:      jobID,
		Language:   langConfig,
		SourceCode: code,
		Limits:     limits,
	})

	if err != nil {
		fmt.Fprintf(os.Stderr, "Execution failure: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("--- Sandbox Execution Result ---")
	fmt.Printf("Status:    %s\n", res.Status)
	fmt.Printf("Exit Code: %d\n", res.ExitCode)
	fmt.Printf("Duration:  %v\n", res.Duration)
	if res.ErrorMessage != "" {
		fmt.Printf("Error:     %s\n", res.ErrorMessage)
	}
	if res.Stdout != "" {
		fmt.Println("=== STDOUT ===")
		fmt.Print(res.Stdout)
	}
	if res.Stderr != "" {
		fmt.Println("=== STDERR ===")
		fmt.Print(res.Stderr)
	}
}
