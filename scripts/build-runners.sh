#!/usr/bin/env bash
set -euo pipefail

echo "==> Building runner images..."

RUNNERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runners" && pwd)"

for lang_dir in "${RUNNERS_DIR}"/*; do
  if [ -d "${lang_dir}" ] && [ -f "${lang_dir}/Dockerfile" ]; then
    lang="$(basename "${lang_dir}")"
    image_tag="kairo-runner-${lang}:latest"
    echo "==> Building runner for ${lang} (${image_tag})..."
    docker build -t "${image_tag}" "${lang_dir}"
  fi
done

echo "==> Finished building runner images."
