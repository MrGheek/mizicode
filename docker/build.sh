#!/usr/bin/env bash
# Build and push OmniQL Docker images to Docker Hub under gheeklabs/
# Usage: ./docker/build.sh [--push] [--tag cuda12.4|a100|h100|all]
set -e

REGISTRY="gheeklabs"
IMAGE_NAME="coding-env"
PUSH=false
TARGET_TAG="${1:-all}"

log() { echo "[build] $*"; }

build_and_push() {
    local tag="$1"
    local cuda_version="$2"
    local cuda_arch="$3"
    local full_image="${REGISTRY}/${IMAGE_NAME}:${tag}"

    log "Building ${full_image} (CUDA ${cuda_version}, arch: ${cuda_arch})..."
    docker build \
        --build-arg CUDA_VERSION="${cuda_version}" \
        --build-arg LLAMA_CUDA_ARCH="${cuda_arch}" \
        -t "${full_image}" \
        -f docker/Dockerfile \
        docker/

    if [ "$PUSH" = true ]; then
        log "Pushing ${full_image}..."
        docker push "${full_image}"
        log "Pushed ${full_image}"
    else
        log "Skipping push (pass --push to push to Docker Hub)"
    fi
}

for arg in "$@"; do
    case "$arg" in
        --push) PUSH=true ;;
    esac
done

case "$TARGET_TAG" in
    cuda12.4|"--push")
        build_and_push "cuda12.4" "12.4.0" "89"   # RTX 4090 (sm_89)
        ;;
    a100)
        build_and_push "a100" "12.4.0" "80"        # A100 (sm_80)
        ;;
    h100)
        build_and_push "h100" "12.4.0" "90"        # H100 (sm_90)
        ;;
    all)
        build_and_push "cuda12.4" "12.4.0" "89"
        build_and_push "a100" "12.4.0" "80"
        build_and_push "h100" "12.4.0" "90"
        ;;
    *)
        echo "Usage: $0 [--push] [cuda12.4|a100|h100|all]"
        exit 1
        ;;
esac

log "Done. To push: ./docker/build.sh --push all"
