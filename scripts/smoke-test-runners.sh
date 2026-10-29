#!/usr/bin/env bash
set -euo pipefail

echo "==> Running runner image smoke tests..."

test_runner() {
  local lang="$1"
  local cmd="$2"
  local image="kairo-runner-${lang}:latest"
  echo "--> Smoke testing ${image}..."
  if ! docker run --rm "${image}" ${cmd} >/dev/null 2>&1; then
    echo "FAIL: Smoke test for ${image} failed!"
    exit 1
  fi
  echo "    PASS: ${image}"
}

test_runner "python" "python3 -c print('ok')"
test_runner "node" "node -e console.log('ok')"
test_runner "bash" "bash -c echo\ ok"
test_runner "c" "gcc --version"
test_runner "cpp" "g++ --version"
test_runner "go" "go version"
test_runner "rust" "rustc --version"
test_runner "java" "java -version"

echo "==> All runner image smoke tests passed successfully!"

