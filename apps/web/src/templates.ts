export interface Starter {
  source: string;
  stdin?: string;
}

export const STARTERS: Record<string, Starter> = {
  python: {
    source: `import sys, time

print("Hello from Kairo :: Python", file=sys.stdout)
print("A warning to stderr", file=sys.stderr)
for i in range(1, 5):
    print(f"tick {i}")
    time.sleep(0.4)
`,
    stdin: "",
  },
  node: {
    source: `const { stdout, stderr } = await import("node:process");

stdout.write("Hello from Kairo :: Node.js\\n");
stderr.write("A warning to stderr\\n");
for (let i = 1; i <= 4; i++) {
  stdout.write(\`tick \${i}\\n\`);
  await new Promise((r) => setTimeout(r, 400));
}
`,
    stdin: "",
  },
  bash: {
    source: `#!/usr/bin/env bash
echo "Hello from Kairo :: Bash"
echo "A warning to stderr" >&2
for i in 1 2 3 4; do
  echo "tick $i"
  sleep 0.4
done
`,
    stdin: "",
  },
  c: {
    source: `#include <stdio.h>

int main(void) {
    printf("Hello from Kairo :: C\\n");
    fprintf(stderr, "A warning to stderr\\n");
    for (int i = 1; i <= 4; i++) {
        printf("tick %d\\n", i);
        fflush(stdout);
    }
    return 0;
}`,
    stdin: "",
  },
  cpp: {
    source: `#include <chrono>
#include <iostream>
#include <thread>

int main() {
    std::cout << "Hello from Kairo :: C++" << std::endl;
    std::cerr << "A warning to stderr" << std::endl;
    for (int i = 1; i <= 4; i++) {
        std::cout << "tick " << i << std::endl;
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
    }
    return 0;
}`,
    stdin: "",
  },
  go: {
    source: `package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	fmt.Println("Hello from Kairo :: Go")
	fmt.Fprintln(os.Stderr, "A warning to stderr")
	for i := 1; i <= 4; i++ {
		fmt.Println("tick", i)
		time.Sleep(400 * time.Millisecond)
	}
}`,
    stdin: "",
  },
  rust: {
    source: `fn main() {
    println!("Hello from Kairo :: Rust");
    eprintln!("A warning to stderr");
    for i in 1..=4 {
        println!("tick {}", i);
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}`,
    stdin: "",
  },
  java: {
    source: `public class main {
    public static void main(String[] args) throws Exception {
        System.out.println("Hello from Kairo :: Java");
        System.err.println("A warning to stderr");
        for (int i = 1; i <= 4; i++) {
            System.out.println("tick " + i);
            Thread.sleep(400);
        }
    }
}`,
    stdin: "",
  },
};

export const MONACO_LANGUAGE: Record<string, string> = {
  python: "python",
  node: "javascript",
  bash: "shell",
  c: "c",
  cpp: "cpp",
  go: "go",
  rust: "rust",
  java: "java",
};

export const LANGUAGE_LABEL: Record<string, string> = {
  python: "Python",
  node: "Node.js",
  bash: "Bash",
  c: "C",
  cpp: "C++",
  go: "Go",
  rust: "Rust",
  java: "Java",
};

export const LANGUAGE_ORDER = ["python", "cpp", "c", "go", "node", "rust", "java", "bash"];

export function labelFor(id: string): string {
  return LANGUAGE_LABEL[id] ?? id;
}

export function monacoFor(id: string): string {
  return MONACO_LANGUAGE[id] ?? "plaintext";
}
