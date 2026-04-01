#!/usr/bin/env bash
# Build and push OmniQL Docker images to Docker Hub under gheeklabs/
# Usage: ./docker/build.sh [--push] [--tag cuda12.4|a100|h100|all]
set -e

REGISTRY="gheeklabs"
IMAGE_NAME="coding-env"
PUSH=false
TARGET_TAG="all"

log() { echo "[build] $*"; }

for arg in "$@"; do
    case "$arg" in
        --push) PUSH=true ;;
        cuda12.4|a100|h100|all) TARGET_TAG="$arg" ;;
        *)
            echo "Usage: $0 [--push] [cuda12.4|a100|h100|all]"
            exit 1
            ;;
    esac
done

build_image() {
    local tag="$1"
    local full_image="${REGISTRY}/${IMAGE_NAME}:${tag}"

    log "Building ${full_image}..."
    docker build \
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

case "$TARGET_TAG" in
    cuda12.4) build_image "cuda12.4" ;;
    a100)     build_image "a100" ;;
    h100)     build_image "h100" ;;
    all)
        build_image "cuda12.4"
        build_image "a100"
        build_image "h100"
        ;;
esac

log "Done."
