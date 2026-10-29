#!/usr/bin/env bash
set -euo pipefail

echo "==> Building runner images..."

RUNNERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runners" && pwd)"
ROOT_DIR="$(cd "${RUNNERS_DIR}/.." && pwd)"
DIGESTS_FILE="${ROOT_DIR}/runner-digests.json"
DIGESTS_TMP="$(mktemp "${ROOT_DIR}/.runner-digests.XXXXXX")"
trap 'rm -f "${DIGESTS_TMP}"' EXIT

printf '{\n  "images": {\n' > "${DIGESTS_TMP}"
first=true

for lang_dir in "${RUNNERS_DIR}"/*; do
  if [ -d "${lang_dir}" ] && [ -f "${lang_dir}/Dockerfile" ]; then
    lang="$(basename "${lang_dir}")"
    image_tag="kairo-runner-${lang}:latest"
    echo "==> Building runner for ${lang} (${image_tag})..."
    docker build -t "${image_tag}" "${lang_dir}"
    digest="$(docker image inspect --format '{{.Id}}' "${image_tag}")"
    if [ "${first}" = true ]; then
      first=false
    else
      printf ',\n' >> "${DIGESTS_TMP}"
    fi
    printf '    "%s": { "tag": "%s", "digest": "%s" }' "${lang}" "${image_tag}" "${digest}" >> "${DIGESTS_TMP}"
  fi
done

printf '\n  }\n}\n' >> "${DIGESTS_TMP}"
mv "${DIGESTS_TMP}" "${DIGESTS_FILE}"
echo "==> Recorded image digests in ${DIGESTS_FILE}"

echo "==> Finished building runner images."
