#!/usr/bin/env bash
# Build and push MIZI GPU Docker images to Docker Hub under gheeklabs/
# Usage: ./docker/build.sh [--push] [--tag cuda12.4|a100|h100|all]
#        ./docker/build.sh [--push] [--tag cuda12.4] [--vllm 0.19.0]
#        ./docker/build.sh [--platform linux/amd64] --push
set -e

REGISTRY="gheeklabs"
IMAGE_NAME="mizi-gpu"
PUSH=false
TARGET_TAG="all"
VLLM_VERSION="${VLLM_VERSION:-0.19.0}"
BUILD_PLATFORM="linux/amd64"

log() { echo "[build] $*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --push) PUSH=true ;;
        cuda12.4|a100|h100|all) TARGET_TAG="$1" ;;
        --vllm)
            shift
            VLLM_VERSION="$1"
            ;;
        --vllm=*) VLLM_VERSION="${1#--vllm=}" ;;
        --platform)
            shift
            BUILD_PLATFORM="$1"
            ;;
        --platform=*) BUILD_PLATFORM="${1#--platform=}" ;;
        *)
            echo "Usage: $0 [--push] [cuda12.4|a100|h100|all] [--vllm <version>] [--platform <platform>]"
            exit 1
            ;;
    esac
    shift
done

# Tag → (CUDA version, LLAMA_CUDA_ARCH). CUDA base is shared; arch selects which
# GPU family the wheel/compile targets. `all-major` = safest universal wheel.
build_image() {
    local tag="$1"
    local cuda_version="$2"
    local cuda_arch="$3"
    local full_image="${REGISTRY}/${IMAGE_NAME}:${tag}"

    local wheel_arg=""
    local wheel_path
    wheel_path="$(ls docker/vendor/vllm-*.whl 2>/dev/null | head -1 || true)"
    if [ -n "$wheel_path" ]; then
        wheel_arg="--build-arg VLLM_WHEEL=$(basename "$wheel_path")"
        log "Using vendored vLLM wheel: ${wheel_path}"
    fi

    log "Building ${full_image} (CUDA ${cuda_version}, arch: ${cuda_arch}, vLLM: ${VLLM_VERSION}, platform: ${BUILD_PLATFORM})..."
    docker build --platform "${BUILD_PLATFORM}" \
        --build-arg CUDA_VERSION="${cuda_version}" \
        --build-arg LLAMA_CUDA_ARCH="${cuda_arch}" \
        --build-arg VLLM_VERSION="${VLLM_VERSION}" \
        ${wheel_arg} \
        -t "${full_image}" \
        -f docker/Dockerfile.gpu \
        .

    if [ "$PUSH" = true ]; then
        log "Pushing ${full_image}..."
        docker push "${full_image}"
        log "Pushed ${full_image}"
    else
        log "Skipping push (pass --push to push to Docker Hub)"
    fi
}

case "$TARGET_TAG" in
    cuda12.4) build_image "cuda12.4" "12.4.1" "all-major" ;;
    a100)     build_image "a100"     "12.4.1" "80-real"   ;;
    h100)     build_image "h100"     "12.4.1" "90-real"   ;;
    all)
        build_image "cuda12.4" "12.4.1" "all-major"
        build_image "a100"     "12.4.1" "80-real"
        build_image "h100"     "12.4.1" "90-real"
        ;;
esac

log "Done."
